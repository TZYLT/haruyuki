/**
 * `/recall` coverage: what it accepts, what it refuses, and the one semantic that
 * matters most — `/recall now` is a probe that leaves the dedup window exactly as
 * it found it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { recallIndexPath } from "@/backend/local/recall-index";
import {
  formatRecallSettingsLine,
  handleRecallCommand,
  parseRecallCommand,
  parseRecallCount,
  parseRecallRatio,
  RECALL_COMMAND_USAGE,
} from "@/cli/commands/recall";
import { readRecallSettings } from "@/recall-settings";
import {
  RECALL_BREAKER_THRESHOLD,
  readRecallRuntimeStatus,
  recallBreakerTripped,
  recordRecallDecision,
  resetRecallRuntime,
} from "@/reminders/recall-runtime";
import { settingsManager } from "@/settings-manager";
import {
  conversationDirFor,
  RECALL_FIXTURE_QUERY,
  withRecallFixture,
} from "@/test-utils/recall-fixture";

describe("parsing a /recall invocation", () => {
  test("no arguments and help both print the usage", () => {
    expect(parseRecallCommand([])).toEqual({ kind: "usage" });
    expect(parseRecallCommand(["help"])).toEqual({ kind: "usage" });
  });

  test("accepts every documented setting", () => {
    expect(parseRecallCommand(["on"])).toEqual({ kind: "enable" });
    expect(parseRecallCommand(["off"])).toEqual({ kind: "disable" });
    expect(parseRecallCommand(["status"])).toEqual({ kind: "status" });
    expect(parseRecallCommand(["build"])).toEqual({ kind: "build" });
    expect(parseRecallCommand(["now", "how", "did", "we", "bill"])).toEqual({
      kind: "probe",
      query: "how did we bill",
    });
    expect(parseRecallCommand(["timeout", "0"])).toMatchObject({
      kind: "set",
      updates: { recallTimeoutMs: 0 },
    });
    expect(parseRecallCommand(["dedup", "25"])).toMatchObject({
      updates: { recallDedupTurns: 25 },
    });
    expect(parseRecallCommand(["limit", "5"])).toMatchObject({
      updates: { recallLimit: 5 },
    });
    expect(parseRecallCommand(["excerpt", "3"])).toMatchObject({
      updates: { recallExcerptLines: 3 },
    });
    expect(parseRecallCommand(["ratio", "0.5"])).toMatchObject({
      updates: { recallMinScoreRatio: 0.5 },
    });
    expect(parseRecallCommand(["diversity", "split"])).toMatchObject({
      updates: { recallDiversity: "split" },
    });
    expect(parseRecallCommand(["display", "full"])).toMatchObject({
      updates: { recallDisplay: "full" },
    });
  });

  test("chars takes one or both budgets", () => {
    expect(parseRecallCommand(["chars", "200"])).toMatchObject({
      updates: { recallExcerptCharacters: 200 },
    });
    expect(parseRecallCommand(["chars", "200", "900"])).toMatchObject({
      updates: {
        recallExcerptCharacters: 200,
        recallTotalCharacters: 900,
      },
    });
    expect(parseRecallCommand(["chars", "200", "900", "1"])).toMatchObject({
      kind: "error",
    });
    expect(parseRecallCommand(["chars"])).toMatchObject({ kind: "error" });
  });

  test("refuses a value it cannot use instead of guessing", () => {
    for (const args of [
      ["timeout"],
      ["timeout", "soon"],
      ["timeout", "-1"],
      ["timeout", "1.5"],
      ["dedup"],
      ["limit", "many"],
      ["excerpt", ""],
      ["ratio"],
      ["ratio", "1.5"],
      ["ratio", "high"],
      ["diversity"],
      ["diversity", "every-file"],
      ["display"],
      ["display", "quiet"],
      ["now"],
      ["nonsense"],
      ["status", "extra"],
      ["on", "extra"],
      ["build", "extra"],
    ]) {
      expect(parseRecallCommand(args).kind).toBe("error");
    }
  });

  test("the two number parsers agree with the commands that use them", () => {
    expect(parseRecallCount("0")).toBe(0);
    expect(parseRecallCount(" 12 ")).toBe(12);
    expect(parseRecallCount(undefined)).toBeNull();
    expect(parseRecallCount("")).toBeNull();
    expect(parseRecallCount("-1")).toBeNull();
    expect(parseRecallCount("1e3")).toBeNull();
    expect(parseRecallRatio("0")).toBe(0);
    expect(parseRecallRatio("1")).toBe(1);
    expect(parseRecallRatio("0.35")).toBeCloseTo(0.35);
    expect(parseRecallRatio("1.01")).toBeNull();
    expect(parseRecallRatio("-0.1")).toBeNull();
    expect(parseRecallRatio("half")).toBeNull();
  });
});

describe("the /recall handlers", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    resetRecallRuntime();
    testHomeDir = await mkdtemp(join(tmpdir(), "haru-recall-command-"));
    process.env.HOME = testHomeDir;
    await settingsManager.reset();
    await settingsManager.initialize();
  });

  afterEach(async () => {
    resetRecallRuntime();
    __testSetBackend(null);
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  test("writes a setting and reports the effective parameters", async () => {
    const output = await handleRecallCommand(["limit", "250"]);
    expect(output).toContain("Updated limit.");
    expect(output).toContain("limit 250");
    expect(readRecallSettings().limit).toBe(250);
    expect(output).toBe(
      `Updated limit.\n  ${formatRecallSettingsLine(readRecallSettings())}`,
    );
  });

  test("off stops the search, and on also clears the breaker", async () => {
    await handleRecallCommand(["off"]);
    expect(readRecallSettings().enabled).toBe(false);

    for (let index = 0; index < RECALL_BREAKER_THRESHOLD; index += 1) {
      recordRecallDecision({
        entries: [],
        status: "failed",
        reason: "boom",
        diagnostics: { threshold: 0, candidates: 0, sources: [] },
      });
    }
    expect(recallBreakerTripped()).toBe(true);

    // `on` is the only recovery the requirement allows (《26》§6.6), and it has to
    // clear the in-memory trip as well as the setting.
    const output = await handleRecallCommand(["on"]);
    expect(output).toContain("Passive recall is on.");
    expect(readRecallSettings().enabled).toBe(true);
    expect(recallBreakerTripped()).toBe(false);
    expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);
  });

  test("a bad argument comes back with the usage", async () => {
    const output = await handleRecallCommand(["display", "loud"]);
    expect(output).toContain("silent, summary, full");
    expect(output.endsWith(RECALL_COMMAND_USAGE)).toBe(true);
  });

  test("status reports the store it can see", async () => {
    await withRecallFixture(async (fixture) => {
      const output = await handleRecallCommand(["status"], undefined, {
        backend: fixture.backend,
      });
      expect(output).toContain("Recall: on");
      expect(output).toContain("Breaker: healthy");
      expect(output).toContain("conversations indexed");
      expect(output).toContain("Settings: limit 3");
    });
  });

  test("build indexes what is missing", async () => {
    await withRecallFixture(async (fixture) => {
      const historyDir = join(
        fixture.storageDir,
        "conversations",
        fixture.historyDirectory,
      );
      await rm(recallIndexPath(historyDir), { force: true });

      const output = await handleRecallCommand(["build"], undefined, {
        backend: fixture.backend,
      });
      expect(output).toMatch(
        /Indexed \d+\/\d+ conversations? · \d+ records? · \d+ms/,
      );

      // The sidecar is back, so the next status reports full coverage and no
      // "run build" hint.
      const status = await handleRecallCommand(["status"], undefined, {
        backend: fixture.backend,
      });
      expect(status).toContain("conversations indexed");
      expect(status).not.toContain("without an index");
    });
  });

  test("now prints the passages and leaves the dedup window alone", async () => {
    await withRecallFixture(async (fixture) => {
      const output = await handleRecallCommand(
        ["now", RECALL_FIXTURE_QUERY],
        {
          agentId: fixture.agentId,
          conversationId: fixture.currentConversationId,
        },
        { backend: fixture.backend },
      );

      expect(output).toContain("Recall found");
      expect(output).toContain("每日对账");
      expect(output).toContain("earlier conversation");

      // The whole point of the probe: asking what recall can find must not change
      // what the next turn injects.
      const directory = await conversationDirFor(
        fixture.storageDir,
        fixture.currentConversationId,
      );
      const record = JSON.parse(
        await readFile(join(directory, "conversation.json"), "utf8"),
      ) as {
        context_management?: { recall_injected_turns?: Record<string, number> };
      };
      expect(record.context_management?.recall_injected_turns).toBeUndefined();
    });
  });

  test("now refuses without an agent", async () => {
    await withRecallFixture(async (fixture) => {
      const output = await handleRecallCommand(["now", "anything"], undefined, {
        backend: fixture.backend,
      });
      expect(output).toContain("needs an active agent");
    });
  });

  test("a cloud backend gets the local-only answer", async () => {
    const output = await handleRecallCommand(["status"], undefined, {
      backend: new FakeHeadlessBackend(),
    });
    expect(output).toContain("local-backend only");
  });
});
