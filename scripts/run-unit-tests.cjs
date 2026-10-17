#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { availableParallelism } = require("node:os");
const path = require("node:path");
const { shardTestFiles } = require("./test-sharding.cjs");
const { partitionTestFilesForParallel } = require("./test-runtime-groups.cjs");
const {
  buildFamilyImpactIndex,
  getGitChangedFiles,
  planUnitTests,
  readPullRequestShas,
} = require("./unit-test-impact.cjs");

/**
 * The `bun` executable to run the suite with.
 *
 * `execFileSync("bun")` goes through PATH on POSIX, but on Windows the installed
 * command is the npm shim `bun.cmd`, and Node refuses to launch a batch file
 * without a shell — a shell would then re-quote every path filter we pass, which
 * is how a suite silently runs fewer files than it selected. So find the
 * executable the shim wraps instead. `HARUYUKI_BUN_EXECUTABLE` overrides this for
 * an install it cannot guess (a standalone `bun.exe` elsewhere, a package manager
 * shim, a CI image).
 */
function resolveBunExecutable() {
  const override = process.env.HARUYUKI_BUN_EXECUTABLE;
  if (override) return override;
  if (process.platform !== "win32") return "bun";

  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    // A standalone install puts `bun.exe` on PATH; the npm shim puts it one
    // `node_modules` level below the directory that holds `bun.cmd`.
    const candidates = [
      path.join(dir, "bun.exe"),
      path.join(dir, "node_modules", "bun", "bin", "bun.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "bun";
}

const BUN_EXECUTABLE = resolveBunExecutable();

/**
 * The PATH a test process runs with: the runner's own, plus the directory of the `bun`
 * it resolved for itself.
 *
 * Tests that launch the CLI resolve `bun` by name (`spawn("bun", ["run", "dev", …])`),
 * and on Windows CreateProcess only appends `.exe` — so on a machine whose only install
 * is the npm shim (`bun.cmd`) every one of those tests dies with
 * `ENOENT: no such file or directory, uv_spawn 'bun'`. That was ~110 failures in a full
 * run, none of them about the code under test. Handing the child the executable this
 * runner already resolved keeps the two from disagreeing about where bun is.
 */
function childPathEnv() {
  if (!path.isAbsolute(BUN_EXECUTABLE)) return {};
  const directory = path.dirname(BUN_EXECUTABLE);
  const key =
    Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ??
    "PATH";
  const current = process.env[key] ?? "";
  const entries = current.split(path.delimiter).filter(Boolean);
  if (
    entries.some((entry) => path.normalize(entry) === path.normalize(directory))
  ) {
    return {};
  }
  return {
    [key]: [directory, ...entries].join(path.delimiter),
  };
}

// Unit test directories — bun discovers *.test.ts / *.test.tsx within each.
// Listed explicitly so we skip src/integration-tests (API-gated).
const dirs = [
  "src/agent",
  "src/auth",
  "src/backend",
  "src/cli",
  "src/cron",
  "src/experiments",
  "src/helpers",
  "src/hooks",
  "src/lsp",
  "src/mods",
  "src/permissions",
  "src/providers",
  "src/queue",
  "src/reminders",
  "src/sandbox",
  "src/skills",
  "src/telemetry",
  "src/test-utils",
  "src/tools",
  "src/types",
  "src/utils",
  "src/web",
  "src/websocket",
];

const isolationManifest = JSON.parse(
  readFileSync(path.join(__dirname, "isolated-unit-tests.json"), "utf8"),
);
const isolatedTests = isolationManifest.tests;
const isolatedPaths = new Set(isolatedTests.map((entry) => entry.path));

function findTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".test.tsx")
    ) {
      results.push(full.replace(/\\/g, "/"));
    }
  }
  return results;
}

function findRootTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")),
    )
    .map((entry) => path.join(dir, entry.name).replace(/\\/g, "/"));
}

const rootTestFiles = findRootTestFiles("src");
const allTestFiles = [
  ...dirs.flatMap((dir) => findTestFiles(dir)),
  ...findTestFiles("src/channels"),
  ...rootTestFiles,
  "scripts/unit-test-impact.test.cjs",
  "scripts/test-sharding.test.cjs",
  "scripts/test-runtime-groups.test.cjs",
].sort();
const discoveredPaths = new Set(allTestFiles);

/**
 * The discovery set expressed as bun path filters.
 *
 * Bun's positional arguments are filters, so this selects the same files as
 * `allTestFiles` without putting ~900 paths on the command line. That command
 * line was the only reason this runner used to chunk the suite and run the
 * chunks one after another.
 */
const wholeSuiteTargets = [
  ...dirs,
  "src/channels",
  ...rootTestFiles,
  "scripts/unit-test-impact.test.cjs",
  "scripts/test-sharding.test.cjs",
  "scripts/test-runtime-groups.test.cjs",
];

for (const entry of isolatedTests) {
  if (!discoveredPaths.has(entry.path)) {
    throw new Error(
      `Isolated unit test is missing from the unit-test roots: ${entry.path}`,
    );
  }
  if (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0) {
    throw new Error(`Invalid timeout for isolated unit test: ${entry.path}`);
  }
}

function runTests(files, timeoutMs, env = {}, extraArgs = []) {
  execFileSync(
    BUN_EXECUTABLE,
    ["test", ...files, "--timeout", String(timeoutMs), ...extraArgs],
    {
      stdio: "inherit",
      // Unit tests must never emit product telemetry or make test fixtures look
      // like real users. Only isolated telemetry contract tests may opt back in.
      env: {
        ...process.env,
        ...childPathEnv(),
        HARUYUKI_CODE_TELEM: "0",
        ...env,
      },
    },
  );
}

/**
 * How many test files to run concurrently.
 *
 * `bun test --parallel=N` fans files out over N worker processes and implies
 * `--isolate`, so each file gets a fresh global/module registry. That covers module
 * mocks, but not the shared preload's test hooks: under `--parallel` the preload's
 * environment applies while its hooks never fire, so every manifest entry still gets a
 * process of its own.
 *
 * `HARUYUKI_TEST_PARALLEL=0` restores the old chunked, single-process-per-chunk
 * behaviour; any positive integer overrides the worker count.
 */
/**
 * Worker count used when `HARUYUKI_TEST_PARALLEL` is unset.
 *
 * More workers means fewer files per worker, and the suite is sensitive to that:
 * measured on a 24-core machine, 4 workers report 36 failures where 8 report 27, which
 * is the shape of cross-file state leaking inside a worker. 16 keeps the per-worker
 * file count low without over-subscribing the box.
 */
const DEFAULT_PARALLEL_WORKERS = 16;

function resolveParallelWorkers() {
  const raw = process.env.HARUYUKI_TEST_PARALLEL;
  if (raw === undefined || raw === "") {
    return Math.min(DEFAULT_PARALLEL_WORKERS, availableParallelism() || 1);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `HARUYUKI_TEST_PARALLEL must be a non-negative integer, got "${raw}"`,
    );
  }
  return parsed;
}

// Turn a test path into a glob that matches it anywhere in the tree, e.g.
// "src/channels/service.test.ts" -> a `**` glob ending in "channels/service.test.ts".
function toIgnoreGlob(testPath) {
  return `**/${testPath.replace(/^src\//, "")}`;
}

function chunkByCommandLength(files, maxChars = 20000) {
  const chunks = [];
  let chunk = [];
  let chars = 0;

  for (const file of files) {
    const nextChars = file.length + 3;
    if (chunk.length > 0 && chars + nextChars > maxChars) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(file);
    chars += nextChars;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function readSelectionShas() {
  const baseIndex = process.argv.indexOf("--base");
  const headIndex = process.argv.indexOf("--head");
  if (baseIndex !== -1 || headIndex !== -1) {
    if (baseIndex === -1 || headIndex === -1) {
      throw new Error("Both --base and --head are required");
    }
    const baseSha = process.argv[baseIndex + 1];
    const headSha = process.argv[headIndex + 1];
    if (!baseSha || !headSha) {
      throw new Error("Both --base and --head are required");
    }
    return { baseSha, headSha };
  }

  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return null;
  }
  if (!process.env.GITHUB_EVENT_PATH) {
    throw new Error("GITHUB_EVENT_PATH is required for pull request selection");
  }
  return readPullRequestShas(process.env.GITHUB_EVENT_PATH);
}

function selectTestFiles() {
  let shas;
  try {
    shas = readSelectionShas();
  } catch (error) {
    console.warn(
      `unit-test impact: running all tests because selection setup failed: ${error.message}`,
    );
    return allTestFiles;
  }

  if (!shas) {
    console.log(
      `unit-test impact: running all ${allTestFiles.length} tests outside a pull request`,
    );
    return allTestFiles;
  }

  try {
    const plan = planUnitTests({
      changedFiles: getGitChangedFiles(shas.baseSha, shas.headSha),
      allTestFiles,
      impactIndex: buildFamilyImpactIndex(),
    });
    console.log(
      `unit-test impact: ${plan.selectedTests.length}/${allTestFiles.length} tests (${plan.reason})`,
    );
    for (const selection of plan.selectedFamilies) {
      const shownReasons = selection.reasons.slice(0, 3);
      const hiddenReasonCount = selection.reasons.length - shownReasons.length;
      const suffix =
        hiddenReasonCount > 0 ? `; +${hiddenReasonCount} more` : "";
      console.log(`  ${selection.family}: ${shownReasons.join("; ")}${suffix}`);
    }
    if (plan.omittedTests.length > 0) {
      console.log(`  omitted: ${plan.omittedTests.length} unrelated tests`);
    }
    return plan.selectedTests;
  } catch (error) {
    console.warn(
      `unit-test impact: running all tests because planning failed: ${error.message}`,
    );
    return allTestFiles;
  }
}

let exitCode = 0;
const shardIndex = process.argv.indexOf("--shard");
const shard =
  shardIndex === -1 ? undefined : (process.argv[shardIndex + 1] ?? "");
// Validate outside selection's full-suite fallback: an invalid shard must fail,
// not make several jobs duplicate the entire suite or silently run nothing.
shardTestFiles([], shard);
// `selectTestFiles()` falls back to `allTestFiles` on every setup failure, so a
// narrowed run is exactly "the selection is shorter than the full discovery set".
// Comparing lengths here is what tells the two apart; deriving it from the batch
// size instead made a single miscounted entry silently switch a whole-suite run
// onto the explicit path list (and back).
const selection = selectTestFiles();
const fullSuite = selection.length === allTestFiles.length;
const selectedTestFiles = shardTestFiles(selection, shard);
if (shard) {
  console.log(`unit-test shard ${shard}: ${selectedTestFiles.length} files`);
}
const selectedTestPaths = new Set(selectedTestFiles);
const parallelWorkers = resolveParallelWorkers();

// Manifest entries for this run's selection. None of them joins the parallel
// batch: the manifest means "this file needs a process of its own", and
// `--parallel` covers only one of the reasons it is used. It isolates the module
// registry, but it does not scope a file's environment (the `env` block) and it
// does not keep the shared preload's test hooks attached to the file under test —
// that hook half is what `channel-route-isolation` pins. The serial escape hatch
// below already runs every entry; this branch now agrees with it.
const isolatedEntries = isolatedTests.filter((entry) =>
  selectedTestPaths.has(entry.path),
);

const runIsolatedPaths = new Set(isolatedEntries.map((entry) => entry.path));
const batchFiles = selectedTestFiles.filter(
  (file) => !runIsolatedPaths.has(file),
);

// Files `bun test --parallel` cannot load — everything that reaches ink — run the way
// the escape hatch runs them: one process, bounded chunks. Handing them to a worker
// does not fail their tests, it *drops* them (no test is registered at all), which is
// why the split is on the file set rather than on the outcome (`test-runtime-groups.cjs`
// has the reproduction).
const runtimeGroups =
  parallelWorkers > 0
    ? partitionTestFilesForParallel({ testFiles: batchFiles })
    : { parallel: batchFiles, serial: [] };
const parallelBatchFiles = runtimeGroups.parallel;
const serialRuntimePaths = runtimeGroups.serial;

if (parallelWorkers > 0) {
  // Every selected entry gets a process of its own before the batch runs; see the
  // note on `isolatedEntries` above for why the parallel batch cannot stand in.
  for (const entry of isolatedEntries) {
    try {
      runTests([entry.path], entry.timeoutMs, entry.env);
    } catch (error) {
      exitCode = error.status ?? 1;
    }
  }

  if (serialRuntimePaths.length > 0) {
    console.log(
      `unit-test runtime: running ${serialRuntimePaths.length} ink-rendering files serially (bun --parallel cannot load them)`,
    );
  }

  // Whole-suite runs use path filters, so the argument list stays far below
  // CreateProcess's 32k limit and bun can balance the files across workers.
  // A narrowed selection (impact analysis, or a shard) is small enough to pass
  // explicitly, which keeps this runner's own shard semantics unchanged.
  const wholeSuite = fullSuite && shard === undefined;
  const targets = wholeSuite ? wholeSuiteTargets : parallelBatchFiles;
  const extraArgs = [`--parallel=${parallelWorkers}`];
  if (wholeSuite) {
    for (const testPath of [...runIsolatedPaths, ...serialRuntimePaths]) {
      extraArgs.push(`--path-ignore-patterns=${toIgnoreGlob(testPath)}`);
    }
  }
  if (parallelBatchFiles.length > 0 || (wholeSuite && runIsolatedPaths.size === 0)) {
    // The manifest's longest registered timeout (30s), so a batch is never
    // stricter than the per-entry timeouts it replaces — matching the behaviour
    // of the chunked serial path, which also ran every shared-process file with
    // relaxed timeouts.
    try {
      runTests(targets, 30000, {}, extraArgs);
    } catch (error) {
      exitCode = error.status ?? 1;
    }
  }

  // These chunks carry the serial runtime group — everything that reaches ink — and
  // they therefore include the slowest suites in the tree. Give them the same budget
  // as the parallel batch above. At 15s a file here hits its budget, abandons the
  // work it started (`listen-model-update` leaves a rejected backend lookup behind),
  // and the process then spins at 100% of a core forever: the run never finishes.
  // Measured on this machine: `listen-model-update.test.ts` passes in ~28s of suite
  // time with a 30s budget and livelocks the chunk with 15s.
  for (const batch of chunkByCommandLength(serialRuntimePaths)) {
    try {
      runTests(batch, 30000);
    } catch (error) {
      exitCode = error.status ?? 1;
    }
  }

  if (
    parallelBatchFiles.length === 0 &&
    runIsolatedPaths.size === 0 &&
    serialRuntimePaths.length === 0
  ) {
    // Nothing was selected and nothing ran. Say so instead of exiting 0 on an
    // empty run (`--shard` with an out-of-range index, or an empty impact plan).
    console.error("unit-test: no test files selected; nothing ran");
    exitCode = 1;
  }
} else {
  // Escape hatch (HARUYUKI_TEST_PARALLEL=0): the original chunked, serial path.
  // Bun module mocks and process-global state are shared within one test
  // process, so the explicitly stateful suites keep their own processes here.
  // This branch must run *every* isolated entry, not only the ones that carry an
  // env block — the parallel branch above cannot cover them once
  // `resolveParallelWorkers()` returns 0.
  for (const entry of isolatedTests.filter((entry) =>
    selectedTestPaths.has(entry.path),
  )) {
    try {
      runTests([entry.path], entry.timeoutMs, entry.env);
    } catch (error) {
      exitCode = error.status ?? 1;
    }
  }

  const sharedProcessTests = selectedTestFiles.filter(
    (file) => !isolatedPaths.has(file),
  );

  // Passing argv directly avoids cmd.exe's shorter shell command-line limit on
  // Windows. Bounded batches also stay below CreateProcess's 32k limit as the
  // suite grows. Same budget as the parallel batch: one chunk runs the whole
  // selection, including the slowest suites, and a timeout here strands work that
  // can spin the process (see the note on the serial runtime chunks above).
  for (const batch of chunkByCommandLength(sharedProcessTests)) {
    try {
      runTests(batch, 30000);
    } catch (error) {
      exitCode = error.status ?? 1;
    }
  }
}

process.exit(exitCode);
