#!/usr/bin/env node
/**
 * Short-name (`hryk`) release flow.
 *
 * `haruyuki` is the main package: it carries the built `haruyuki.js` bundle and declares
 * both command names. `hryk` is a *forwarding package*: two files, no artifacts, and an
 * exact-version dependency on the main package. Publishing therefore has a hard order —
 * the main package must be on the registry before the forwarding package can install —
 * and this script is the single entry point that enforces it.
 *
 *   node scripts/publish-shortname.mjs --dry-run   # default: generate + inspect both packages
 *   node scripts/publish-shortname.mjs --publish   # main package first, then the forwarding package
 *
 * The generated forwarding directory is scratch output: it is written under
 * `scripts/publish-shortname/out/` (gitignored) and never enters the repository.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_PATH = join(REPO_ROOT, "scripts", "publish-shortname", "README.template.md");
const OUT_ROOT = join(REPO_ROOT, "scripts", "publish-shortname", "out");
const FORWARD_DIR = join(OUT_ROOT, "hryk");
const FORWARD_PACKAGE_NAME = "hryk";
/** Both command names must be declared by both packages — see the short-name route doc. */
const COMMAND_NAMES = ["haruyuki", "hryk"];
/** Present in the forwarding package's `files`; nothing else is allowed there. */
const FORWARD_FILES = ["README.md", "package.json"];
/** The only untracked/ignored paths tolerated by the publish-mode tree check. */
const IGNORED_PATH_PREFIXES = ["docs/", "SPEC-", "scripts/publish-shortname/out/"];

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
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    prefixArgs: [],
  };
}

const NPM = resolveNpmCommand();

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`  ${message}`);
}

function heading(message) {
  console.log(`\n── ${message}`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * `npm pack` prints its `prepare` script output on the same stdout stream as the tarball
 * name, so the filename is never the only line.
 */
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

function packDryRun(cwd) {
  const output = runNpm(["pack", "--dry-run", "--json"], { cwd });
  // Keep only the JSON document: earlier lines may come from lifecycle scripts.
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

function parseArguments(argv) {
  const options = { publish: false };
  for (const raw of argv) {
    if (raw === "--publish") {
      options.publish = true;
    } else if (raw === "--dry-run") {
      options.publish = false;
    } else if (raw === "--help" || raw === "-h") {
      console.log(
        [
          "Usage: node scripts/publish-shortname.mjs [--dry-run | --publish]",
          "",
          "  --dry-run   (default) generate the forwarding package and inspect both packages",
          "  --publish   publish the main package first, then the forwarding package",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${raw}`);
    }
  }
  return options;
}

/** Every publication must correspond to a committed revision of the main package. */
function assertCleanTree() {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const offenders = status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\S+\s+/, "").replace(/^"(.*)"$/, "$1"))
    .filter((path) => !IGNORED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
  if (offenders.length > 0) {
    fail(
      `the working tree is not clean, so this revision is not committed:\n    ${offenders.join(
        "\n    ",
      )}`,
    );
  }
}

function readMainPackage() {
  const mainPath = join(REPO_ROOT, "package.json");
  if (!existsSync(mainPath)) {
    return fail(`missing ${mainPath}`);
  }
  const main = readJson(mainPath);
  if (main.name !== "haruyuki") {
    return fail(`expected the main package to be named "haruyuki", found "${main.name}"`);
  }
  if (typeof main.version !== "string" || main.version.length === 0) {
    return fail("the main package has no version");
  }
  for (const name of COMMAND_NAMES) {
    if (main.bin?.[name] !== "haruyuki.js") {
      return fail(
        `the main package must map bin["${name}"] to "haruyuki.js"; found ${JSON.stringify(
          main.bin?.[name] ?? null,
        )}`,
      );
    }
  }
  if (!main.repository?.url) {
    return fail("the main package has no repository.url");
  }
  return main;
}

function buildForwardManifest(main) {
  return {
    name: FORWARD_PACKAGE_NAME,
    version: main.version,
    description: `The equivalent short name for haruyuki: installing this package installs haruyuki.`,
    // No source of its own — a manifest and a README, nothing else.
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
  if (!existsSync(TEMPLATE_PATH)) {
    return fail(`missing the README template at ${TEMPLATE_PATH}`);
  }
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  if (!template.includes("{{VERSION}}")) {
    return fail("the README template must contain a {{VERSION}} placeholder");
  }
  const readme = template
    .replaceAll("{{VERSION}}", main.version)
    .replaceAll("{{MAIN}}", main.name);

  rmSync(FORWARD_DIR, { recursive: true, force: true });
  mkdirSync(FORWARD_DIR, { recursive: true });
  writeFileSync(
    join(FORWARD_DIR, "package.json"),
    `${JSON.stringify(buildForwardManifest(main), null, 2)}\n`,
  );
  writeFileSync(join(FORWARD_DIR, "README.md"), readme);
  return FORWARD_DIR;
}

function assertForwardManifest(main, forward) {
  if (forward.version !== main.version) {
    return fail(
      `version mismatch: the main package is ${main.version} but the forwarding package is ${forward.version}`,
    );
  }
  if (forward.dependencies?.[main.name] !== main.version) {
    return fail(
      `the forwarding package must depend on ${main.name}@${main.version} exactly; found ${
        forward.dependencies?.[main.name] ?? "nothing"
      }`,
    );
  }
  if (forward.dependencies && Object.keys(forward.dependencies).length !== 1) {
    return fail("the forwarding package must depend on the main package and nothing else");
  }
  const declaredFiles = [...(forward.files ?? [])].sort();
  const expectedFiles = [...FORWARD_FILES].sort();
  if (declaredFiles.join(",") !== expectedFiles.join(",")) {
    return fail(
      `the forwarding package files must be exactly ${expectedFiles.join(", ")}; found ${declaredFiles.join(", ")}`,
    );
  }
  for (const name of COMMAND_NAMES) {
    const expected = `./node_modules/${main.name}/haruyuki.js`;
    if (forward.bin?.[name] !== expected) {
      return fail(
        `the forwarding package must map bin["${name}"] to "${expected}"; found ${JSON.stringify(
          forward.bin?.[name] ?? null,
        )}`,
      );
    }
  }
}

function describe(label, entry, manifest) {
  heading(`${label}: ${entry.name}@${entry.version}`);
  info(`files          ${entry.entryCount}`);
  info(`size           ${entry.size} B (unpacked ${entry.unpackedSize} B)`);
  info(`shasum         ${entry.shasum}`);
  info(`bin            ${JSON.stringify(manifest.bin)}`);
  const paths = entry.files.map((file) => file.path);
  const leaked = paths.filter((path) => /^docs\/\d/.test(path));
  info(`internal docs  ${leaked.length}`);
  if (leaked.length > 0) {
    info(`               ${leaked.join(", ")}`);
  }
  if (label === FORWARD_PACKAGE_NAME) {
    info(`contents       ${paths.join(", ")}`);
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const displayName = `publish-shortname (${options.publish ? "publish" : "dry-run"})`;
  heading(displayName);

  if (options.publish) {
    assertCleanTree();
    info("working tree is clean");
  }

  const main = readMainPackage();
  info(`main package   ${main.name}@${main.version}`);
  info(`repository     ${main.repository.url}`);

  const forwardDir = generateForwardPackage(main);
  const forward = readJson(join(forwardDir, "package.json"));
  assertForwardManifest(main, forward);
  info(`forwarding package generated at ${forwardDir}`);

  const mainEntry = packDryRun(REPO_ROOT);
  const forwardEntry = packDryRun(forwardDir);
  describe("haruyuki", mainEntry, main);
  describe(FORWARD_PACKAGE_NAME, forwardEntry, forward);

  if (forwardEntry.entryCount !== FORWARD_FILES.length) {
    return fail(
      `the forwarding package must ship exactly ${FORWARD_FILES.length} files; found ${forwardEntry.entryCount}`,
    );
  }
  for (const path of forwardEntry.files.map((file) => file.path)) {
    if (!FORWARD_FILES.includes(path)) {
      return fail(`the forwarding package must not ship ${path}`);
    }
  }

  if (!options.publish) {
    heading("dry-run complete — nothing was published");
    return;
  }

  // Hard order: the forwarding package cannot resolve its dependency until the main
  // package is on the registry with this exact version.
  heading(`publishing ${main.name}@${main.version}`);
  runNpm(["publish", "--access", "public"]);
  heading(`publishing ${FORWARD_PACKAGE_NAME}@${forward.version}`);
  runNpm(["publish", "--access", "public"], { cwd: forwardDir });
  heading("both packages published — push the tag and the release commit when ready");
}

main();
