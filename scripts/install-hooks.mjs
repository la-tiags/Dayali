#!/usr/bin/env node
// Installe les hooks git versionnés de `.githooks/`.
//
// Appelé par le script `prepare` de package.json (donc par `pnpm install`).
// Ne fait jamais échouer une installation : hors dépôt git, dans un tarball ou
// sans git disponible, le script sort en 0 avec un message d'information.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hooksDir = join(root, ".githooks");
const hook = join(hooksDir, "pre-commit");

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

try {
  if (!existsSync(hook)) {
    console.log("install-hooks : .githooks/pre-commit absent, rien à faire.");
    process.exit(0);
  }
  // Le bit exécutable ne survit pas toujours à un checkout (Windows, zip).
  try {
    chmodSync(hook, 0o755);
  } catch {
    // Sans effet sur Windows : git exécute le hook via sh.
  }
  git(["rev-parse", "--is-inside-work-tree"]);
  git(["config", "core.hooksPath", ".githooks"]);
  console.log("install-hooks : core.hooksPath = .githooks");
} catch {
  console.log("install-hooks : dépôt git indisponible, hooks non installés.");
}
