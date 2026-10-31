/**
 * `usage_aggregate`: read-only ledger aggregation for app-server clients.
 *
 * The handler reads the real ledger file under a temp harness root, so these
 * tests cover the wiring end to end: agent filter, `run_id` precedence over
 * `session_id`, the inclusive hour-resolution time window, per-run buckets and
 * the zero-row shapes a client renders as `—`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import type {
  UsageAggregateCommand,
  UsageAggregateResponseMessage,
} from "@/types/usage-protocol";
import {
  appendUsageRecord,
  buildUsageRecord,
  type UsageRecord,
  type UsageRecordInput,
  usageHourKey,
} from "@/usage/ledger";
import type { SafeSocketSend } from "./types";
import { handleUsageAggregateCommand } from "./usage";

const AGENT = "agent-usage";
const OTHER_AGENT = "agent-usage-other";
const HOUR = 3_600_000;

const previousHome = process.env.HOME;
const previousHaruyukiHome = process.env.HARUYUKI_HOME;
let testHome: string;
/** Current local hour boundary; rows are placed relative to it. */
let base: Date;
let sent: unknown[];
let socket: WebSocket;
let send: SafeSocketSend;

function at(hoursAgo: number): Date {
  return new Date(base.getTime() - hoursAgo * HOUR);
}

function row(
  overrides: Partial<UsageRecordInput> & { agentId: string; at: Date },
): UsageRecordInput {
  return {
    model: "test-model",
    prompt: 0,
    cachedInput: 0,
    cacheWrite: 0,
    completion: 0,
    reasoning: 0,
    steps: 1,
    wallMs: 0,
    apiMs: 0,
    ...overrides,
  };
}

async function appendRows(): Promise<void> {
  const rows = [
    row({
      agentId: AGENT,
      at: at(2),
      source: "dream",
      outcome: "completed",
      runId: "run-1",
      sessionId: "session-1",
      prompt: 100,
      cachedInput: 50,
      cacheWrite: 10,
      completion: 20,
      reasoning: 5,
      steps: 1,
      wallMs: 100,
      apiMs: 50,
      cost: {
        input: 0.01,
        cacheRead: 0.005,
        cacheWrite: 0.005,
        output: 0.01,
        total: 0.03,
      },
    }),
    row({
      agentId: AGENT,
      at: at(1),
      source: "dream",
      outcome: "budget_exhausted",
      runId: "run-1",
      sessionId: "session-1",
      prompt: 200,
      cachedInput: 100,
      cacheWrite: 20,
      completion: 40,
      reasoning: 10,
      steps: 2,
      wallMs: 200,
      apiMs: 100,
      cost: {
        input: 0.02,
        cacheRead: 0.01,
        cacheWrite: 0.01,
        output: 0.02,
        total: 0.06,
      },
    }),
    row({
      agentId: AGENT,
      at: at(3),
      runId: "run-2",
      sessionId: "session-2",
      prompt: 10,
      completion: 5,
      wallMs: 50,
      apiMs: 25,
    }),
    row({
      agentId: OTHER_AGENT,
      at: at(1),
      runId: "run-1",
      sessionId: "session-9",
      prompt: 7,
      completion: 3,
    }),
  ];
  for (const input of rows) {
    expect(await appendUsageRecord(buildUsageRecord(input))).toBe(true);
  }
}

function command(
  overrides: Partial<UsageAggregateCommand> = {},
): UsageAggregateCommand {
  return {
    type: "usage_aggregate",
    request_id: "usage-1",
    agent_id: AGENT,
    ...overrides,
  };
}

async function run(
  overrides: Partial<UsageAggregateCommand> = {},
  readLedger?: () => Promise<readonly UsageRecord[]>,
): Promise<UsageAggregateResponseMessage> {
  sent = [];
  await handleUsageAggregateCommand(
    command(overrides),
    socket,
    send,
    ...(readLedger ? [readLedger] : []),
  );
  return sent.at(-1) as UsageAggregateResponseMessage;
}

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), "hryk-usage-aggregate-"));
  process.env.HARUYUKI_HOME = testHome;
  process.env.HOME = testHome;
  base = new Date();
  base.setMinutes(0, 0, 0);
  sent = [];
  socket = {} as WebSocket;
  send = (_socket, payload) => {
    sent.push(payload);
    return true;
  };
  await appendRows();
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(testHome, { recursive: true, force: true });
});

describe("usage_aggregate totals", () => {
  test("totals fold every row of the requested agent", async () => {
    const response = await run();

    expect(response).toMatchObject({
      type: "usage_aggregate_response",
      request_id: "usage-1",
      success: true,
    });
    expect(response.totals).toMatchObject({
      turns: 3,
      prompt: 310,
      cachedInput: 150,
      cacheWrite: 30,
      completion: 65,
      reasoning: 15,
      steps: 4,
      wallMs: 350,
      apiMs: 175,
    });
    expect(response.totals.cost.total).toBeCloseTo(0.09, 10);
    // No run filter: the contract keeps `runs` empty.
    expect(response.runs).toEqual([]);
  });

  test("an agent with no rows is all zeros, not an error", async () => {
    const response = await run({ agent_id: "agent-with-no-rows" });

    expect(response.success).toBe(true);
    expect(response.totals.turns).toBe(0);
    expect(response.totals.cost.total).toBe(0);
    expect(response.runs).toEqual([]);
  });
});

describe("usage_aggregate filters", () => {
  test("run_id narrows totals and returns one per-run bucket", async () => {
    const response = await run({ run_id: "run-1" });

    expect(response.totals).toMatchObject({
      turns: 2,
      prompt: 300,
      completion: 60,
    });
    expect(response.runs).toHaveLength(1);
    expect(response.runs[0]).toMatchObject({
      runId: "run-1",
      totals: { turns: 2, prompt: 300 },
    });
    expect(response.runs[0]?.outcomes).toEqual([
      "completed",
      "budget_exhausted",
    ]);
  });

  test("run_id wins over session_id when both are present", async () => {
    const response = await run({
      run_id: "run-1",
      session_id: "session-2",
    });

    expect(response.totals.turns).toBe(2);
    expect(response.runs[0]?.runId).toBe("run-1");
  });

  test("session_id narrows the rows but names no run", async () => {
    const response = await run({ session_id: "session-1" });

    expect(response.totals).toMatchObject({ turns: 2, prompt: 300 });
    expect(response.runs).toEqual([]);
  });

  test("a run id with no ledger row still gets a bucket with turns 0", async () => {
    const response = await run({ run_id: "run-missing" });

    expect(response.totals.turns).toBe(0);
    expect(response.runs).toHaveLength(1);
    expect(response.runs[0]).toMatchObject({
      runId: "run-missing",
      totals: { turns: 0 },
      outcomes: [],
    });
  });

  test("from/to bounds are inclusive at the ledger's local-hour resolution", async () => {
    const response = await run({
      from: at(2).toISOString(),
      to: at(1).toISOString(),
    });

    // The two in-window rows; the 3-hours-ago row is outside.
    expect(response.totals.turns).toBe(2);
    expect(usageHourKey(at(2))).toBe(
      usageHourKey(new Date(at(2).toISOString())),
    );
  });

  test("a from bound inside one hour keeps that whole hour", async () => {
    // The ledger stores `YYYY-MM-DDTHH`, so a bound covers the hour it names.
    const from = new Date(at(2).getTime() + 30 * 60_000);
    const response = await run({ from: from.toISOString() });

    expect(response.totals).toMatchObject({ turns: 2, prompt: 300 });
  });
});

describe("usage_aggregate failure", () => {
  test("an unreadable ledger is reported, not thrown", async () => {
    const response = await run({}, async () => {
      throw new Error("ledger unreadable");
    });

    expect(response).toMatchObject({
      type: "usage_aggregate_response",
      success: false,
      error: "ledger unreadable",
    });
    expect(response.totals.turns).toBe(0);
    expect(response.runs).toEqual([]);
  });
});
