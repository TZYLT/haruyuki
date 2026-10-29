/**
 * Parser tests for the reference extractor (M5 #12/#13).
 *
 * The extractor is the only source of the shipped `reference-index.md`, so a
 * silently dropped router case means a command that appears in the product but
 * not in the bundled reference. These tests pin both the real router row count
 * and the shapes the parser used to drop: a multi-line dynamic import and a
 * case without a `return`.
 *
 * Run with `bun test scripts/extract-haruyuki-reference.test.mjs`; the repo's
 * unit-test runner only selects `src/` tests, so this file is focused-run.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSubcommandCases } from "./extract-haruyuki-reference.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const ROUTER_PATH = "src/cli/subcommands/router.ts";

function synthetic(body) {
  return `export async function runSubcommand(argv) {\n  const [command, ...rest] = argv;\n  switch (command) {\n${body}\n  }\n}\n`;
}

test("the real router yields all 23 subcommands", () => {
  const source = readFileSync(path.join(REPOSITORY_ROOT, ROUTER_PATH), "utf8");
  const cases = parseSubcommandCases(source);

  expect(cases).toHaveLength(23);
  expect(new Set(cases.map((entry) => entry.command)).size).toBe(23);
});

test("aliases and their router notes stay grouped", () => {
  const source = readFileSync(path.join(REPOSITORY_ROOT, ROUTER_PATH), "utf8");
  const cases = parseSubcommandCases(source);
  const memory = cases.find((entry) => entry.command === "memory");

  expect(memory?.aliases).toEqual(["memfs"]);
  expect(memory?.notes).toEqual(["legacy alias"]);
});

test("a multi-line dynamic import delegation is parsed, not dropped", () => {
  const source = synthetic(
    [
      '    case "snapshot":',
      "      return (",
      '        await import("./snapshot/cli")',
      "      ).runSnapshotSubcommand(rest);",
      '    case "schedule": // legacy alias',
      '      return (await import("./schedule")).runScheduleSubcommand(rest);',
    ].join("\n"),
  );
  const cases = parseSubcommandCases(source);

  expect(cases).toHaveLength(2);
  expect(cases[0]).toMatchObject({
    command: "snapshot",
    module: "src/cli/subcommands/snapshot/cli.ts",
    runner: "runSnapshotSubcommand",
  });
  expect(cases[1]).toMatchObject({
    command: "schedule",
    module: "src/cli/subcommands/schedule.ts",
    runner: "runScheduleSubcommand",
    notes: ["legacy alias"],
  });
});

test("a case with statements but no return throws instead of vanishing", () => {
  const source = synthetic(
    [
      '    case "half-done":',
      '      console.error("not implemented");',
      '    case "version":',
      "      return runVersionSubcommand();",
    ].join("\n"),
  );

  expect(() => parseSubcommandCases(source)).toThrow(/Unrecognized case body/);
});

test("an unrecognized return shape throws instead of vanishing", () => {
  const source = synthetic(
    ['    case "early":', "      return true;"].join("\n"),
  );

  expect(() => parseSubcommandCases(source)).toThrow(/Unrecognized case body/);
});

test("help anchors cite the real usage block (M5 #13)", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "scripts/extract-haruyuki-reference.mjs",
      "--stdout",
    ],
    cwd: REPOSITORY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  const markdown = result.stdout.toString("utf8");
  // export/import delegate through a router helper: the anchor follows it to
  // the actual usage formatter instead of citing the wrapper.
  expect(markdown).toContain(
    "| `haruyuki export` | — | `--out`, `--with-project`, `--dry-run`, `--json`, `--verbose`, `--yes`, `--help` | `src/cli/subcommands/snapshot/cli.ts:",
  );
  expect(markdown).toContain(
    "| `haruyuki import` | — | `--from`, `--with-project`, `--verify`, `--json`, `--verbose`, `--yes`, `--help` | `src/cli/subcommands/snapshot/cli.ts:",
  );
  // `schedule` keeps its help in `const USAGE`, which the literal scan missed.
  expect(markdown).toMatch(
    /\| `haruyuki schedule` \| — \| — \| `src\/cli\/subcommands\/schedule\.ts:\d+`/,
  );
});
