#!/usr/bin/env node
/**
 * The single entry point for releasing Haruyuki to npm.
 *
 * One package, one command name in the registry:
 *
 *   node scripts/release.mjs --check              # read-only: run every preflight check
 *   node scripts/release.mjs --check --skip-network   # … offline (registry and login skipped)
 *   node scripts/release.mjs --publish            # checks -> confirm -> npm publish -> verify
 *
 * Human runs confirm by typing the release token; automation supplies the same token
 * through the environment, so there is exactly one code path:
 *
 *   RELEASE_CONFIRM_TOKEN=haruyuki@0.1.4 node scripts/release.mjs --publish
 *
 * A wrong, missing, or empty token aborts before anything leaves the machine. That is
 * the deliberate backstop instead of a `--yes` flag.
 *
 * Nothing here pushes to git. Pushing, and the release tag, stay manual by policy.
 *
 * THERE IS NO SHORT-NAME PACKAGE. The CLI answers to both `haruyuki` and `hryk`, but
 * that is a `bin` fact of this package only: npm generates the global command from the
 * *package name* in the registry, so `npm install -g haruyuki` yields the `haruyuki`
 * command and nothing else. A separate `hryk` package was designed, built and rejected
 * by the registry (403, name too similar to existing packages); it is not coming back
 * through the unscoped name. Do not reintroduce a forwarding-package flow here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scanForBuildLeaks } from "./check-build-leaks.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "haruyuki";
/** Command names this package declares; both must resolve to the same bundle. */
const COMMAND_NAMES = ["haruyuki", "hryk"];
const BIN_TARGET = "haruyuki.js";
/** Legal files that must ship. */
const LEGAL_FILES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"];
/** Build outputs the package cannot ship without. */
const REQUIRED_ARTIFACTS = ["haruyuki.js", "image-resize-worker.js", "dist"];
/** The only untracked/ignored paths tolerated by the clean-tree check. */
const IGNORED_PATH_PREFIXES = ["docs/", "SPEC-"];
const REGISTRY = "https://registry.npmjs.org/";
const CONFIRM_TOKEN_ENV = "RELEASE_CONFIRM_TOKEN";
const HTTP_TIMEOUT_MS = 8_000;

const checks = [];

function record(level, label, detail) {
  checks.push({ level, label, detail });
  const mark = level === "fail" ? "[FAIL]" : level === "warn" ? "[WARN]" : "[ OK ]";
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

function ok(label, detail) {
  record("ok", label, detail);
}

function warn(label, detail) {
  record("warn", label, detail);
}

function bad(label, detail) {
  record("fail", label, detail);
}

function heading(title) {
  console.log(`\n── ${title}`);
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function bytes(value) {
  return `${value.toLocaleString("en-US")} B`;
}

/**
 * Resolve the npm CLI. On Windows `npm` is a `.cmd` shim, which Node refuses to spawn
 * without a shell (`spawnSync npm.cmd EINVAL`); running the JS entrypoint through the
 * current Node binary avoids shell quoting entirely.
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

const NPM = resolveNpmCommand();

function runNpm(args) {
  try {
    return execFileSync(NPM.command, [...NPM.prefixArgs, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    const stdout = error.stdout ? String(error.stdout).trim() : "";
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    return fail(
      `npm ${args.join(" ")} failed (exit ${error.status ?? "?"})${
        detail ? `\n${detail}` : `\n${error.message}`
      }`,
    );
  }
}

function runGit(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/**
 * `npm pack` prints lifecycle-script output on the same stdout stream as the JSON
 * document, so the payload is located by its first bracket rather than assumed to be
 * the whole stream.
 */
function packDryRun() {
  const output = runNpm(["pack", "--dry-run", "--json"]);
  const jsonStart = output.indexOf("[");
  if (jsonStart === -1) {
    return fail("could not find the JSON document in `npm pack --dry-run --json` output");
  }
  const parsed = JSON.parse(output.slice(jsonStart));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry) {
    return fail("`npm pack --dry-run --json` returned no package entry");
  }
  return entry;
}

/** Registry lookup. Distinguishes "absent" (404) from "unreachable" — never conflates them. */
function fetchRegistryDocument(name) {
  return new Promise((resolvePromise) => {
    const url = `${REGISTRY}${name}`;
    import("node:https")
      .then(({ default: https }) => {
        const request = https.get(
          url,
          { timeout: HTTP_TIMEOUT_MS, headers: { accept: "application/json" } },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf8");
              if (response.statusCode === 404) {
                resolvePromise({ state: "absent" });
                return;
              }
              if (response.statusCode !== 200) {
                resolvePromise({ state: "error", detail: `HTTP ${response.statusCode}` });
                return;
              }
              try {
                resolvePromise({ state: "present", document: JSON.parse(body) });
              } catch (error) {
                resolvePromise({ state: "error", detail: `unparsable JSON: ${error.message}` });
              }
            });
          },
        );
        request.on("timeout", () => {
          request.destroy(new Error(`no response within ${HTTP_TIMEOUT_MS} ms`));
        });
        request.on("error", (error) => {
          resolvePromise({ state: "error", detail: error.message });
        });
      })
      .catch((error) => resolvePromise({ state: "error", detail: error.message }));
  });
}

function ask(question) {
  return new Promise((resolvePromise) => {
    import("node:readline")
      .then(({ default: readline }) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
          rl.close();
          resolvePromise(answer.trim());
        });
      })
      .catch(() => resolvePromise(""));
  });
}

/**
 * One confirmation step, satisfied either by a human typing the token or by automation
 * supplying it in the environment. There is no "skip" input: the answer must equal the
 * token exactly.
 */
async function confirm(token) {
  const supplied = process.env[CONFIRM_TOKEN_ENV];
  if (supplied !== undefined) {
    if (supplied.trim() !== token) {
      return fail(
        `${CONFIRM_TOKEN_ENV} does not match the required confirmation token.\n` +
          `  expected: ${token}\n  received: ${supplied.trim() === "" ? "(empty)" : "(different value)"}`,
      );
    }
    ok(`confirmed via ${CONFIRM_TOKEN_ENV}`);
    return;
  }
  if (!process.stdin.isTTY) {
    return fail(
      `no TTY and ${CONFIRM_TOKEN_ENV} is unset, so the release cannot be confirmed.\n` +
        `  interactive:  re-run and type the token when asked\n` +
        `  automation:   set ${CONFIRM_TOKEN_ENV}=${token}`,
    );
  }
  console.log(`\n  To confirm, type exactly:  ${token}`);
  const answer = await ask("  > ");
  if (answer !== token) {
    return fail(`confirmation token mismatch (received "${answer}")`);
  }
  ok("confirmed");
}

function parseArguments(argv) {
  const options = { mode: "check", skipNetwork: false };
  for (const raw of argv) {
    if (raw === "--check" || raw === "--dry-run") {
      options.mode = "check";
    } else if (raw === "--publish") {
      options.mode = "publish";
    } else if (raw === "--skip-network") {
      options.skipNetwork = true;
    } else if (raw === "--help" || raw === "-h") {
      console.log(
        [
          "Usage: node scripts/release.mjs [--check | --publish] [--skip-network]",
          "",
          "  --check          (default) run every preflight check; publishes nothing",
          "  --publish        checks -> confirm -> npm publish -> verify what went live",
          "  --skip-network   skip the registry and login checks; --check only",
          "",
          `  Automation sets ${CONFIRM_TOKEN_ENV} instead of typing the confirmation token.`,
        ].join("\n"),
      );
      process.exit(0);
    } else {
      return fail(`unknown argument: ${raw}`);
    }
  }
  if (options.skipNetwork && options.mode !== "check") {
    return fail(
      "--skip-network only applies to --check: publishing requires a reachable registry and a valid login.",
    );
  }
  return options;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function checkRepoLocation() {
  heading("1. repository");
  const manifestPath = join(REPO_ROOT, "package.json");
  if (!existsSync(manifestPath)) {
    return bad("package.json", `${manifestPath} is missing`);
  }
  ok("package.json present", REPO_ROOT);

  try {
    const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (branch === "HEAD") {
      bad("git branch", "detached HEAD; releases must come from a branch");
    } else {
      ok("git branch", branch);
    }
  } catch {
    bad("git branch", "not a git repository, or git is unavailable");
  }
  try {
    ok("HEAD", runGit(["log", "-1", "--format=%h %s"]).trim());
  } catch {
    bad("HEAD", "could not read the last commit");
  }
  return undefined;
}

function checkManifest(main) {
  heading("2. manifest");
  if (main.name !== PACKAGE_NAME) {
    bad("name", `expected "${PACKAGE_NAME}", found "${main.name}"`);
  } else {
    ok("name", main.name);
  }
  if (typeof main.version === "string" && main.version.length > 0) {
    ok("version", main.version);
  } else {
    bad("version", "missing");
  }
  if (main.private) {
    bad("private", "npm refuses to publish a package marked private");
  } else {
    ok("private", "absent");
  }
  if (main.publishConfig?.access === "public") {
    ok("publishConfig.access");
  } else {
    bad("publishConfig.access", 'must be "public"');
  }
  if (main.license) {
    ok("license", main.license);
  } else {
    bad("license", "missing");
  }
  for (const field of ["repository", "author"]) {
    if (field === "repository" ? main.repository?.url : main[field]) {
      ok(field);
    } else {
      warn(field, "missing");
    }
  }
  if (main.engines?.node) {
    ok("engines.node", main.engines.node);
  } else {
    warn("engines.node", "missing; installing on old Node fails at runtime instead");
  }
  if (main.scripts?.prepublishOnly) {
    ok("scripts.prepublishOnly", main.scripts.prepublishOnly);
  } else {
    warn("scripts.prepublishOnly", "absent; nothing rebuilds the bundle before publish");
  }
  return undefined;
}

/**
 * Both command names are a local `bin` fact: the registry only ever generates the
 * command matching the package name, but the tarball and source checkouts get both.
 */
function checkBinEntries(main) {
  heading("3. command names");
  for (const name of COMMAND_NAMES) {
    const target = main.bin?.[name];
    if (target === BIN_TARGET) {
      ok(`bin["${name}"]`, target);
    } else {
      bad(`bin["${name}"]`, `expected "${BIN_TARGET}", found ${JSON.stringify(target ?? null)}`);
    }
  }
  const extra = Object.keys(main.bin ?? {}).filter((name) => !COMMAND_NAMES.includes(name));
  if (extra.length > 0) {
    bad("unexpected bin entries", extra.join(", "));
  }
  return undefined;
}

/**
 * `files` mixes plain files, directories, and globs. npm errors on a missing literal
 * entry, but a silently-empty directory is worse: the package ships without it and
 * nothing complains until a consumer imports the missing module.
 */
function checkFilesWhitelist(main) {
  heading("4. files whitelist");
  const entries = Array.isArray(main.files) ? main.files : [];
  if (entries.length === 0) {
    return bad("files", "empty; npm would ship everything");
  }
  const missing = [];
  const emptyDirs = [];
  // `!pattern` entries are exclusions, not paths to stat. npm applies them to the
  // whitelist, which is the only way to drop a file that lives inside a
  // whitelisted directory (`.npmignore` and `.gitignore` lose to `files`).
  const exclusions = entries.filter((entry) => entry.startsWith("!"));
  for (const entry of entries) {
    if (entry.startsWith("!") || entry.includes("*") || entry.includes("?")) {
      continue;
    }
    const absolute = join(REPO_ROOT, entry);
    if (!existsSync(absolute)) {
      missing.push(entry);
      continue;
    }
    try {
      if (readdirSync(absolute).length === 0) {
        emptyDirs.push(entry);
      }
    } catch {
      // A file, not a directory — nothing more to check.
    }
  }
  if (missing.length === 0) {
    ok(`all ${entries.length} entries resolve`);
  } else {
    bad("unresolved entries", missing.join(", "));
  }
  if (emptyDirs.length > 0) {
    bad("empty directories", emptyDirs.join(", "));
  }
  if (exclusions.length > 0) {
    ok("exclusions", exclusions.join(", "));
  }
  for (const entry of entries.filter((value) => value.includes("*"))) {
    warn("glob entry", `${entry} — not checked statically`);
  }
  return undefined;
}

function checkBuildArtifacts() {
  heading("5. build artifacts");
  for (const artifact of REQUIRED_ARTIFACTS) {
    const absolute = join(REPO_ROOT, artifact);
    if (!existsSync(absolute)) {
      bad(artifact, "missing; run: bun run build");
      continue;
    }
    try {
      ok(artifact, bytes(readFileSync(absolute).length));
    } catch {
      ok(artifact, "directory");
    }
  }
  return undefined;
}

function checkLegalFiles() {
  heading("6. legal files");
  for (const file of LEGAL_FILES) {
    if (existsSync(join(REPO_ROOT, file))) {
      ok(file);
    } else {
      bad(file, "missing; CONTRIBUTING.md forbids dropping it");
    }
  }
  return undefined;
}

/**
 * The release must correspond to a committed revision, and to a tagged one: a published
 * version whose commit is untagged cannot be checked out again.
 */
function checkGitState(main) {
  heading("7. git state");
  const status = runGit(["status", "--porcelain"]);
  const offenders = status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(2).trim())
    // Renames and copies are printed as "old -> new"; both sides matter.
    .flatMap((entry) => entry.split(" -> "))
    .map((path) => (path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path))
    .filter((path) => path.length > 0)
    .filter((path) => !IGNORED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
  if (offenders.length === 0) {
    ok("working tree clean", `ignoring ${IGNORED_PATH_PREFIXES.join(", ")}`);
  } else {
    bad("working tree dirty", offenders.join(", "));
  }

  const expectedTag = `v${main.version}`;
  const tagsAtHead = runGit(["tag", "--points-at", "HEAD"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (tagsAtHead.includes(expectedTag)) {
    ok("HEAD is tagged", expectedTag);
  } else {
    bad(
      "HEAD is not tagged",
      tagsAtHead.length > 0
        ? `found ${tagsAtHead.join(", ")}; expected ${expectedTag}`
        : `expected: git tag -a ${expectedTag} -m "..."`,
    );
  }
  return undefined;
}

/** Whether this exact version has been published already. */
async function checkRegistryAvailability(main) {
  heading("8. registry");
  ok("registry", REGISTRY);
  const result = await fetchRegistryDocument(main.name);
  if (result.state === "error") {
    bad(
      "registry reachable",
      `${result.detail} — refusing to treat an unreachable registry as "name is free"`,
    );
    return undefined;
  }
  if (result.state === "absent") {
    warn(`${main.name} is not on the registry`, "this would be the first publish");
    return undefined;
  }
  const published = Object.keys(result.document.versions ?? {});
  const latest = result.document["dist-tags"]?.latest ?? "(none)";
  ok(`${main.name} exists`, `latest = ${latest}, ${published.length} version(s) published`);
  if (published.includes(main.version)) {
    bad(`version ${main.version} already published`, "bump the version before releasing");
  } else {
    ok(`version ${main.version} is free`);
  }
  return undefined;
}

function checkAuthentication() {
  heading("9. authentication");
  let whoami = "";
  try {
    whoami = runNpm(["whoami", `--registry=${REGISTRY}`]).trim();
  } catch {
    whoami = "";
  }
  if (whoami.length === 0) {
    bad("npm login", `run: npm login --registry=${REGISTRY}`);
  } else {
    ok("logged in as", whoami);
  }
  return undefined;
}

function checkTarball(entry) {
  heading("10. tarball");
  console.log(`  files          ${entry.entryCount}`);
  console.log(`  size           ${bytes(entry.size)} (unpacked ${bytes(entry.unpackedSize)})`);
  console.log(`  shasum         ${entry.shasum}`);
  console.log(`  integrity      ${entry.integrity}`);
  const paths = entry.files.map((file) => file.path);
  const leaked = paths.filter((path) => /^docs\/\d/.test(path));
  if (leaked.length === 0) {
    ok("no internal planning docs", "docs/ ships only examples");
  } else {
    bad("internal planning docs leaked", leaked.slice(0, 8).join(", "));
  }
  // Path-level checks above cannot see a machine path baked into a file's bytes;
  // `haruyuki@0.2.0` shipped the maintainer's repo root inside `haruyuki.js`.
  const machineLeaks = scanForBuildLeaks({ repoRoot: REPO_ROOT, paths });
  if (machineLeaks.length === 0) {
    ok("no build-machine paths in file contents", `${paths.length} packed file(s) scanned`);
  } else {
    bad(
      "build-machine path leaked into the package",
      machineLeaks
        .slice(0, 4)
        .map((finding) => `${finding.path} [${finding.pattern}]`)
        .join(", "),
    );
  }
  if (paths.includes(BIN_TARGET)) {
    ok(`${BIN_TARGET} in tarball`);
  } else {
    bad(`${BIN_TARGET} missing from tarball`, "the published package would not run");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Publish and verify
// ---------------------------------------------------------------------------

async function verifyPublished(main) {
  heading("verifying what went live");
  const result = await fetchRegistryDocument(main.name);
  if (result.state === "error") {
    return bad("registry lookup", `${result.detail} — cannot confirm the release`);
  }
  if (result.state === "absent") {
    return bad(main.name, "not on the registry");
  }
  const version = result.document.versions?.[main.version];
  if (!version) {
    return bad(`${main.name}@${main.version}`, "not published");
  }
  const latest = result.document["dist-tags"]?.latest;
  ok(
    `${main.name}@${main.version}`,
    `tarball integrity ${version.dist?.integrity ?? "(unknown)"}, latest = ${latest ?? "(none)"}`,
  );
  return undefined;
}

function summarize() {
  const failures = checks.filter((check) => check.level === "fail");
  const warnings = checks.filter((check) => check.level === "warn");
  heading("summary");
  console.log(
    `  ${checks.length - failures.length - warnings.length} passed, ${warnings.length} warnings, ${failures.length} failures`,
  );
  for (const failure of failures) {
    console.log(`  [FAIL] ${failure.label}${failure.detail ? ` — ${failure.detail}` : ""}`);
  }
  return failures.length;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(`\nharuyuki release — mode: ${options.mode}`);

  const main = readJson(join(REPO_ROOT, "package.json"));

  checkRepoLocation();
  checkManifest(main);
  checkBinEntries(main);
  checkFilesWhitelist(main);
  checkBuildArtifacts();
  checkLegalFiles();
  checkGitState(main);
  if (options.skipNetwork) {
    heading("8. registry");
    warn("skipped", "--skip-network; connectivity is not proven");
    heading("9. authentication");
    warn("skipped", "--skip-network; a real publish still needs a valid login");
  } else {
    await checkRegistryAvailability(main);
    checkAuthentication();
  }
  checkTarball(packDryRun());

  const failures = summarize();
  if (failures > 0) {
    return fail(`${failures} check(s) failed; nothing was published.`);
  }

  if (options.mode === "check") {
    heading("check complete");
    console.log("  Nothing was published. Re-run with --publish to release.\n");
    return;
  }

  await confirm(`${main.name}@${main.version}`);
  heading(`publishing ${main.name}@${main.version}`);
  runNpm(["publish", "--access", "public"]);
  ok(`published ${main.name}@${main.version}`);
  await verifyPublished(main);

  const remaining = summarize();
  if (remaining > 0) {
    return fail(`${remaining} check(s) failed after publishing; inspect the output above.`);
  }

  heading("released");
  console.log("  Still manual, by policy:");
  console.log(`    git push                 # the tagged commit`);
  console.log(`    git push --tags          # v${main.version}`);
  console.log("");
}

await main();
