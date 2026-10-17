#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TESTS_DIR_ENV = "HARUYUKI_MOCK_ISOLATION_TESTS_DIR";
const SOURCE_DIR_ENV = "HARUYUKI_MOCK_ISOLATION_SOURCE_DIR";

const rootDir = process.cwd();
const scriptDir = dirname(fileURLToPath(import.meta.url));
const testsDir = process.env[TESTS_DIR_ENV]
  ? resolve(process.env[TESTS_DIR_ENV])
  : join(rootDir, "src");
// Helpers are scanned too: a shared test helper that installs module mocks cannot be
// registered in `isolated-unit-tests.json` (it is not a test file), so the rules that
// keep one file's mocks from breaking another have to reach it as well.
const sourceDir = process.env[SOURCE_DIR_ENV]
  ? resolve(process.env[SOURCE_DIR_ENV])
  : join(rootDir, "src");
const isolationManifest = JSON.parse(
  readFileSync(join(scriptDir, "isolated-unit-tests.json"), "utf8"),
);
const ISOLATED_TEST_FILES = new Set(
  isolationManifest.tests.map((entry) => entry.path),
);

const FORBIDDEN_MOCK_MODULES = new Map([
  [
    "/channels/config",
    "Use __testOverrideChannelsRoot() instead of replacing the shared channel config module.",
  ],
  [
    "/agent/context",
    "Use explicit env/context override seams instead of mocking the shared agent context module.",
  ],
  [
    "/runtime-context",
    "Use RuntimeContextSnapshot builders/overrides instead of mocking the shared runtime context module.",
  ],
  [
    "/settings-manager",
    "Use settings temp files or test override helpers instead of mocking the singleton settings manager.",
  ],
]);

const COMPLETE_EXPORT_MOCK_MODULES = new Set([
  "/channels/slack/runtime",
  "/channels/telegram/runtime",
  "/channels/discord/runtime",
]);

const mockModulePattern = /\bmock\.module\s*\(\s*(["'`])([^"'`]+)\1/g;
const restoreHookPattern =
  /\bafter(?:All|Each)\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>[\s\S]*?\bmock\.restore\s*\(/m;
const restoreHookFunctionPattern =
  /\bafter(?:All|Each)\s*\(\s*function\b[\s\S]*?\bmock\.restore\s*\(/m;

function collectTestFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

/** Every TypeScript source file, tests included: helpers install mocks too. */
function collectSourceFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeModuleSpecifier(moduleSpecifier) {
  return moduleSpecifier
    .replaceAll("\\", "/")
    .replace(/\.(?:ts|tsx|js|jsx)$/u, "");
}

function moduleMatches(moduleSpecifier, suffixes) {
  const normalized = normalizeModuleSpecifier(moduleSpecifier);
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix)) {
      return suffix;
    }
  }
  return null;
}

function isRelativeInternalModule(moduleSpecifier) {
  return (
    moduleSpecifier.startsWith("../") ||
    moduleSpecifier.startsWith("./") ||
    moduleSpecifier.startsWith("@/")
  );
}

function lineAndColumn(sourceText, index) {
  const before = sourceText.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function isTopLevelMockCall(sourceText, index) {
  const lineStart = sourceText.lastIndexOf("\n", index - 1) + 1;
  return lineStart === index;
}

function isLineCommentMatch(sourceText, index) {
  const lineStart = sourceText.lastIndexOf("\n", index - 1) + 1;
  const linePrefix = sourceText.slice(lineStart, index);
  return linePrefix.includes("//");
}

function isInsideQuotedText(sourceText, index) {
  let quote = null;
  let escaped = false;

  for (let i = 0; i < index; i += 1) {
    const char = sourceText[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    }
  }

  return quote !== null;
}

function findMatchingParen(sourceText, openParenIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openParenIndex; i < sourceText.length; i += 1) {
    const char = sourceText[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractMockCallText(sourceText, index) {
  const openParenIndex = sourceText.indexOf("(", index);
  if (openParenIndex === -1) {
    return "";
  }
  const closeParenIndex = findMatchingParen(sourceText, openParenIndex);
  if (closeParenIndex === -1) {
    return sourceText.slice(index);
  }
  return sourceText.slice(index, closeParenIndex + 1);
}

const FUNCTION_LIKE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/**
 * Whether the module itself awaits, rather than a function inside it.
 *
 * `bun test --parallel` runs each file in a worker that can start the file's hooks
 * and tests while a top-level `await` is still resolving. A file that also calls
 * `mock.module()` is hit hardest: the mock factories and the hooks that clean them up
 * are written against module-scope state that a suspended evaluation has not reached
 * yet, and a hoisted `function` declaration makes them reachable anyway.
 * `src/channels/slack/adapter-test-harness.ts` broke seven files that way — every
 * test failed on `Cannot access 'fetchMock' before initialization` — and the fix was
 * to load the mocked modules synchronously. A registered isolated test is exempt: it
 * runs in a process of its own, where nothing races the evaluation.
 */
function hasTopLevelAwait(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    // `setParentNodes`, because the walk below climbs to the module scope to tell a
    // top-level await from one inside a callback.
    true,
  );
  let found = false;

  const visit = (node) => {
    if (found) return;
    if (ts.isAwaitExpression(node)) {
      let current = node.parent;
      let insideFunction = false;
      while (current && current !== sourceFile) {
        if (FUNCTION_LIKE_KINDS.has(current.kind)) {
          insideFunction = true;
          break;
        }
        current = current.parent;
      }
      if (!insideFunction) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function resolveMockTargetPath(filePath, moduleSpecifier) {
  const basePath = resolve(dirname(filePath), moduleSpecifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    join(basePath, "index.ts"),
    join(basePath, "index.tsx"),
    join(basePath, "index.js"),
    join(basePath, "index.jsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getExportedNames(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const exportedNames = new Set();

  for (const match of sourceText.matchAll(
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) exportedNames.add(match[1]);
  }
  for (const match of sourceText.matchAll(
    /\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) exportedNames.add(match[1]);
  }
  for (const match of sourceText.matchAll(/\bexport\s*{([^}]+)}/g)) {
    const specifiers = match[1]?.split(",") ?? [];
    for (const specifier of specifiers) {
      const cleaned = specifier.trim();
      if (!cleaned || cleaned.startsWith("type ")) continue;
      const aliasMatch = cleaned.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const nameMatch = cleaned.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)/);
      const exportedName = aliasMatch?.[1] ?? nameMatch?.[1];
      if (exportedName) exportedNames.add(exportedName);
    }
  }

  return exportedNames;
}

function getMockedObjectKeys(mockCallText) {
  const keys = new Set();
  const arrowObjectIndex = mockCallText.indexOf("=> ({");
  const objectStartIndex =
    arrowObjectIndex === -1
      ? mockCallText.indexOf("return {")
      : mockCallText.indexOf("{", arrowObjectIndex);
  if (objectStartIndex === -1) {
    return keys;
  }

  let depth = 0;
  let quote = null;
  let escaped = false;
  let keyCandidate = "";
  let readingKey = false;

  for (let i = objectStartIndex; i < mockCallText.length; i += 1) {
    const char = mockCallText[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      readingKey = depth === 1;
      keyCandidate = "";
      continue;
    }
    if (char === "}") {
      depth -= 1;
      readingKey = depth === 1;
      keyCandidate = "";
      if (depth <= 0) break;
      continue;
    }

    if (depth !== 1) {
      continue;
    }

    if (char === ",") {
      readingKey = true;
      keyCandidate = "";
      continue;
    }

    if (!readingKey) {
      continue;
    }

    if (char === ":") {
      const key = keyCandidate.trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(key)) {
        keys.add(key);
      }
      readingKey = false;
      keyCandidate = "";
      continue;
    }

    keyCandidate += char;
  }

  return keys;
}

const failures = [];

/** Tests first (the manifest is keyed by test path), then every other source file. */
function collectScanFiles() {
  const files = new Set(collectTestFiles(testsDir));
  for (const file of collectSourceFiles(sourceDir)) files.add(file);
  return [...files].sort();
}

for (const filePath of collectScanFiles()) {
  const sourceText = readFileSync(filePath, "utf8");
  // Cheap gate: only a file that installs a module mock is subject to any rule here,
  // and the helper scan otherwise reads every source file in the repo.
  if (!sourceText.includes("mock.module(")) continue;
  const mockedModules = Array.from(
    sourceText.matchAll(mockModulePattern),
  ).filter(
    (match) =>
      !isLineCommentMatch(sourceText, match.index ?? 0) &&
      !isInsideQuotedText(sourceText, match.index ?? 0),
  );

  if (mockedModules.length === 0) continue;

  const relativePath = relative(rootDir, filePath).replaceAll("\\", "/");
  const isTestFile = /\.test\.tsx?$/u.test(filePath);
  const isRegistered = ISOLATED_TEST_FILES.has(relativePath);

  if (!isRegistered && hasTopLevelAwait(sourceText, filePath)) {
    failures.push({
      type: "top-level-await-mock",
      filePath: relativePath,
      mockedModules: mockedModules.map(
        (match) => match[2] ?? "<dynamic module>",
      ),
    });
  }

  // The remaining rules are about how one *test file* mocks; a helper is not a test
  // file and cannot be registered, so only the rule above applies to it.
  if (!isTestFile) continue;

  const hasRestoreHook =
    restoreHookPattern.test(sourceText) ||
    restoreHookFunctionPattern.test(sourceText);
  if (!hasRestoreHook) {
    failures.push({
      type: "missing-restore",
      filePath: relativePath,
      mockedModules: mockedModules.map(
        (match) => match[2] ?? "<dynamic module>",
      ),
    });
  }

  for (const match of mockedModules) {
    const moduleSpecifier = match[2] ?? "<dynamic module>";
    const location = lineAndColumn(sourceText, match.index ?? 0);
    const forbiddenSuffix = moduleMatches(
      moduleSpecifier,
      FORBIDDEN_MOCK_MODULES.keys(),
    );
    if (forbiddenSuffix) {
      failures.push({
        type: "forbidden-module",
        filePath: relativePath,
        location,
        moduleSpecifier,
        reason: FORBIDDEN_MOCK_MODULES.get(forbiddenSuffix),
      });
    }

    if (
      isRelativeInternalModule(moduleSpecifier) &&
      isTopLevelMockCall(sourceText, match.index ?? 0)
    ) {
      if (!isRegistered) {
        failures.push({
          type: "top-level-mock",
          filePath: relativePath,
          location,
          moduleSpecifier,
        });
      }
    }

    const completeMockSuffix = moduleMatches(
      moduleSpecifier,
      COMPLETE_EXPORT_MOCK_MODULES,
    );
    if (completeMockSuffix) {
      const targetPath = resolveMockTargetPath(filePath, moduleSpecifier);
      if (!targetPath) continue;

      const exportedNames = getExportedNames(targetPath);
      const mockCallText = extractMockCallText(sourceText, match.index ?? 0);
      const mockedKeys = getMockedObjectKeys(mockCallText);
      const missingExports = [...exportedNames].filter(
        (exportedName) => !mockedKeys.has(exportedName),
      );
      if (missingExports.length > 0) {
        failures.push({
          type: "partial-runtime-mock",
          filePath: relativePath,
          location,
          moduleSpecifier,
          missingExports,
        });
      }
    }
  }
}

if (failures.length > 0) {
  console.error("❌ Found unsafe Bun mock.module() usage.\n");

  for (const failure of failures) {
    switch (failure.type) {
      case "missing-restore":
        console.error(`- ${failure.filePath}`);
        console.error(
          "  missing: top-level afterEach/afterAll mock.restore() hook",
        );
        console.error(`  mocked modules: ${failure.mockedModules.join(", ")}`);
        break;
      case "forbidden-module":
        console.error(
          `- ${failure.filePath}:${failure.location.line}:${failure.location.column}`,
        );
        console.error(
          `  forbidden shared module mock: ${failure.moduleSpecifier}`,
        );
        console.error(`  ${failure.reason}`);
        break;
      case "top-level-mock":
        console.error(
          `- ${failure.filePath}:${failure.location.line}:${failure.location.column}`,
        );
        console.error(
          `  unsafe top-level internal module mock: ${failure.moduleSpecifier}`,
        );
        console.error(
          "  Top-level mock.module() calls are active while Bun loads other test files. Move the mock into the test/beforeEach, use dependency injection, or register a justified standalone process in scripts/isolated-unit-tests.json.",
        );
        break;
      case "partial-runtime-mock":
        console.error(
          `- ${failure.filePath}:${failure.location.line}:${failure.location.column}`,
        );
        console.error(
          `  partial channel runtime mock: ${failure.moduleSpecifier}`,
        );
        console.error(
          `  missing exports: ${failure.missingExports.join(", ")}`,
        );
        console.error(
          "  Runtime module mocks must include every runtime export so later imports do not fail with missing ESM exports.",
        );
        break;
      case "top-level-await-mock":
        console.error(`- ${failure.filePath}`);
        console.error(
          "  mock.module() in a module that also awaits at the top level",
        );
        console.error(`  mocked modules: ${failure.mockedModules.join(", ")}`);
        console.error(
          "  bun test --parallel can run this module's hooks and tests while the await is still resolving, so module-scope state they close over is uninitialized (Cannot access 'x' before initialization). Load the mocked modules synchronously (require), move the await into a function, or register the file as an isolated test.",
        );
        break;
    }
  }

  console.error(
    "\nWhy this fails: Bun module mocks are process-global and can leak across files in the shared module cache.",
  );
  console.error(
    "Prefer explicit test override helpers or dependency injection. If a module mock is unavoidable, keep it scoped and restore it with afterEach(); top-level mocks must also run in an isolated process.",
  );
  process.exit(1);
}

console.log("✅ No unsafe mock.module() usage found.");
