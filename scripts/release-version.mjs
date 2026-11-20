#!/usr/bin/env node
/**
 * Gestion du numéro de version de Dayali, qui doit rester identique dans trois fichiers :
 * `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml` (+ `Cargo.lock`).
 *
 *   node scripts/release-version.mjs bump 0.2.0     met les fichiers à jour
 *   node scripts/release-version.mjs check [v0.2.0] vérifie la cohérence (et le tag, si fourni)
 *
 * L'updater compare la version de l'app installée à celle de la release GitHub : si elles
 * divergent, les mises à jour ne sont jamais proposées (ou le sont en boucle).
 */
import { readFileSync, writeFileSync } from "node:fs";

const PACKAGE_JSON = "package.json";
const TAURI_CONF = "src-tauri/tauri.conf.json";
const CARGO_TOML = "src-tauri/Cargo.toml";
const CARGO_LOCK = "src-tauri/Cargo.lock";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function read(path) {
  return readFileSync(path, "utf8");
}

function currentVersions() {
  return {
    [PACKAGE_JSON]: JSON.parse(read(PACKAGE_JSON)).version,
    [TAURI_CONF]: JSON.parse(read(TAURI_CONF)).version,
    [CARGO_TOML]: /^version\s*=\s*"([^"]+)"/m.exec(read(CARGO_TOML))?.[1],
  };
}

function replaceOnce(path, pattern, replacement) {
  const source = read(path);
  if (!pattern.test(source)) throw new Error(`Version introuvable dans ${path}`);
  writeFileSync(path, source.replace(pattern, replacement));
}

function bump(version) {
  if (!version || !SEMVER.test(version)) {
    throw new Error(`Version invalide : « ${version ?? ""} » (attendu : 1.2.3 ou 1.2.3-beta.1)`);
  }
  replaceOnce(PACKAGE_JSON, /("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  replaceOnce(TAURI_CONF, /("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  replaceOnce(CARGO_TOML, /^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
  replaceOnce(CARGO_LOCK, /(name = "dayali"\nversion = ")[^"]+(")/, `$1${version}$2`);
  console.log(`Version portée à ${version} dans ${PACKAGE_JSON}, ${TAURI_CONF}, ${CARGO_TOML} et ${CARGO_LOCK}.`);
}

function check(tag) {
  const versions = currentVersions();
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1 || distinct.has(undefined)) {
    const detail = Object.entries(versions)
      .map(([file, version]) => `  ${file} : ${version}`)
      .join("\n");
    throw new Error(`Versions incohérentes :\n${detail}\nLancez « pnpm release:bump <version> ».`);
  }
  const [version] = distinct;
  if (tag && tag.replace(/^v/, "") !== version) {
    throw new Error(
      `Le tag « ${tag} » ne correspond pas à la version de l'app (${version}). ` +
        `Lancez « pnpm release:bump ${tag.replace(/^v/, "")} », commitez, puis recréez le tag.`,
    );
  }
  console.log(`Version ${version} cohérente${tag ? ` avec le tag ${tag}` : ""}.`);
}

try {
  const [command, argument] = process.argv.slice(2);
  if (command === "bump") bump(argument);
  else if (command === "check") check(argument);
  else throw new Error("Usage : release-version.mjs bump <version> | check [tag]");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
