import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageLedger, usageLedgerPath } from "@/usage/ledger";
import {
  PARENT_CONVERSATION_ENV,
  USAGE_RUN_ID_ENV,
  USAGE_SOURCE_ENV,
} from "@/utils/subagent-launch-marker";
import {
  automatedUsageOutcomeOf,
  isAutomatedUsageSource,
  readAutomatedUsageTag,
  recordAutomatedTurnUsage,
  recordAutomatedUsage,
  recordTimedOutReflectionRun,
} from "./automated";

const tempRoots: string[] = [];
const originalHome = process.env.HARUYUKI_HOME;

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HARUYUKI_HOME;
  } else {
    process.env.HARUYUKI_HOME = originalHome;
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "haruyuki-automated-usage-"));
  tempRoots.push(root);
  process.env.HARUYUKI_HOME = root;
  return root;
}

const TAGGED_ENV: NodeJS.ProcessEnv = {
  [USAGE_SOURCE_ENV]: "reflection",
  [USAGE_RUN_ID_ENV]: "reflection-agent-1-abc",
  [PARENT_CONVERSATION_ENV]: "local-conv-1",
};

const TOKENS = {
  prompt: 1_000,
  cachedInput: 3_000,
  cacheWrite: 200,
  completion: 500,
  reasoning: 100,
  steps: 2,
};

describe("the automated-run env tag", () => {
  test("a tagged child knows its source, run and parent conversation", () => {
    expect(readAutomatedUsageTag(TAGGED_ENV)).toEqual({
      source: "reflection",
      runId: "reflection-agent-1-abc",
      parentSessionId: "local-conv-1",
    });
  });

  test("an untagged child records nothing", () => {
    expect(readAutomatedUsageTag({})).toBeUndefined();
    expect(readAutomatedUsageTag({ [USAGE_SOURCE_ENV]: "  " })).toBeUndefined();
  });

  test("an unknown or interactive source is not an automated tag", () => {
    expect(isAutomatedUsageSource("reflection")).toBe(true);
    // `interactive` is the TUI's own writer; a child must never claim it.
    expect(isAutomatedUsageSource("interactive")).toBe(false);
    expect(isAutomatedUsageSource("bogus")).toBe(false);
    expect(
      readAutomatedUsageTag({ [USAGE_SOURCE_ENV]: "bogus" }),
    ).toBeUndefined();
  });

  test("the run id is optional, the source is not", () => {
    expect(readAutomatedUsageTag({ [USAGE_SOURCE_ENV]: "dream" })).toEqual({
      source: "dream",
    });
  });
});

describe("recordAutomatedUsage", () => {
  test("writes one tagged row with the child's own numbers", async () => {
    await makeTempRoot();
    expect(
      await recordAutomatedUsage({
        source: "reflection",
        outcome: "completed",
        runId: "reflection-agent-1-abc",
        sessionId: "local-conv-2",
        parentSessionId: "local-conv-1",
        agentId: "agent-1",
        model: "openai/gpt-5.5",
        usage: TOKENS,
        wallMs: 4_000,
        apiMs: 3_000,
        contextTokens: 84_000,
      }),
    ).toBe(true);

    const [record] = await readUsageLedger();
    expect(record?.source).toBe("reflection");
    expect(record?.outcome).toBe("completed");
    expect(record?.runId).toBe("reflection-agent-1-abc");
    expect(record?.sessionId).toBe("local-conv-2");
    expect(record?.parentSessionId).toBe("local-conv-1");
    expect(record?.agentId).toBe("agent-1");
    expect(record?.model).toBe("openai/gpt-5.5");
    expect(record?.prompt).toBe(1_000);
    expect(record?.cachedInput).toBe(3_000);
    expect(record?.cacheWrite).toBe(200);
    expect(record?.completion).toBe(500);
    expect(record?.reasoning).toBe(100);
    expect(record?.steps).toBe(2);
    expect(record?.wallMs).toBe(4_000);
    expect(record?.contextTokens).toBe(84_000);
  });

  test("a missing model or agent is recorded as unknown, not dropped", async () => {
    await makeTempRoot();
    await recordAutomatedUsage({
      source: "dream",
      outcome: "failed",
      sessionId: "local-conv-9",
      agentId: "   ",
      model: "",
      usage: TOKENS,
      wallMs: 1,
      apiMs: 0,
    });
    const [record] = await readUsageLedger();
    expect(record?.agentId).toBe("unknown");
    expect(record?.model).toBe("unknown");
    expect(record?.source).toBe("dream");
    // Failures are recorded too: money spent is money spent (§5.16.4).
    expect(record?.outcome).toBe("failed");
    expect(record?.runId).toBeUndefined();
    expect(record?.parentSessionId).toBeUndefined();
  });
});

describe("recordTimedOutReflectionRun (the row only the parent can write)", () => {
  test("records the ending with zero tokens and the run coordinates", async () => {
    await makeTempRoot();

    expect(
      await recordTimedOutReflectionRun({
        runId: "reflection-agent-1-timeout",
        agentId: "agent-1",
        sessionId: "local-conv-2",
        parentSessionId: "local-conv-1",
        model: "openai/gpt-5.5",
        wallMs: 180_400.6,
      }),
    ).toBe(true);

    const [record] = await readUsageLedger();
    expect(record?.source).toBe("reflection");
    expect(record?.outcome).toBe("timeout");
    expect(record?.runId).toBe("reflection-agent-1-timeout");
    expect(record?.sessionId).toBe("local-conv-2");
    expect(record?.parentSessionId).toBe("local-conv-1");
    expect(record?.agentId).toBe("agent-1");
    expect(record?.model).toBe("openai/gpt-5.5");
    // The parent never sees the child's counters: the marker is zero by design.
    expect(record?.prompt).toBe(0);
    expect(record?.completion).toBe(0);
    expect(record?.steps).toBe(0);
    expect(record?.wallMs).toBe(180_401);
  });
});

describe("recordAutomatedTurnUsage", () => {
  test("an ordinary headless session writes nothing", async () => {
    await makeTempRoot();
    expect(
      await recordAutomatedTurnUsage({
        env: {},
        agentId: "agent-1",
        model: "m",
        sessionId: "conv-1",
        outcome: "completed",
        usage: TOKENS,
        wallMs: 1,
        apiMs: 0,
      }),
    ).toBe(false);
    // No ledger file at all: the caller is not an automated run, and the
    // interactive writer owns its spend.
    await expect(readFile(usageLedgerPath(), "utf8")).rejects.toThrow();
    expect(await readUsageLedger()).toEqual([]);
  });

  test("a tagged turn writes the row the parent will read", async () => {
    await makeTempRoot();
    expect(
      await recordAutomatedTurnUsage({
        env: TAGGED_ENV,
        agentId: "agent-1",
        model: "m",
        sessionId: "local-conv-2",
        outcome: "completed",
        usage: TOKENS,
        wallMs: 4_000,
        apiMs: 3_000,
        contextTokens: 84_000,
      }),
    ).toBe(true);
    const [record] = await readUsageLedger();
    expect(record?.source).toBe("reflection");
    expect(record?.runId).toBe("reflection-agent-1-abc");
    expect(record?.sessionId).toBe("local-conv-2");
    expect(record?.parentSessionId).toBe("local-conv-1");
  });

  test("an interrupted automated turn is recorded as cancelled", async () => {
    await makeTempRoot();
    await recordAutomatedTurnUsage({
      env: TAGGED_ENV,
      agentId: "agent-1",
      model: "m",
      sessionId: "local-conv-2",
      outcome: "cancelled",
      usage: TOKENS,
      wallMs: 1,
      apiMs: 0,
    });
    const [record] = await readUsageLedger();
    expect(record?.outcome).toBe("cancelled");
  });
});

describe("automatedUsageOutcomeOf (the headless result mapping)", () => {
  test("success, interruption and error map to the ledger's outcomes", () => {
    expect(automatedUsageOutcomeOf("success")).toBe("completed");
    expect(automatedUsageOutcomeOf("interrupted")).toBe("cancelled");
    expect(automatedUsageOutcomeOf("error")).toBe("failed");
  });
});
