import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCompactionUsage } from "@/usage/compaction-usage";
import type { UsageRecord } from "@/usage/ledger";

let dir = "";
let ledgerPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-usage-"));
  ledgerPath = join(dir, "usage.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readRows(): UsageRecord[] {
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as UsageRecord);
}

const base = {
  agentId: "agent-1",
  conversationId: "conv-1",
  model: "lmstudio/compact-model",
  promptTokens: 1200,
  cachedInputTokens: 800,
  completionTokens: 90,
  wallMs: 4321,
  outcome: "completed" as const,
};

describe("recordCompactionUsage", () => {
  test("writes one row tagged with the compaction source", async () => {
    const written = await recordCompactionUsage(base, { path: ledgerPath });
    expect(written).toBe(true);

    const rows = readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("compaction");
    expect(rows[0]?.outcome).toBe("completed");
  });

  test("carries the numbers straight through and defaults the step fields", async () => {
    await recordCompactionUsage(base, { path: ledgerPath });

    const row = readRows()[0];
    expect(row?.prompt).toBe(1200);
    expect(row?.cachedInput).toBe(800);
    expect(row?.completion).toBe(90);
    expect(row?.cacheWrite).toBe(0);
    expect(row?.steps).toBe(1);
    expect(row?.wallMs).toBe(4321);
    expect(row?.apiMs).toBe(4321);
    expect(row?.model).toBe("lmstudio/compact-model");
    expect(row?.agentId).toBe("agent-1");
    // The conversation id rides as an id; no message text may appear (§5.16.6).
    expect(row?.sessionId).toBe("conv-1");
  });

  test("records a cancelled run, because the tokens were already spent", async () => {
    await recordCompactionUsage(
      { ...base, outcome: "cancelled" },
      { path: ledgerPath },
    );

    const row = readRows()[0];
    expect(row?.source).toBe("compaction");
    expect(row?.outcome).toBe("cancelled");
    expect(row?.prompt).toBe(1200);
  });

  test("records a failed run without inventing numbers", async () => {
    await recordCompactionUsage(
      { ...base, outcome: "failed", completionTokens: 0, wallMs: 0 },
      { path: ledgerPath },
    );

    const row = readRows()[0];
    expect(row?.outcome).toBe("failed");
    expect(row?.completion).toBe(0);
    expect(row?.wallMs).toBe(0);
  });

  test("resolves false instead of throwing when the ledger cannot be written", async () => {
    // A directory in place of the file: appendFile cannot create it, and the
    // compaction path must not fail because bookkeeping did.
    const unwritable = join(dir, "as-a-directory");
    await Bun.write(join(unwritable, ".keep"), "");

    const written = await recordCompactionUsage(base, { path: unwritable });
    expect(written).toBe(false);
  });
});
