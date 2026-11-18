#!/usr/bin/env node
/**
 * Dayali — génération des contrats (PLAN §1.8).
 *
 * Chaîne : `bundle-schemas.mjs` résout les `$ref` inter-fichiers, puis
 * `json-schema-to-zod` produit les modules Zod de `src/lib/schemas/generated/`.
 * Les types Rust sont produits par `cargo typify` dans
 * `src-tauri/src/models/generated.rs`.
 *
 * Périmètre de l'étape (a) : `common`, `machine-local`, `config`, `machine`.
 *
 * Options :
 *   --check     ne rien écrire ; échoue si un fichier généré diverge ;
 *   --ts-only   ne génère que les contrats Zod (Rust laissé à une machine
 *               disposant de la toolchain et de `cargo-typify`) ;
 *   --help      affiche cette aide.
 *
 * Aucun réseau : les schémas sont lus dans `docs/schemas/`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { jsonSchemaToZod } from "json-schema-to-zod";

import {
  BUNDLED_DIR,
  ROOT,
  SCHEMA_DIR,
  STAGE_A_SCHEMAS,
  bundleSchema,
  serializeSchema,
} from "./bundle-schemas.mjs";

export const GENERATED_TS_DIR = path.join(ROOT, "src", "lib", "schemas", "generated");
export const GENERATED_RUST_PATH = path.join(ROOT, "src-tauri", "src", "models", "generated.rs");

/** Schémas avec un objet racine (common est un module de définitions). */
const OBJECT_SCHEMAS = ["config", "machine", "machine-local"];

const TS_TARGETS = {
  config: { file: "config.ts", exportName: "configSchema", typeName: "Config" },
  machine: { file: "machine.ts", exportName: "machineSchema", typeName: "MachineFile" },
  "machine-local": {
    file: "machine-local.ts",
    exportName: "machineLocalSchema",
    typeName: "MachineLocal",
  },
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function decodePointerToken(token) {
  return decodeURIComponent(token).replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointer(document, ref) {
  if (ref === "#") return document;
  if (!ref.startsWith("#/")) {
    throw new Error(`$ref non local dans un schéma déjà bundlé : ${ref}`);
  }
  const tokens = ref.slice(2).split("/").map(decodePointerToken);
  let current = document;
  for (const token of tokens) {
    if (current === null || typeof current !== "object" || !(token in current)) {
      throw new Error(`$ref introuvable : ${ref} (segment ${token})`);
    }
    current = current[token];
  }
  return current;
}

/**
 * Inline récursivement les `$ref` internes. Les schémas de l'étape (a) n'ont pas
 * de cycle ; un cycle serait une erreur bloquante plutôt qu'un `z.any()` muet.
 */
function inlineRefs(node, root, stack = []) {
  if (Array.isArray(node)) {
    return node.map((item) => inlineRefs(item, root, stack));
  }
  if (node === null || typeof node !== "object") return node;

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (stack.includes(ref)) {
      throw new Error(`cycle de $ref détecté : ${[...stack, ref].join(" → ")}`);
    }
    const target = resolvePointer(root, ref);
    return inlineRefs(structuredClone(target), root, [...stack, ref]);
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs" || key === "$schema" || key === "$id" || key === "$comment") continue;
    out[key] = inlineRefs(value, root, stack);
  }
  return out;
}

function isNullBranch(node) {
  return (
    node !== null &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    node.type === "null" &&
    Object.keys(node).every((key) => key === "type" || key === "description" || key === "$comment")
  );
}

/** `oneOf: [T, null]` devient `anyOf` : même sens, meilleur type Zod. */
function normalizeNullableOneOf(node) {
  if (Array.isArray(node)) return node.map(normalizeNullableOneOf);
  if (node === null || typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = normalizeNullableOneOf(value);
  }
  if (
    Array.isArray(out.oneOf) &&
    out.oneOf.length === 2 &&
    out.oneOf.some(isNullBranch)
  ) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  return out;
}


/**
 * Convertit `type: [T, "null"]` en `anyOf: [T, null]` avec le `default` gardé
 * au niveau externe. Sans cela, `json-schema-to-zod` recopie le `default` sur
 * chaque branche de l'union, ce qui produit des `.default(...)` invalides sur
 * `z.null()` / `z.number()` (Zod 4).
 */
function normalizeTypeArrays(node) {
  if (Array.isArray(node)) return node.map(normalizeTypeArrays);
  if (node === null || typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = normalizeTypeArrays(value);
  }

  if (Array.isArray(out.type) && out.type.length === 2 && out.type.includes("null")) {
    const nonNullType = out.type.find((entry) => entry !== "null");
    const { type: _type, default: defaultValue, ...rest } = out;
    const branch = { type: nonNullType, ...rest };
    delete branch.default;
    const normalized = {
      anyOf: [branch, { type: "null" }],
    };
    if (typeof out.description === "string") normalized.description = out.description;
    if (defaultValue !== undefined) normalized.default = defaultValue;
    // Conserver les autres clés de niveau supérieur non déjà copiées.
    for (const key of Object.keys(out)) {
      if (key === "type" || key === "default" || key === "description") continue;
      if (!(key in normalized)) normalized[key] = out[key];
    }
    return normalized;
  }
  return out;
}

/**
 * Retire les raffinements conditionnels `if/then/else`.
 *
 * `json-schema-to-zod` les traduit en `superRefine` fragiles et non typés.
 * Ajv les valide côté schéma, les `validate()` Rust font autorité à l'IPC ; le
 * module généré reste le contrat structurel.
 */
function stripConditionals(node) {
  if (Array.isArray(node)) return node.map(stripConditionals);
  if (node === null || typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "if" || key === "then" || key === "else") continue;
    out[key] = stripConditionals(value);
  }

  if (Array.isArray(out.allOf)) {
    out.allOf = out.allOf.filter(
      (entry) =>
        !(
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          Object.keys(entry).length === 0
        ),
    );
    if (out.allOf.length === 0) delete out.allOf;
  }
  return out;
}

/**
 * `not: { pattern: P }` n'a pas de type explicite dans `common.relativePath`.
 * `json-schema-to-zod` le transforme alors en `z.any()` et refuse tout. On le
 * réécrit en motif positif équivalent : « aucun sous-texte ne matche P ».
 */
function normalizeNotPatterns(node) {
  if (Array.isArray(node)) return node.map(normalizeNotPatterns);
  if (node === null || typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = normalizeNotPatterns(value);
  }

  if (Array.isArray(out.allOf)) {
    out.allOf = out.allOf.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const significant = Object.keys(entry).filter(
        (key) => key !== "description" && key !== "$comment",
      );
      if (
        significant.length === 1 &&
        significant[0] === "not" &&
        entry.not !== null &&
        typeof entry.not === "object" &&
        typeof entry.not.pattern === "string"
      ) {
        const replacement = {
          type: "string",
          pattern: `^(?![\\s\\S]*?(?:${entry.not.pattern}))`,
        };
        if (typeof entry.description === "string") replacement.description = entry.description;
        return replacement;
      }
      return entry;
    });
  }
  return out;
}

/**
 * Propage le `type` du parent aux entrées `allOf` qui n'en ont pas. Sans cela,
 * `{ pattern: ... }` seul devient `z.any()` et l'intersection ne valide rien.
 */
function propagateAllOfType(node) {
  if (Array.isArray(node)) return node.map(propagateAllOfType);
  if (node === null || typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = propagateAllOfType(value);
  }

  if (typeof out.type === "string" && Array.isArray(out.allOf)) {
    out.allOf = out.allOf.map((entry) => {
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        entry.type === undefined
      ) {
        return { type: out.type, ...entry };
      }
      return entry;
    });
  }
  return out;
}

function prepareNode(node, root, stack = []) {
  return propagateAllOfType(
    normalizeNotPatterns(
      stripConditionals(
        normalizeTypeArrays(normalizeNullableOneOf(inlineRefs(node, root, stack))),
      ),
    ),
  );
}

function header(sourceName, sourceText) {
  return [
    "// GENERATED FILE — DO NOT EDIT.",
    `// Source: docs/schemas/${sourceName}.schema.json`,
    `// Source-SHA256: ${sha256(sourceText)}`,
    "// Generator: scripts/generate-contracts.mjs (json-schema-to-zod)",
    "//",
    "// Les raffinements if/then/else sont validés par Ajv et par les validateurs",
    "// Rust ; ce module est le contrat structurel de la frontière IPC.",
  ].join("\n");
}

/**
 * `json-schema-to-zod` émet `new RegExp("...")`, que Biome refuse
 * (`useRegexLiterals`). On convertit en littéral en décodant la chaîne JS, sans
 * `eval`, pour garder un lint propre et un code généré identique.
 */
function preferRegexLiterals(code) {
  return code.replace(
    /new RegExp\(("(?:[^"\\]|\\.)*")(?:\s*,\s*("(?:[^"\\]|\\.)*"))?\)/g,
    (_match, sourceLiteral, flagsLiteral) => {
      const source = JSON.parse(sourceLiteral)
        .replace(/\//g, "\\/")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r");
      const flags = flagsLiteral ? JSON.parse(flagsLiteral) : "";
      return `/${source}/${flags}`;
    },
  );
}

/** `uniqueItems` est émis avec `==` ; Biome exige `===`. */
function preferStrictEquality(code) {
  return code.replace("arr.indexOf(item) == i", "arr.indexOf(item) === i");
}


/** Zod 4 exige une clé pour `z.record` ; on rétablit la clé string. */
function fixRecordCalls(code) {
  return code.replace(/z\.record\(z\.any\(\)\)/g, "z.record(z.string(), z.any())");
}

function toExport(code, identifier) {
  const prefix = `const ${identifier} = `;
  if (!code.startsWith(prefix)) {
    throw new Error(`sortie json-schema-to-zod inattendue pour ${identifier}`);
  }
  return `export const ${identifier} = ${code.slice(prefix.length)};`;
}

function biomeBin() {
  const name = process.platform === "win32" ? "biome.cmd" : "biome";
  return path.join(ROOT, "node_modules", ".bin", name);
}

function formatTypeScript(filePath, text) {
  try {
    return execFileSync(
      biomeBin(),
      ["format", "--stdin-file-path", path.relative(ROOT, filePath)],
      { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (error) {
    const detail = error.stderr?.toString?.() || error.message;
    throw new Error(`biome format a échoué pour ${path.relative(ROOT, filePath)} : ${detail}`);
  }
}

async function renderCommon() {
  const file = path.join(SCHEMA_DIR, "common.schema.json");
  const sourceText = await readFile(file, "utf8");
  const document = JSON.parse(sourceText);
  const defs = document.$defs ?? {};

  const parts = [];
  for (const [key, definition] of Object.entries(defs)) {
    const identifier = `${key}Schema`;
    const prepared = prepareNode(definition, document, [`#/$defs/${key}`]);
    const code = fixRecordCalls(
      preferStrictEquality(
        preferRegexLiterals(
          jsonSchemaToZod(prepared, {
            module: "none",
            name: identifier,
            withJsdocs: false,
            zodVersion: 4,
          }),
        ),
      ),
    );
    parts.push(toExport(code, identifier));
    const typeName = key.charAt(0).toUpperCase() + key.slice(1);
    parts.push(`export type ${typeName} = z.infer<typeof ${identifier}>;`);
  }

  return `${header("common", sourceText)}\n\nimport { z } from "zod";\n\n${parts.join("\n\n")}\n`;
}

async function renderSchema(name, prepared, sourceText) {
  const target = TS_TARGETS[name];
  if (!target) throw new Error(`schéma sans cible TypeScript : ${name}`);

  const code = fixRecordCalls(
    preferStrictEquality(
      preferRegexLiterals(
        jsonSchemaToZod(prepared, {
          module: "none",
          name: target.exportName,
          withJsdocs: false,
          zodVersion: 4,
        }),
      ),
    ),
  );

  return [
    header(name, sourceText),
    "",
    'import { z } from "zod";',
    "",
    toExport(code, target.exportName),
    "",
    `export type ${target.typeName} = z.infer<typeof ${target.exportName}>;`,
    "",
  ].join("\n");
}

function renderIndex() {
  return [
    "// GENERATED FILE — DO NOT EDIT.",
    "// Sources: docs/schemas/{common,machine-local,config,machine}.schema.json",
    "// Generator: scripts/generate-contracts.mjs",
    "",
    'export * from "./common";',
    'export * from "./config";',
    'export * from "./machine";',
    'export * from "./machine-local";',
    "",
  ].join("\n");
}

async function prepareBundled(name) {
  const bundled = await bundleSchema(name);
  return prepareNode(bundled, bundled);
}

function rustHeader() {
  return [
    "//! GENERATED FILE — DO NOT EDIT.",
    "//!",
    "//! Sources: docs/schemas/{config,machine,machine-local}.schema.json,",
    "//! `common` inliné. Générateur : `scripts/generate-contracts.mjs` via",
    "//! `cargo typify` (cargo-typify). Régénérer avec `pnpm generate:contracts` ;",
    "//! `pnpm generate:contracts -- --check` échoue en cas de dérive.",
    "//!",
    "//! `common` n'a pas d'objet racine : ses définitions sont inlinées dans les",
    "//! trois modules ci-dessous, ce qui évite des ré-exports Rust fragiles.",
  ].join("\n");
}

function indent(text, spaces) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : pad + line))
    .join("\n");
}

/**
 * Ajoute `deny_unknown_fields` (et `rename_all = "camelCase"` si absent) aux
 * structs produits par typify. Serde accepte plusieurs attributs `#[serde]`.
 */
function annotateStructs(code) {
  const lines = code.split("\n");
  const out = [];
  for (const line of lines) {
    if (/^pub struct\b/.test(line)) {
      let start = out.length;
      while (start > 0 && /^#\[/.test(out[start - 1])) start -= 1;
      const attributes = out.slice(start).join("\n");
      if (!attributes.includes("deny_unknown_fields")) {
        out.splice(start, 0, "#[serde(deny_unknown_fields)]");
      }
      if (!attributes.includes("rename_all")) {
        out.splice(start, 0, '#[serde(rename_all = "camelCase")]');
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function cargoBin() {
  return process.env.CARGO || "cargo";
}

function assertTypifyAvailable() {
  try {
    execFileSync(cargoBin(), ["typify", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "génération Rust impossible : `cargo typify` est absent. " +
        "Installe cargo-typify (`cargo install cargo-typify`) ou utilise `--ts-only`.",
    );
  }
}

async function renderRust(bundled, workDir) {
  assertTypifyAvailable();
  await mkdir(BUNDLED_DIR, { recursive: true });

  const modules = [];
  for (const name of OBJECT_SCHEMAS) {
    const schema = bundled.get(name);
    if (!schema) throw new Error(`schéma bundlé manquant : ${name}`);

    const bundledPath = path.join(BUNDLED_DIR, `${name}.schema.json`);
    await writeFile(bundledPath, serializeSchema(schema), "utf8");

    const outputPath = path.join(workDir, `${name}.rs`);
    execFileSync(cargoBin(), ["typify", bundledPath, "--output", outputPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const generated = annotateStructs((await readFile(outputPath, "utf8")).trimEnd());
    const moduleName = name.replace(/-/g, "_");
    modules.push(`pub mod ${moduleName} {\n${indent(generated, 4)}\n}`);
  }

  return `${rustHeader()}\n\n${modules.join("\n\n")}\n`;
}

async function syncOutputs(outputs, check) {
  const stale = [];
  for (const [filePath, content] of outputs) {
    let existing = null;
    try {
      existing = await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing === content) continue;
    if (check) {
      stale.push(path.relative(ROOT, filePath));
      continue;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  return stale;
}

const HELP = `Usage: node scripts/generate-contracts.mjs [--check] [--ts-only]

  --check    vérifie que les fichiers générés sont à jour, sans écrire
  --ts-only  génère uniquement les contrats Zod (nécessite node_modules)
  --help     affiche cette aide

La génération Rust complète exige cargo-typify :
  cargo install cargo-typify
`;

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const check = argv.includes("--check");
  const tsOnly = argv.includes("--ts-only");
  const isKnown = new Set(["--check", "--ts-only", "--help", "-h"]);
  const unknown = argv.filter((argument) => !isKnown.has(argument));
  if (unknown.length > 0) {
    throw new Error(`option inconnue : ${unknown.join(", ")}\n\n${HELP}`);
  }

  const prepared = new Map();
  const bundled = new Map();
  const sources = new Map();
  for (const name of STAGE_A_SCHEMAS) {
    const sourceText = await readFile(path.join(SCHEMA_DIR, `${name}.schema.json`), "utf8");
    sources.set(name, sourceText);
    if (OBJECT_SCHEMAS.includes(name)) {
      const schema = await prepareBundled(name);
      prepared.set(name, schema);
      bundled.set(name, await bundleSchema(name));
    }
  }

  const outputs = new Map();
  outputs.set(path.join(GENERATED_TS_DIR, "common.ts"), await renderCommon());
  for (const name of OBJECT_SCHEMAS) {
    const text = await renderSchema(name, prepared.get(name), sources.get(name));
    outputs.set(path.join(GENERATED_TS_DIR, TS_TARGETS[name].file), text);
  }
  outputs.set(path.join(GENERATED_TS_DIR, "index.ts"), renderIndex());

  const formatted = new Map();
  for (const [filePath, text] of outputs) {
    formatted.set(filePath, formatTypeScript(filePath, text));
  }

  if (!tsOnly) {
    await mkdir(path.join(ROOT, ".cache"), { recursive: true });
    const workDir = await mkdtemp(path.join(ROOT, ".cache", "contracts-"));
    try {
      const rust = await renderRust(bundled, workDir);
      formatted.set(GENERATED_RUST_PATH, rust);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const stale = await syncOutputs(formatted, check);
  if (check) {
    if (stale.length > 0) {
      throw new Error(
        `contrats non à jour (${stale.length}) :\n  ${stale.join("\n  ")}\n` +
          "Relance `pnpm generate:contracts` et commit le résultat.",
      );
    }
    process.stdout.write(`contrats à jour (${formatted.size} fichiers)\n`);
    return;
  }

  const mode = tsOnly ? "Zod uniquement (--ts-only)" : "Zod + Rust";
  process.stdout.write(`${formatted.size} fichier(s) généré(s) — ${mode}\n`);
  if (tsOnly) {
    process.stdout.write(
      "Rust non régénéré : exécute `pnpm generate:contracts` sur une machine avec cargo-typify.\n",
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`génération des contrats échouée : ${error.message}\n`);
    process.exitCode = 1;
  });
}
