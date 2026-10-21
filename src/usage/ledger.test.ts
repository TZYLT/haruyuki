import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsageCost } from "@/utils/usage-cost";
import {
  aggregateUsageByDay,
  aggregateUsageByHour,
  aggregateUsageByModel,
  appendUsageRecord,
  buildUsageRecord,
  pruneUsageRecords,
  readUsageLedger,
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
});
