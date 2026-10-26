import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsageCost } from "@/utils/usage-cost";
import {
  aggregateUsageByDay,
  aggregateUsageByHour,
  aggregateUsageByModel,
  aggregateUsageBySource,
  appendUsageRecord,
  buildUsageRecord,
  DEFAULT_USAGE_SOURCE,
  pruneUsageRecords,
  readUsageLedger,
  USAGE_LOCK_TIMEOUT_MS,
  type UsageRecord,
  usageDayKey,
  usageHourKey,
  usageLedgerPath,
} from "./ledger";

const tempRoots: string[] = [];
const originalHome = process.env.HARUYUKI_HOME;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "haruyuki-usage-"));
  tempRoots.push(root);
  return root;
}

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

function recordAt(hour: string, overrides: Partial<UsageRecord> = {}) {
  return {
    tsHour: hour,
    agentId: "agent-1",
    model: "anthropic/claude-sonnet-4-6",
    prompt: 1000,
    cachedInput: 3000,
    cacheWrite: 200,
    completion: 500,
    reasoning: 100,
    steps: 2,
    wallMs: 4000,
    apiMs: 3000,
    ...overrides,
  } satisfies UsageRecord;
}

describe("usage ledger paths", () => {
  test("the ledger lives under the harness root, not a literal directory name", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    expect(usageLedgerPath()).toBe(join(root, "usage", "ledger.jsonl"));
  });

  test("HARUYUKI_HOME is read at call time", async () => {
    const first = await makeTempRoot();
    const second = await makeTempRoot();
    process.env.HARUYUKI_HOME = first;
    const firstPath = usageLedgerPath();
    process.env.HARUYUKI_HOME = second;
    expect(usageLedgerPath()).not.toBe(firstPath);
    expect(usageLedgerPath()).toContain(second);
  });
});

describe("buildUsageRecord", () => {
  test("stores the local hour and derives the hit rate from both input buckets", () => {
    const at = new Date(2026, 9, 22, 14, 59, 59);
    const record = buildUsageRecord({
      at,
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 1000,
      cachedInput: 3000,
      cacheWrite: 0,
      completion: 500,
      steps: 3,
      wallMs: 9000,
      apiMs: 8000,
    });
    expect(record.tsHour).toBe("2026-10-22T14");
    // The miss count is a separate bucket, so the denominator is both inputs.
    expect(record.cacheHitRate).toBe(0.75);
  });

  test("omits the hit rate when nothing was billed as input", () => {
    const record = buildUsageRecord({
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 0,
      cachedInput: 0,
      cacheWrite: 0,
      completion: 12,
      steps: 1,
      wallMs: 1,
      apiMs: 1,
    });
    expect(record.cacheHitRate).toBeUndefined();
  });

  test("keeps a real cost and drops an all-zero one", () => {
    const priced = buildUsageRecord({
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 10,
      cachedInput: 20,
      cacheWrite: 30,
      completion: 40,
      steps: 1,
      wallMs: 1,
      apiMs: 1,
      cost: {
        input: 0.1,
        cacheRead: 0.2,
        cacheWrite: 0.3,
        output: 0.4,
        total: 1,
      },
    });
    expect(priced.cost).toEqual({
      input: 0.1,
      cacheRead: 0.2,
      cacheWrite: 0.3,
      output: 0.4,
      total: 1,
    });

    const free = buildUsageRecord({
      agentId: "agent-1",
      model: "lc-ollama/qwen3",
      prompt: 10,
      cachedInput: 0,
      cacheWrite: 0,
      completion: 1,
      steps: 1,
      wallMs: 1,
      apiMs: 1,
      cost: emptyUsageCost(),
    });
    // A local model is genuinely free; "no price" must not look like a number.
    expect(free.cost).toBeUndefined();
  });
});

describe("appendUsageRecord", () => {
  test("appends one line per turn and reads them back in order", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    const first = buildUsageRecord({
      at: new Date(2026, 9, 22, 14),
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 1,
      cachedInput: 2,
      cacheWrite: 3,
      completion: 4,
      steps: 1,
      wallMs: 5,
      apiMs: 6,
    });
    const second = { ...first, tsHour: "2026-10-22T15", prompt: 7 };
    expect(await appendUsageRecord(first)).toBe(true);
    expect(await appendUsageRecord(second)).toBe(true);

    const raw = await readFile(usageLedgerPath(), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);

    const records = await readUsageLedger();
    expect(records.map((record) => record.prompt)).toEqual([1, 7]);
  });

  test("a cancelled turn and its request composition survive the round trip", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    const record = buildUsageRecord({
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 10,
      cachedInput: 0,
      cacheWrite: 0,
      completion: 5,
      steps: 1,
      wallMs: 100,
      apiMs: 90,
      contextBreakdown: { system: 8_000, messages: 23_000, tools: 31_000 },
      cancelled: true,
    });
    expect(await appendUsageRecord(record)).toBe(true);

    const [read] = await readUsageLedger();
    expect(read?.cancelled).toBe(true);
    expect(read?.contextBreakdown).toEqual({
      system: 8_000,
      messages: 23_000,
      tools: 31_000,
    });
  });

  test("a record without the optional fields stays clean", () => {
    const record = buildUsageRecord({
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 10,
      cachedInput: 0,
      cacheWrite: 0,
      completion: 5,
      steps: 1,
      wallMs: 100,
      apiMs: 90,
    });
    expect(record.cancelled).toBeUndefined();
    expect(record.contextBreakdown).toBeUndefined();
  });

  test("returns false instead of throwing when the ledger cannot be written", async () => {
    const root = await makeTempRoot();
    // A file where the directory should be: mkdir must fail.
    const blockedRoot = join(root, "blocked");
    await writeFile(blockedRoot, "not a directory", "utf8");
    expect(
      await appendUsageRecord(recordAt("2026-10-22T14"), {
        path: join(blockedRoot, "ledger.jsonl"),
      }),
    ).toBe(false);
  });
});

describe("readUsageLedger", () => {
  test("a missing ledger reads as empty", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    expect(await readUsageLedger()).toEqual([]);
  });

  test("skips malformed and partial lines instead of failing the whole read", async () => {
    const root = await makeTempRoot();
    const path = join(root, "ledger.jsonl");
    const good = recordAt("2026-10-22T14");
    const partial = JSON.stringify({ tsHour: "2026-10-22T15", agentId: "x" });
    await writeFile(
      path,
      `${JSON.stringify(good)}\nnot json\n\n${partial}\n`,
      "utf8",
    );
    const records = await readUsageLedger({ path });
    expect(records).toHaveLength(1);
    expect(records[0]?.tsHour).toBe("2026-10-22T14");
  });

  test("prunes records past the retention window and rewrites the file", async () => {
    const root = await makeTempRoot();
    const path = join(root, "ledger.jsonl");
    const oldRecord = recordAt("2026-01-01T09");
    const freshRecord = recordAt("2026-10-22T09", { prompt: 42 });
    await writeFile(
      path,
      `${JSON.stringify(oldRecord)}\n${JSON.stringify(freshRecord)}\n`,
      "utf8",
    );

    const records = await readUsageLedger({
      path,
      now: new Date(2026, 9, 22, 12),
      retentionDays: 180,
    });
    expect(records.map((record) => record.prompt)).toEqual([42]);

    // The prune is lazy but persistent: the next read starts from a clean file.
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("2026-01-01T09");
  });

  test("keeps a record sitting exactly on the cutoff hour", () => {
    const now = new Date(2026, 9, 22, 12);
    const cutoff = new Date(now.getTime());
    cutoff.setDate(cutoff.getDate() - 180);
    const { kept, dropped } = pruneUsageRecords(
      [recordAt(usageHourKey(cutoff)), recordAt("2020-01-01T00")],
      now,
      180,
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe("aggregation", () => {
  const records = [
    recordAt("2026-10-22T14"),
    recordAt("2026-10-22T14", { prompt: 500, completion: 100 }),
    recordAt("2026-10-21T09", { model: "openai/gpt-5.5", steps: 1 }),
  ];

  test("hour buckets add up, including turns and tokens", () => {
    const hours = aggregateUsageByHour(records);
    expect(hours.get("2026-10-22T14")?.turns).toBe(2);
    expect(hours.get("2026-10-22T14")?.prompt).toBe(1500);
    expect(hours.get("2026-10-22T14")?.completion).toBe(600);
    expect(hours.get("2026-10-22T14")?.steps).toBe(4);
  });

  test("day buckets fold hours together", () => {
    const days = aggregateUsageByDay(records);
    expect([...days.keys()].sort()).toEqual(["2026-10-21", "2026-10-22"]);
    expect(days.get("2026-10-22")?.turns).toBe(2);
    expect(usageDayKey("2026-10-22T14")).toBe("2026-10-22");
  });

  test("model buckets keep the billed handle", () => {
    const models = aggregateUsageByModel(records);
    expect([...models.keys()].sort()).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.5",
    ]);
  });

  test("cost is summed bucket by bucket", () => {
    const priced = [
      recordAt("2026-10-22T14", {
        cost: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 10 },
      }),
      recordAt("2026-10-22T15", {
        cost: {
          input: 0.5,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0.5,
          total: 1,
        },
      }),
    ];
    const day = aggregateUsageByDay(priced).get("2026-10-22");
    expect(day?.cost).toEqual({
      input: 1.5,
      cacheRead: 2,
      cacheWrite: 3,
      output: 4.5,
      total: 11,
    });
  });

  test("source buckets split automated spend from interactive spend", () => {
    const records = [
      recordAt("2026-10-22T14"),
      recordAt("2026-10-22T15", { source: "reflection", prompt: 40 }),
      recordAt("2026-10-22T16", { source: "reflection", prompt: 60 }),
    ];
    const sources = aggregateUsageBySource(records);
    // A record without a source is interactive — old rows must not become a
    // bucket of their own (§5.16.3).
    expect(sources.get(DEFAULT_USAGE_SOURCE)?.turns).toBe(1);
    expect(sources.get("reflection")?.turns).toBe(2);
    expect(sources.get("reflection")?.prompt).toBe(100);
    expect([...sources.keys()].sort()).toEqual(["interactive", "reflection"]);
  });
});

describe("the F-03 record fields", () => {
  test("writes the automated identity, source and outcome", () => {
    const record = buildUsageRecord({
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 10,
      cachedInput: 20,
      cacheWrite: 0,
      completion: 5,
      steps: 1,
      wallMs: 100,
      apiMs: 90,
      source: "reflection",
      outcome: "timeout",
      runId: "reflection-agent-1-abc",
      sessionId: "local-conv-2",
      parentSessionId: "local-conv-1",
    });
    expect(record.source).toBe("reflection");
    expect(record.outcome).toBe("timeout");
    expect(record.runId).toBe("reflection-agent-1-abc");
    expect(record.sessionId).toBe("local-conv-2");
    expect(record.parentSessionId).toBe("local-conv-1");
  });

  test("an empty or absent identity produces no empty fields", () => {
    const plain = buildUsageRecord({
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 10,
      cachedInput: 0,
      cacheWrite: 0,
      completion: 5,
      steps: 1,
      wallMs: 1,
      apiMs: 1,
    });
    expect(plain.source).toBeUndefined();
    expect(plain.outcome).toBeUndefined();
    expect(plain.runId).toBeUndefined();
    expect(plain.sessionId).toBeUndefined();
    expect(plain.parentSessionId).toBeUndefined();

    const blank = buildUsageRecord({
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 10,
      cachedInput: 0,
      cacheWrite: 0,
      completion: 5,
      steps: 1,
      wallMs: 1,
      apiMs: 1,
      runId: "   ",
      sessionId: "",
    });
    expect(blank.runId).toBeUndefined();
    expect(blank.sessionId).toBeUndefined();
    expect(JSON.stringify(blank)).not.toContain('"runId"');
  });

  test("an old row without a source still reads, as interactive", async () => {
    const root = await makeTempRoot();
    const path = join(root, "ledger.jsonl");
    // Shaped like a pre-F-03 line: no source/outcome/ids at all.
    await writeFile(
      path,
      `${JSON.stringify(recordAt("2026-10-22T09"))}\n`,
      "utf8",
    );
    const records = await readUsageLedger({ path, prune: false });
    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBeUndefined();
    expect(DEFAULT_USAGE_SOURCE).toBe("interactive");
  });

  test("an invalid enum or id drops the field, not the row", async () => {
    const root = await makeTempRoot();
    const path = join(root, "ledger.jsonl");
    const malformed = {
      ...recordAt("2026-10-22T09"),
      source: "not-a-source",
      outcome: 7,
      runId: 42,
      sessionId: "   ",
    };
    await writeFile(path, `${JSON.stringify(malformed)}\n`, "utf8");
    const records = await readUsageLedger({ path, prune: false });
    expect(records).toHaveLength(1);
    expect(records[0]?.prompt).toBe(1000);
    expect(records[0]?.source).toBeUndefined();
    expect(records[0]?.outcome).toBeUndefined();
    expect(records[0]?.runId).toBeUndefined();
    expect(records[0]?.sessionId).toBeUndefined();
  });

  test("a reflective row survives the round trip with its outcome", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    const record = buildUsageRecord({
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 10,
      cachedInput: 2,
      cacheWrite: 0,
      completion: 5,
      steps: 1,
      wallMs: 100,
      apiMs: 90,
      source: "reflection",
      outcome: "completed",
      runId: "run-1",
      sessionId: "local-conv-2",
      parentSessionId: "local-conv-1",
    });
    expect(await appendUsageRecord(record)).toBe(true);
    const [read] = await readUsageLedger();
    expect(read).toMatchObject({
      source: "reflection",
      outcome: "completed",
      runId: "run-1",
      sessionId: "local-conv-2",
      parentSessionId: "local-conv-1",
    });
  });
});

describe("the ledger lock", () => {
  /** The debug sink `debugLog` writes to when HARUYUKI_DEBUG is on. */
  async function withDebugSink<T>(
    root: string,
    run: (logPath: string) => Promise<T>,
  ): Promise<T> {
    const logPath = join(root, "debug.log");
    const originalDebug = process.env.HARUYUKI_DEBUG;
    const originalFile = process.env.HARUYUKI_DEBUG_FILE;
    process.env.HARUYUKI_DEBUG = "1";
    process.env.HARUYUKI_DEBUG_FILE = logPath;
    try {
      return await run(logPath);
    } finally {
      if (originalDebug === undefined) delete process.env.HARUYUKI_DEBUG;
      else process.env.HARUYUKI_DEBUG = originalDebug;
      if (originalFile === undefined) delete process.env.HARUYUKI_DEBUG_FILE;
      else process.env.HARUYUKI_DEBUG_FILE = originalFile;
    }
  }

  test("a held lock makes the append drop its row and log why", async () => {
    // The wait cap is the requirement's 60s; the drop path itself is exercised
    // with a short injected wait so the test does not spend a minute on it.
    expect(USAGE_LOCK_TIMEOUT_MS).toBe(60_000);
    const root = await makeTempRoot();
    const path = join(root, "ledger.jsonl");
    await writeFile(`${path}.lock`, "held\n", "utf8");
    await withDebugSink(root, async (logPath) => {
      expect(
        await appendUsageRecord(recordAt("2026-10-22T14"), {
          path,
          lockTimeoutMs: 25,
        }),
      ).toBe(false);
      // A failed waiter must not erase someone else's lock.
      expect(existsSync(`${path}.lock`)).toBe(true);
      expect(existsSync(path)).toBe(false);
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("dropped a ledger write");
    });
  });

  test("a lock abandoned by a dead writer is reaped instead of blocking", async () => {
    const root = await makeTempRoot();
    const path = join(root, "ledger.jsonl");
    await writeFile(`${path}.lock`, "crashed\n", "utf8");
    // Older than the wait cap: nobody could still be waiting for it.
    const ancient = new Date(Date.now() - USAGE_LOCK_TIMEOUT_MS - 5_000);
    await utimes(`${path}.lock`, ancient, ancient);
    expect(
      await appendUsageRecord(recordAt("2026-10-22T14"), {
        path,
        lockTimeoutMs: 500,
      }),
    ).toBe(true);
    const records = await readUsageLedger({ path, prune: false });
    expect(records).toHaveLength(1);
  });

  test("concurrent appends all land, one valid line each", async () => {
    const root = await makeTempRoot();
    process.env.HARUYUKI_HOME = root;
    const appended = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        appendUsageRecord(recordAt("2026-10-22T14", { prompt: index })),
      ),
    );
    expect(appended.every(Boolean)).toBe(true);
    const raw = await readFile(usageLedgerPath(), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(12);
    // Interleaved writes would leave unparseable lines; every line must stand
    // on its own, which is the whole point of the shared lock.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const records = await readUsageLedger();
    expect(
      records.map((record) => record.prompt).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index));
  });

  test("a prune rewrite cannot swallow an append running beside it", async () => {
    const root = await makeTempRoot();
    const path = join(root, "ledger.jsonl");
    // One expired row so the read has to rewrite the file while appends run.
    await writeFile(
      path,
      `${JSON.stringify(recordAt("2026-01-01T09"))}\n`,
      "utf8",
    );
    const appends = Array.from({ length: 6 }, (_, index) =>
      appendUsageRecord(recordAt("2026-10-22T14", { prompt: index }), { path }),
    );
    const read = readUsageLedger({ path, now: new Date(2026, 9, 22, 12) });
    const appended = await Promise.all(appends);
    await read;
    expect(appended.every(Boolean)).toBe(true);
    // The prune may or may not have seen the appends, but it must never drop
    // them: the rewrite re-reads under the same lock the appends take.
    const after = await readUsageLedger({ path, prune: false });
    expect(after.map((record) => record.prompt).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });
});
