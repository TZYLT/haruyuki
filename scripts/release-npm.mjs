#!/usr/bin/env node
/**
 * The single entry point for releasing Haruyuki to npm.
 *
 * Two packages ship together and their publish order is not optional:
 *
 *   1. `haruyuki`  the real package — it carries the built `haruyuki.js` bundle and
 *                  declares both command names.
 *   2. `hryk`      a forwarding package — two README files and a manifest, no code.
 *                  It depends on `haruyuki` at the *exact* same version, so it cannot
 *                  be installed (or published usefully) until the main package is live.
 *
 * Everything a release needs is behind this one command. Human runs use the default
 * interactive confirmations; automation supplies the same confirmation through the
 * environment, so there is exactly one code path:
 *
 *   node scripts/release-npm.mjs --dry-run          # read-only: checks + generated artifacts
 *   node scripts/release-npm.mjs --publish          # checks -> confirm -> publish -> verify
 *   node scripts/release-npm.mjs --verify           # verify already-published versions
 *
 * Automation (no TTY): set RELEASE_CONFIRM_TOKEN to the token the interactive run would
 * have been asked to type ("haruyuki@0.1.3" for the first confirmation, "hryk@0.1.3" for
 * the second). A wrong, missing, or malformed token aborts before anything leaves the
 * machine — that is the deliberate backstop, replacing a `--yes` flag.
 *
 * Nothing here pushes to git. Pushing, and the release tag, stay manual by policy.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = join(REPO_ROOT, "scripts", "release-npm");
/**
 * Bilingual by design: each language is its own file, and the Chinese one is the
 * package default (`README.md`), matching the main package.
 */
const README_TEMPLATES = [
  { template: "README.md.template", output: "README.md" },
  { template: "README.en.md.template", output: "README.en.md" },
];
const OUT_ROOT = join(TEMPLATE_DIR, "out");
const FORWARD_DIR = join(OUT_ROOT, "hryk");
const MAIN_PACKAGE_NAME = "haruyuki";
const FORWARD_PACKAGE_NAME = "hryk";
/** Both command names must be declared by both packages. */
const COMMAND_NAMES = ["haruyuki", "hryk"];
/** Present in the forwarding package's `files`; nothing else is allowed there. */
const FORWARD_FILES = [...README_TEMPLATES.map((entry) => entry.output), "package.json"];
/** The only untracked/ignored paths tolerated by the clean-tree check. */
const IGNORED_PATH_PREFIXES = ["docs/", "SPEC-", "scripts/release-npm/out/"];
/** Legal files that must ship with the main package. */
const LEGAL_FILES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"];
/** Build outputs the main package cannot ship without. */
const REQUIRED_ARTIFACTS = ["haruyuki.js", "image-resize-worker.js", "dist"];
const REGISTRY = "https://registry.npmjs.org/";
const CONFIRM_TOKEN_ENV = "RELEASE_CONFIRM_TOKEN";
/** Poll budget for "the main package is live before publishing the forwarding package". */
const VISIBILITY_TIMEOUT_MS = 180_000;
const VISIBILITY_INTERVAL_MS = 5_000;
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

function runNpm(args, options = {}) {
  try {
    return execFileSync(NPM.command, [...NPM.prefixArgs, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
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
function packDryRun(cwd) {
  const output = runNpm(["pack", "--dry-run", "--json"], { cwd });
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
                resolvePromise({
                  state: "error",
                  detail: `HTTP ${response.statusCode}`,
                });
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
async function confirm(step, token) {
  const supplied = process.env[CONFIRM_TOKEN_ENV];
  if (supplied !== undefined) {
    if (supplied.trim() !== token) {
      return fail(
        `${CONFIRM_TOKEN_ENV} does not match the required confirmation token for ${step}.\n` +
          `  expected: ${token}\n  received: ${supplied.trim() === "" ? "(empty)" : "(different value)"}`,
      );
    }
    ok(`confirmed ${step} via ${CONFIRM_TOKEN_ENV}`);
    return;
  }
  if (!process.stdin.isTTY) {
    return fail(
      `no TTY and ${CONFIRM_TOKEN_ENV} is unset, so ${step} cannot be confirmed.\n` +
        `  interactive:  re-run and type the token when asked\n` +
        `  automation:   set ${CONFIRM_TOKEN_ENV}=${token}`,
    );
  }
  console.log(`\n  To confirm ${step}, type exactly:  ${token}`);
  const answer = await ask("  > ");
  if (answer !== token) {
    return fail(`confirmation token mismatch for ${step} (received "${answer}")`);
  }
  ok(`confirmed ${step}`);
}

function parseArguments(argv) {
  const options = { mode: "dry-run", skipNetwork: false };
  for (const raw of argv) {
    if (raw === "--publish") {
      options.mode = "publish";
    } else if (raw === "--dry-run") {
      options.mode = "dry-run";
    } else if (raw === "--verify") {
      options.mode = "verify";
    } else if (raw === "--skip-network") {
      options.skipNetwork = true;
    } else if (raw === "--help" || raw === "-h") {
      console.log(
        [
          "Usage: node scripts/release-npm.mjs [--dry-run | --publish | --verify] [--skip-network]",
          "",
          "  --dry-run        (default) read-only checks, then generate the forwarding package",
          "  --publish        checks -> confirm -> publish haruyuki, wait until live, confirm -> publish hryk -> verify",
          "  --verify         verify that the current version of both packages is published",
          "  --skip-network   skip the registry and login checks; dry-run only (a real publish needs both)",
          "",
          `  Automation sets ${CONFIRM_TOKEN_ENV} instead of typing the confirmation token.`,
        ].join("\n"),
      );
      process.exit(0);
    } else {
      return fail(`unknown argument: ${raw}`);
    }
  }
  if (options.skipNetwork && options.mode !== "dry-run") {
    return fail(
      "--skip-network only applies to --dry-run: publishing requires a reachable registry and a valid login.",
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

  let branch = "";
  try {
    branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return bad("git branch", "not a git repository, or git is unavailable");
  }
  if (branch === "HEAD") {
    bad("git branch", "detached HEAD; releases must come from a branch");
  } else {
    ok("git branch", branch);
  }
  try {
    const head = runGit(["log", "-1", "--format=%h %s"]).trim();
    ok("HEAD", head);
  } catch {
    bad("HEAD", "could not read the last commit");
  }
  return undefined;
}

function checkManifest(main) {
  heading("2. manifest");
  if (main.name !== MAIN_PACKAGE_NAME) {
    bad("name", `expected "${MAIN_PACKAGE_NAME}", found "${main.name}"`);
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
  if (main.repository?.url) {
    ok("repository", main.repository.url);
  } else {
    warn("repository", "missing; the npm page will have no source link");
  }
  if (main.author) {
    ok("author", main.author);
  } else {
    warn("author", "missing");
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

function checkBinEntries(main) {
  heading("3. command names");
  for (const name of COMMAND_NAMES) {
    const target = main.bin?.[name];
    if (target === "haruyuki.js") {
      ok(`bin["${name}"]`, target);
    } else {
      bad(`bin["${name}"]`, `expected "haruyuki.js", found ${JSON.stringify(target ?? null)}`);
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
  for (const entry of entries) {
    if (entry.includes("*") || entry.includes("?")) {
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
    ok("working tree clean", "ignoring docs/ and SPEC-*");
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

/** Whether this exact version has been published already; also warns when the name is free. */
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
  const tag = result.document["dist-tags"]?.latest ?? "(none)";
  ok(`${main.name} exists`, `latest = ${tag}, ${published.length} version(s) published`);
  if (published.includes(main.version)) {
    bad(`version ${main.version} already published`, "bump the version before releasing");
  } else {
    ok(`version ${main.version} is free`);
  }
  const forward = await fetchRegistryDocument(FORWARD_PACKAGE_NAME);
  if (forward.state === "error") {
    bad(`${FORWARD_PACKAGE_NAME} lookup`, forward.detail);
  } else if (forward.state === "absent") {
    ok(`${FORWARD_PACKAGE_NAME} name is free`, "first publish of the short name");
  } else {
    const forwardVersions = Object.keys(forward.document.versions ?? {});
    if (forwardVersions.includes(main.version)) {
      bad(`${FORWARD_PACKAGE_NAME}@${main.version} already published`, "bump both versions");
    } else {
      ok(`${FORWARD_PACKAGE_NAME} exists`, `${forwardVersions.length} version(s) published`);
    }
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

// ---------------------------------------------------------------------------
// Generated package
// ---------------------------------------------------------------------------

function buildForwardManifest(main) {
  return {
    name: FORWARD_PACKAGE_NAME,
    version: main.version,
    description: "The equivalent short name for haruyuki: installing this package installs haruyuki.",
    // No source of its own — a manifest and the two READMEs, nothing else.
    files: FORWARD_FILES,
    bin: Object.fromEntries(
      COMMAND_NAMES.map((name) => [name, `./node_modules/${main.name}/haruyuki.js`]),
    ),
    dependencies: { [main.name]: main.version },
    repository: main.repository,
    license: main.license,
    author: main.author,
    engines: main.engines,
    publishConfig: main.publishConfig,
  };
}

function generateForwardPackage(main) {
  heading("10. forwarding package");
  const readmes = README_TEMPLATES.map((entry) => {
    const templatePath = join(TEMPLATE_DIR, entry.template);
    if (!existsSync(templatePath)) {
      return fail(`missing the README template at ${templatePath}`);
    }
    const template = readFileSync(templatePath, "utf8");
    if (!template.includes("{{VERSION}}")) {
      return fail(`${entry.template} must contain a {{VERSION}} placeholder`);
    }
    return {
      output: entry.output,
      contents: template
        .replaceAll("{{VERSION}}", main.version)
        .replaceAll("{{MAIN}}", main.name),
    };
  });

  rmSync(FORWARD_DIR, { recursive: true, force: true });
  mkdirSync(FORWARD_DIR, { recursive: true });
  writeFileSync(
    join(FORWARD_DIR, "package.json"),
    `${JSON.stringify(buildForwardManifest(main), null, 2)}\n`,
  );
  for (const readme of readmes) {
    writeFileSync(join(FORWARD_DIR, readme.output), readme.contents);
  }
  ok("generated", FORWARD_DIR);
  return FORWARD_DIR;
}

function checkForwardManifest(main, forward) {
  if (forward.version === main.version) {
    ok("forwarding version matches main", forward.version);
  } else {
    bad("version mismatch", `main ${main.version} vs forwarding ${forward.version}`);
  }
  const declared = forward.dependencies?.[main.name];
  if (declared === main.version && Object.keys(forward.dependencies ?? {}).length === 1) {
    ok("exact dependency", `${main.name}@${declared}`);
  } else {
    bad("dependency", `expected exactly { "${main.name}": "${main.version}" }`);
  }
  const declaredFiles = [...(forward.files ?? [])].sort();
  const expectedFiles = [...FORWARD_FILES].sort();
  if (declaredFiles.join(",") === expectedFiles.join(",")) {
    ok("files", expectedFiles.join(", "));
  } else {
    bad("files", `expected ${expectedFiles.join(", ")}; found ${declaredFiles.join(", ")}`);
  }
  const expectedBin = `./node_modules/${main.name}/haruyuki.js`;
  const binOk = COMMAND_NAMES.every((name) => forward.bin?.[name] === expectedBin);
  if (binOk) {
    ok("bin", `${COMMAND_NAMES.join(", ")} -> ${expectedBin}`);
  } else {
    bad("bin", `expected both names to resolve to ${expectedBin}`);
  }
  return undefined;
}

function describeEntry(label, entry, manifest) {
  heading(`${label}: ${entry.name}@${entry.version}`);
  console.log(`  files          ${entry.entryCount}`);
  console.log(`  size           ${bytes(entry.size)} (unpacked ${bytes(entry.unpackedSize)})`);
  console.log(`  shasum         ${entry.shasum}`);
  console.log(`  integrity      ${entry.integrity}`);
  console.log(`  bin            ${JSON.stringify(manifest.bin)}`);
  const paths = entry.files.map((file) => file.path);
  const leaked = paths.filter((path) => /^docs\/\d/.test(path));
  console.log(`  internal docs  ${leaked.length}`);
  if (leaked.length > 0) {
    console.log(`                 ${leaked.join(", ")}`);
  }
}

/** The generated package must ship exactly its declared files and nothing else. */
function checkForwardTarball(entry) {
  heading("11. forwarding tarball contents");
  if (entry.entryCount !== FORWARD_FILES.length) {
    bad(
      "entry count",
      `expected ${FORWARD_FILES.length}, found ${entry.entryCount}`,
    );
  } else {
    ok("entry count", String(entry.entryCount));
  }
  const unexpected = entry.files
    .map((file) => file.path)
    .filter((path) => !FORWARD_FILES.includes(path));
  if (unexpected.length > 0) {
    bad("unexpected files", unexpected.join(", "));
  } else {
    ok("no unexpected files");
  }
  return undefined;
}

function checkMainTarball(entry) {
  heading("12. main tarball sanity");
  const leaked = entry.files
    .map((file) => file.path)
    .filter((path) => /^docs\/\d/.test(path));
  if (leaked.length === 0) {
    ok("no internal planning docs", "docs/ ships only examples");
  } else {
    bad("internal planning docs leaked", leaked.slice(0, 8).join(", "));
  }
  const binary = entry.files.find((file) => file.path === "haruyuki.js");
  if (binary) {
    ok("haruyuki.js in tarball", bytes(binary.size));
  } else {
    bad("haruyuki.js missing from tarball", "the published package would not run");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Publish and verify
// ---------------------------------------------------------------------------

function publishPackage(cwd, name, version) {
  heading(`publishing ${name}@${version}`);
  runNpm(["publish", "--access", "public"], { cwd });
  ok(`published ${name}@${version}`);
}

/** The forwarding package resolves an exact dependency, so the main package must be live first. */
async function waitUntilVisible(name, version) {
  heading(`waiting for ${name}@${version} to be visible`);
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  let lastDetail = "not queryable";
  while (Date.now() < deadline) {
    const result = await fetchRegistryDocument(name);
    if (result.state === "present" && result.document.versions?.[version]) {
      ok(`${name}@${version} is live`);
      return true;
    }
    if (result.state === "error") {
      lastDetail = result.detail;
    } else if (result.state === "present") {
      lastDetail = "version not listed yet";
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, VISIBILITY_INTERVAL_MS));
  }
  return fail(
    `${name}@${version} did not become visible within ${VISIBILITY_TIMEOUT_MS / 1000}s (last: ${lastDetail}).\n` +
      `  Do not publish the forwarding package yet — it would depend on a version that does not resolve.`,
  );
}

async function verifyPublished(main) {
  heading("verifying published versions");
  for (const name of [MAIN_PACKAGE_NAME, FORWARD_PACKAGE_NAME]) {
    const result = await fetchRegistryDocument(name);
    if (result.state === "error") {
      bad(`${name} lookup`, `${result.detail} — cannot confirm the release`);
      continue;
    }
    if (result.state === "absent") {
      bad(name, "not on the registry");
      continue;
    }
    const version = result.document.versions?.[main.version];
    if (!version) {
      bad(`${name}@${main.version}`, "not published");
      continue;
    }
    const latest = result.document["dist-tags"]?.latest;
    ok(
      `${name}@${main.version}`,
      `tarball integrity ${version.dist?.integrity ?? "(unknown)"}, latest = ${latest ?? "(none)"}`,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------

function summarize() {
  const failures = checks.filter((check) => check.level === "fail");
  const warnings = checks.filter((check) => check.level === "warn");
  heading("summary");
  console.log(`  ${checks.length - failures.length - warnings.length} passed, ${warnings.length} warnings, ${failures.length} failures`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`  [FAIL] ${failure.label}${failure.detail ? ` — ${failure.detail}` : ""}`);
    }
  }
  return failures.length;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(`\nharuyuki release — mode: ${options.mode}`);

  if (options.mode === "verify") {
    const main = readJson(join(REPO_ROOT, "package.json"));
    await verifyPublished(main);
    process.exit(summarize() > 0 ? 1 : 0);
  }

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

  // The forwarding package is generated before failure is declared, so its contents can
  // be reviewed in the summary even when a check above failed.
  const forwardDir = generateForwardPackage(main);
  const forward = readJson(join(forwardDir, "package.json"));
  checkForwardManifest(main, forward);

  const mainEntry = packDryRun(REPO_ROOT);
  const forwardEntry = packDryRun(forwardDir);
  describeEntry(MAIN_PACKAGE_NAME, mainEntry, main);
  describeEntry(FORWARD_PACKAGE_NAME, forwardEntry, forward);
  checkForwardTarball(forwardEntry);
  checkMainTarball(mainEntry);

  const failures = summarize();
  if (failures > 0) {
    return fail(`${failures} check(s) failed; nothing was published.`);
  }

  if (options.mode === "dry-run") {
    heading("dry-run complete");
    console.log("  Nothing was published. Re-run with --publish to release.\n");
    return;
  }

  const mainToken = `${main.name}@${main.version}`;
  const forwardToken = `${forward.name}@${forward.version}`;
  console.log("\n  Planned release, in this order:");
  console.log(`    1. ${mainToken}   (then wait until it is live on the registry)`);
  console.log(`    2. ${forwardToken}`);
  await confirm(`step 1 (${mainToken})`, mainToken);

  publishPackage(REPO_ROOT, main.name, main.version);
  await waitUntilVisible(main.name, main.version);

  await confirm(`step 2 (${forwardToken})`, forwardToken);
  publishPackage(forwardDir, forward.name, forward.version);

  await verifyPublished(main);

  const remaining = summarize();
  if (remaining > 0) {
    return fail(`${remaining} check(s) failed after publishing; inspect the output above.`);
  }

  heading("released");
  console.log("  Both packages are published and verified. Still manual, by policy:");
  console.log(`    git tag -a v${main.version} -m "..."   # suggest tagging the version-bump commit`);
  console.log("    git push && git push --tags");
  console.log("");
}

await main();
