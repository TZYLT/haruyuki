"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const ts = require("typescript");
const { buildFamilyImpactIndex } = require("./unit-test-impact.cjs");

/**
 * Which test files `bun test --parallel` cannot run, and why.
 *
 * `node_modules/ink/build/styles.js` reads `yoga-layout`'s default export while that
 * module is still evaluating. A `--parallel` worker reaches ink's import chain before
 * the binding exists, so every file that touches ink dies with
 * `ReferenceError: Cannot access 'Yoga' before initialization` — and, worse than a
 * failure, it reports **no tests at all**:
 *
 *   bun test --parallel=8 src/cli/components/BtwPane.test.tsx   -> 0 pass, 1 fail, 1 error
 *   bun test              src/cli/components/BtwPane.test.tsx   -> all pass
 *
 * All 46 `*.test.tsx` files behave that way, so a full parallel run silently drops the
 * entire Ink-rendering suite (58 files, one error each, tests never registered). The
 * runner therefore has to keep those files out of the parallel batch and run them the
 * way the escape hatch already does: one process, bounded chunks.
 *
 * Detection is the real import graph, because the reach is transitive — a `.ts` test
 * file reaches ink through the component it imports
 * (`src/cli/message-search-cache-warm.test.ts` is the example), and a name- or
 * directory-based rule would silently miss the next one.
 */
const INK_PACKAGE_PATTERN = /^ink(?:$|-)/u;

/** Bare specifiers a file imports, as written. */
function importedModuleSpecifiers(absolutePath) {
  const preprocessed = ts.preProcessFile(
    readFileSync(absolutePath, "utf8"),
    true,
    true,
  );
  return preprocessed.importedFiles.map((entry) => entry.fileName);
}

/**
 * Source files that import an ink package directly, keyed by repo-relative path.
 *
 * The graph's key set is "every source file", so it is also the file list to scan.
 */
function collectInkImportingFiles(rootDir, fileDependencies) {
  const importing = new Set();
  for (const relativePath of fileDependencies.keys()) {
    for (const specifier of importedModuleSpecifiers(
      join(rootDir, relativePath),
    )) {
      if (INK_PACKAGE_PATTERN.test(specifier)) {
        importing.add(relativePath);
        break;
      }
    }
  }
  return importing;
}

/**
 * Every source file that reaches an ink import, itself included.
 *
 * Walks the edges backwards from the importers: a file reaches ink when one of its
 * dependencies does.
 */
function filesReachingInk(rootDir, fileDependencies) {
  const dependents = new Map();
  for (const [file, dependencies] of fileDependencies) {
    for (const dependency of dependencies) {
      let entries = dependents.get(dependency);
      if (!entries) {
        entries = new Set();
        dependents.set(dependency, entries);
      }
      entries.add(file);
    }
  }

  const reaching = new Set();
  const queue = [...collectInkImportingFiles(rootDir, fileDependencies)];
  for (const file of queue) reaching.add(file);
  while (queue.length > 0) {
    const current = queue.pop();
    for (const dependent of dependents.get(current) ?? []) {
      if (reaching.has(dependent)) continue;
      reaching.add(dependent);
      queue.push(dependent);
    }
  }
  return reaching;
}

/**
 * Split test files by the runtime that can run them.
 *
 * `serial` files must not be handed to `bun test --parallel`; everything else may be.
 * Files outside the graph (the `scripts/*.test.cjs` suites) never reach ink.
 */
function partitionTestFilesForParallel({ testFiles, rootDir = process.cwd() }) {
  if (testFiles.length === 0) return { parallel: [], serial: [] };

  const { fileDependencies } = buildFamilyImpactIndex(rootDir);
  const reaching = filesReachingInk(rootDir, fileDependencies);
  const serial = [];
  const parallel = [];
  for (const testFile of testFiles) {
    if (reaching.has(testFile)) {
      serial.push(testFile);
    } else {
      parallel.push(testFile);
    }
  }
  return { parallel, serial };
}

module.exports = {
  partitionTestFilesForParallel,
};
