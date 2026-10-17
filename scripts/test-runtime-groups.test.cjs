"use strict";

const { describe, expect, test } = require("bun:test");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { partitionTestFilesForParallel } = require("./test-runtime-groups.cjs");

/**
 * The parallel-batch split, at the level the runner uses it.
 *
 * The split decides whether a file's tests *run at all*: `bun test --parallel` cannot
 * load ink (yoga-layout's default export is read before it exists), and a file it
 * cannot load reports zero tests instead of a failure. So the graph walk is pinned
 * here, including the transitive case that a directory- or name-based rule would miss.
 */

function writeFixture(root, relativePath, contents) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function createFixture(configure) {
  const root = mkdtempSync(join(tmpdir(), "test-runtime-groups-"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
      },
    }),
  );
  configure(root);
  return root;
}

describe("partitionTestFilesForParallel", () => {
  test("routes a file that reaches ink transitively to the serial path", () => {
    const root = createFixture((dir) => {
      writeFixture(
        dir,
        "src/ui/widget.ts",
        'import { Box } from "ink";\nexport const widget = Box;\n',
      );
      writeFixture(
        dir,
        "src/ui/screen.ts",
        'import { widget } from "./widget";\nexport const screen = widget;\n',
      );
      writeFixture(
        dir,
        "src/ui/screen.test.ts",
        'import { screen } from "./screen";\nexport const value = screen;\n',
      );
      // Wrapper-free siblings stay parallel: the graph walk must not over-select.
      writeFixture(dir, "src/core/util.ts", "export const util = 1;\n");
      writeFixture(
        dir,
        "src/core/util.test.ts",
        'import { util } from "./util";\nexport const value = util;\n',
      );
      writeFixture(
        dir,
        "src/ui/plain.test.tsx",
        'import { Box } from "ink";\nexport const value = Box;\n',
      );
    });

    try {
      const { parallel, serial } = partitionTestFilesForParallel({
        rootDir: root,
        testFiles: [
          "src/core/util.test.ts",
          "src/ui/plain.test.tsx",
          "src/ui/screen.test.ts",
        ],
      });

      expect(serial.sort()).toEqual([
        "src/ui/plain.test.tsx",
        "src/ui/screen.test.ts",
      ]);
      expect(parallel).toEqual(["src/core/util.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves files outside the source graph in the parallel batch", () => {
    const root = createFixture((dir) => {
      writeFixture(dir, "src/core/util.ts", "export const util = 1;\n");
      writeFixture(dir, "src/core/util.test.ts", "export const value = 1;\n");
    });

    try {
      expect(
        partitionTestFilesForParallel({
          rootDir: root,
          // The runner's script suites live outside `src`, so the graph has no entry
          // for them and they must not be dragged into a serial process.
          testFiles: [
            "src/core/util.test.ts",
            "scripts/unit-test-impact.test.cjs",
          ],
        }),
      ).toEqual({
        parallel: [
          "src/core/util.test.ts",
          "scripts/unit-test-impact.test.cjs",
        ],
        serial: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is empty for an empty selection", () => {
    expect(partitionTestFilesForParallel({ testFiles: [] })).toEqual({
      parallel: [],
      serial: [],
    });
  });
});
