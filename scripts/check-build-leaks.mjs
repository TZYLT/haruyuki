#!/usr/bin/env node
/**
 * Guard against build-machine leakage in the published package.
 *
 * Why this exists
 * ---------------
 * `bun run build` bundles CommonJS dependencies through Bun's `__commonJS`
 * wrapper, which inlines `__dirname`/`__filename` as the BUILD MACHINE's
 * absolute path. `typescript` is inlined (the mod engine transpiles mods with
 * `ts.transpileModule`), so `haruyuki@0.2.0` shipped:
 *
 *   var __dirname = "<machine>/node_modules/typescript/lib", ...
 *
 * `build.js` now scrubs the build root out of every emitted artifact. This script
 * is the second layer: it reads exactly the files `npm pack` would publish and
 * refuses any machine-identity string that survived.
 *
 * Scope — deliberately narrow
 * ---------------------------
 * Only MACHINE IDENTITY is matched:
 *   1. the releasing machine's repository root (and its escaped / forward-slash forms);
 *   2. a Windows user home (`<letter>:\Users\...`, `...\Documents and Settings\...`);
 *   3. an absolute Windows path that descends into `node_modules`;
 *   4. a PATH that names local state which must never be published (`.haruyuki`,
 *      `settings.local.json`, `.env*`, `node_modules`, `local-ops`).
 *
 * (4) exists because `files: ["scripts", ...]` whitelists whole directories, and
 * `files` is authoritative over `.gitignore`: any ignored local file dropped
 * under a whitelisted directory is packed. A `scripts/.haruyuki/settings.local.json`
 * carrying the maintainer's home path and local agent/conversation ids was in the
 * pack list, and would have shipped.
 *
 * Absolute paths that are part of the PRODUCT are intentionally NOT matched —
 * `C:\Program Files\...` launcher fallbacks, `C:\Windows`, the Windows shell
 * registry key, `C:\src\...` in an error message, and `/Users/name` style
 * examples inside docs and `.d.ts` files all ship today. A generic "any absolute
 * path" or "any /home/<name>" rule would fail on those, and an allowlist would
 * rot. Matching identity only keeps this check zero-false-positive.
 *
 * Usage
 * -----
 *   node scripts/check-build-leaks.mjs            # pack list via `npm pack --dry-run --json`
 *   node scripts/check-build-leaks.mjs --paths a b c   # explicit repo-relative paths
 *
 * `scripts/release.mjs` imports `scanForBuildLeaks` and passes the pack list it
 * already computed, so the release preflight has no second `npm pack` invocation.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reading a 22 MB bundle is expected; refuse anything wildly larger. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Patterns that identify the machine, not the product. */
const MACHINE_PATTERNS = [
  {
    name: "windows user home",
    regex: /[A-Za-z]:\\{1,2}(?:Users|Documents and Settings)\\/g,
  },
  {
    name: "absolute path into node_modules",
    regex: /[A-Za-z]:[\\/]{1,2}[^"'\s]{0,80}node_modules/g,
  },
];

/**
 * Path shapes that are local state, never published content. `files` is
 * authoritative over `.gitignore`, so a whitelisted directory (`scripts/`,
 * `docs/examples/`) can carry an ignored file straight into the tarball.
 */
const LOCAL_STATE_PATH_PATTERNS = [
  { name: "harness state directory", test: (path) => path.split("/").includes(".haruyuki") },
  { name: "local settings file", test: (path) => path.endsWith("settings.local.json") },
  {
    name: "environment file",
    test: (path) => {
      const base = path.split("/").pop() ?? "";
      return base === ".env" || base.startsWith(".env.");
    },
  },
  { name: "installed dependencies", test: (path) => path.split("/").includes("node_modules") },
  { name: "local ops directory", test: (path) => path.startsWith("local-ops/") },
];

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The repository root, in every form it can appear in an emitted artifact:
 * raw (`<drive>:\path\to\repo`), escaped for a JS/JSON string literal
 * (`<drive>:\\path\\to\\repo`), and forward-slash (`<drive>:/path/to/repo`).
 *
 * The examples above are placeholders on purpose: this file ships inside the
 * package (`files` includes `scripts/`), so it must not contain a real path.
 */
export function buildRepositoryRootForms(repoRoot) {
  const trimmed = repoRoot.replace(/[\\/]+$/, "");
  const forms = new Set([
    trimmed,
    trimmed.replaceAll("\\", "\\\\"),
    trimmed.replaceAll("\\", "/"),
  ]);
  // Short roots (a bare drive letter, "/") would match everything.
  return [...forms].filter((form) => form.replace(/[\\/:]/g, "").length >= 3);
}

export function buildLeakPatterns(repoRoot) {
  const rootPatterns = buildRepositoryRootForms(repoRoot).map((form) => ({
    name: "build repository root",
    regex: new RegExp(escapeRegExp(form), "g"),
  }));
  return [...rootPatterns, ...MACHINE_PATTERNS];
}

/**
 * Scan a pack list (repo-relative paths) for machine-identity strings.
 * Binary files (a NUL byte) and anything over `MAX_FILE_BYTES` are skipped.
 */
export function scanForBuildLeaks({ repoRoot, paths }) {
  const patterns = buildLeakPatterns(repoRoot);
  const findings = [];
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    for (const { name, test } of LOCAL_STATE_PATH_PATTERNS) {
      if (test(normalized)) {
        findings.push({ path, pattern: name, sample: path });
      }
    }
    const absolute = join(repoRoot, path);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue; // not on disk: the pack list can name generated entries
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      continue;
    }
    let text;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) {
      continue;
    }
    const names = new Set();
    for (const { name, regex } of patterns) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match && !names.has(name)) {
        names.add(name);
        findings.push({ path, pattern: name, sample: match[0].slice(0, 120) });
      }
    }
  }
  return findings;
}

/**
 * Resolve the npm CLI the same way `release.mjs` does. On Windows `npm` is a
 * `.cmd` shim, which Node refuses to spawn without a shell; running the JS
 * entrypoint through the current Node binary avoids shell quoting entirely.
 */
function resolveNpmCommand() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { command: process.execPath, prefixArgs: [candidate] };
    }
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", prefixArgs: [] };
}

/** The pack list, from `npm pack --dry-run --json` (same parse as release.mjs). */
function readPackList(repoRoot) {
  const npm = resolveNpmCommand();
  const output = execFileSync(
    npm.command,
    [...npm.prefixArgs, "pack", "--dry-run", "--json"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const jsonStart = output.indexOf("[");
  if (jsonStart === -1) {
    throw new Error("could not find the JSON document in `npm pack --dry-run --json` output");
  }
  const parsed = JSON.parse(output.slice(jsonStart));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry?.files) {
    throw new Error("`npm pack --dry-run --json` returned no package files");
  }
  return entry.files.map((file) => file.path);
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2);
  const pathsIndex = argv.indexOf("--paths");
  const paths =
    pathsIndex === -1 ? readPackList(repoRoot) : argv.slice(pathsIndex + 1).filter(Boolean);
  if (paths.length === 0) {
    console.error("✗ no paths to scan");
    process.exit(1);
  }
  const findings = scanForBuildLeaks({ repoRoot, paths });
  if (findings.length === 0) {
    console.log(`[ OK ] no build-machine paths — ${paths.length} file(s) scanned`);
    return;
  }
  console.error(`[FAIL] build-machine path leaked into ${findings.length} place(s):`);
  for (const finding of findings) {
    console.error(`  ${finding.path}  (${finding.pattern})  ${finding.sample}`);
  }
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
