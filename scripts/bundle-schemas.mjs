#!/usr/bin/env node
/**
 * Dayali — étape 0 de la chaîne de génération (PLAN §1.8).
 *
 * Résout les $ref inter-fichiers des schémas de `docs/schemas/` et écrit un
 * schéma autonome par schéma dans `.cache/schemas/bundled/` (ignoré par git).
 *
 * Règles :
 *  - mapping unique `https://schemas.dayali.app/<nom>.schema.json` → `docs/schemas/<nom>.schema.json` ;
 *  - `<nom>` ne contient ni `/`, ni `\`, ni `..`, et le fichier doit exister ;
 *  - les `$ref` internes (`#/$defs/...`) sont conservés mais préfixés quand la
 *    définition vient d'un autre fichier (`#/$defs/<stem>__<nom>`) ;
 *  - tout autre `$ref` absolu est une erreur bloquante (aucun réseau, aucun fallback) ;
 *  - sortie déterministe : `$defs` triés, JSON 2 espaces, LF, saut de ligne final.
 *
 * Aucune dépendance npm : l'implémentation est volontairement minimale et
 * vérifiable hors ligne. `scripts/generate-contracts.mjs` réutilise
 * `bundleSchema()`.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = path.join(ROOT, "docs", "schemas");
export const BUNDLED_DIR = path.join(ROOT, ".cache", "schemas", "bundled");

/** Périmètre de génération de l'étape (a) — PLAN §1.8. */
export const STAGE_A_SCHEMAS = ["common", "machine-local", "config", "machine"];

const ID_PREFIX = "https://schemas.dayali.app/";
const SCHEMA_SUFFIX = ".schema.json";

/** Erreur bloquante du bundler : jamais de fallback silencieux. */
export class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "BundleError";
  }
}

function assertSchemaName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new BundleError("nom de schéma vide");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new BundleError(`nom de schéma interdit : ${JSON.stringify(name)}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new BundleError(`nom de schéma non canonique : ${JSON.stringify(name)}`);
  }
}

function decodePointerToken(token) {
  return decodeURIComponent(token).replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Résout un fragment JSON Pointer (`#`, `#/$defs/x`) dans un document. */
function resolveFragment(document, fragment) {
  if (fragment === "" || fragment === "#") return document;
  if (!fragment.startsWith("#/")) {
    throw new BundleError(`fragment non supporté : ${fragment}`);
  }
  const tokens = fragment.slice(2).split("/").map(decodePointerToken);
  let current = document;
  for (const token of tokens) {
    if (current === null || typeof current !== "object" || !(token in current)) {
      throw new BundleError(`fragment introuvable : ${fragment} (segment ${token})`);
    }
    current = current[token];
  }
  return current;
}

const schemaCache = new Map();

async function loadSchema(name) {
  assertSchemaName(name);
  if (schemaCache.has(name)) return schemaCache.get(name);
  const file = path.join(SCHEMA_DIR, `${name}${SCHEMA_SUFFIX}`);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new BundleError(`schéma introuvable : docs/schemas/${name}${SCHEMA_SUFFIX} (${error.code ?? error.message})`);
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new BundleError(`JSON invalide dans docs/schemas/${name}${SCHEMA_SUFFIX} : ${error.message}`);
  }
  const expectedId = `${ID_PREFIX}${name}${SCHEMA_SUFFIX}`;
  if (document.$id !== expectedId) {
    throw new BundleError(
      `$id incohérent dans docs/schemas/${name}${SCHEMA_SUFFIX} : attendu ${expectedId}, trouvé ${JSON.stringify(document.$id)}`,
    );
  }
  schemaCache.set(name, { name, document });
  return { name, document };
}

/** Découpe `https://schemas.dayali.app/x.schema.json#/$defs/y` en (nom, fragment). */
function parseRef(ref) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new BundleError("$ref vide ou non textuel");
  }
  if (ref.startsWith("#")) return { local: true, fragment: ref };
  if (!ref.startsWith(ID_PREFIX)) {
    throw new BundleError(
      `$ref absolu non autorisé : ${ref} — seuls les identifiants ${ID_PREFIX}<nom>${SCHEMA_SUFFIX} sont admis (aucun téléchargement)`,
    );
  }
  const rest = ref.slice(ID_PREFIX.length);
  const hashIndex = rest.indexOf("#");
  const filePart = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : rest.slice(hashIndex);
  if (!filePart.endsWith(SCHEMA_SUFFIX)) {
    throw new BundleError(`$ref vers un fichier non-schéma : ${ref}`);
  }
  const name = filePart.slice(0, -SCHEMA_SUFFIX.length);
  assertSchemaName(name);
  return { local: false, name, fragment };
}

function aliasFor(name, definitionKey) {
  const safe = definitionKey.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${name.replace(/-/g, "_")}__${safe || "def"}`;
}

async function cloneDefinition(name, fragment, ctx) {
  const identity = `${name}#${fragment}`;
  if (ctx.inProgress.has(identity)) {
    throw new BundleError(`cycle de $ref détecté : ${identity}`);
  }
  if (ctx.aliases.has(identity)) return ctx.aliases.get(identity);

  const { document } = await loadSchema(name);
  const target = resolveFragment(document, fragment);
  const definitionKey = fragment.startsWith("#/$defs/")
    ? fragment.slice("#/$defs/".length).split("/").map(decodePointerToken).join("__")
    : fragment.replace(/[^A-Za-z0-9]+/g, "_");
  const alias = aliasFor(name, definitionKey);
  ctx.aliases.set(identity, alias);
  ctx.inProgress.add(identity);

  ctx.defs[alias] = await rewriteNode(structuredClone(target), name, ctx);

  ctx.inProgress.delete(identity);
  return alias;
}

async function rewriteNode(node, owningSchema, ctx) {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      node[index] = await rewriteNode(node[index], owningSchema, ctx);
    }
    return node;
  }
  if (node === null || typeof node !== "object") return node;

  if (typeof node.$ref === "string") {
    const parsed = parseRef(node.$ref);
    if (parsed.local) {
      if (parsed.fragment === "#" || parsed.fragment === "") {
        throw new BundleError(`$ref racine local interdit dans ${owningSchema}: ${node.$ref}`);
      }
      const alias = await cloneDefinition(owningSchema, parsed.fragment, ctx);
      node.$ref = `#/$defs/${alias}`;
    } else {
      const alias = await cloneDefinition(parsed.name, parsed.fragment, ctx);
      node.$ref = `#/$defs/${alias}`;
    }
    for (const key of Object.keys(node)) {
      if (key === "$ref" || key === "description" || key === "$comment") continue;
      node[key] = await rewriteNode(node[key], owningSchema, ctx);
    }
    return node;
  }

  for (const key of Object.keys(node)) {
    if (key === "description" || key === "$comment") continue;
    node[key] = await rewriteNode(node[key], owningSchema, ctx);
  }
  return node;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
  return out;
}

function assertNoAbsoluteRefs(node, where) {
  if (Array.isArray(node)) {
    node.forEach((item) => assertNoAbsoluteRefs(item, where));
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
    throw new BundleError(`$ref absolu restant dans le bundle ${where} : ${node.$ref}`);
  }
  for (const value of Object.values(node)) assertNoAbsoluteRefs(value, where);
}

/**
 * Produit le schéma autonome d'un schéma de `docs/schemas/`.
 * @param {string} name nom sans `.schema.json`
 * @returns {Promise<object>}
 */
export async function bundleSchema(name) {
  assertSchemaName(name);
  const { document } = await loadSchema(name);
  const ctx = { defs: {}, aliases: new Map(), inProgress: new Set() };

  const root = structuredClone(document);
  const ownDefs = root.$defs ?? {};
  delete root.$defs;

  const rewritten = await rewriteNode(root, name, ctx);

  for (const [key, definition] of Object.entries(ownDefs)) {
    const alias = aliasFor(name, key);
    ctx.aliases.set(`${name}#/$defs/${key}`, alias);
    ctx.defs[alias] = await rewriteNode(structuredClone(definition), name, ctx);
  }

  const bundled = { ...rewritten };
  const defs = sortKeysDeep(ctx.defs);
  if (Object.keys(defs).length > 0) bundled.$defs = defs;

  assertNoAbsoluteRefs(bundled, name);
  return bundled;
}

export function serializeSchema(schema) {
  return `${JSON.stringify(sortKeysDeep(schema), null, 2)}\n`;
}

export async function bundleAll(names = STAGE_A_SCHEMAS) {
  const results = new Map();
  for (const name of names) {
    results.set(name, await bundleSchema(name));
  }
  return results;
}

async function main(argv) {
  const all = argv.includes("--all");
  const names = all ? (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith(SCHEMA_SUFFIX)).map((f) => f.slice(0, -SCHEMA_SUFFIX.length)).sort() : STAGE_A_SCHEMAS;
  const bundled = await bundleAll(names);
  await mkdir(BUNDLED_DIR, { recursive: true });
  for (const [name, schema] of bundled) {
    const out = path.join(BUNDLED_DIR, `${name}${SCHEMA_SUFFIX}`);
    await writeFile(out, serializeSchema(schema), "utf8");
    process.stdout.write(`bundle ${name} → ${path.relative(ROOT, out)}\n`);
  }
  process.stdout.write(`${bundled.size} schéma(s) bundlé(s) dans .cache/schemas/bundled/\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`bundling échoué : ${error.message}\n`);
    process.exitCode = 1;
  });
}
