/**
 * F-06 M2 review follow-up · dream liveness (`isDreamRunLive`).
 *
 * The signal state's `running` marker is not proof of a live run: only a marker
 * *plus* a lease whose owner process is alive *and* an age inside the allowed
 * window counts. These four cases are exactly the ones T1's launcher and the
 * memory write guard need to trust.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDreamLease, getDreamLeasePath } from "@/agent/dream/dream-lease";
import {
  DREAM_LIVENESS_DEFAULT_LIMIT_MINUTES,
  DREAM_LIVENESS_LIMIT_GRACE_MS,
  DREAM_LIVENESS_MIN_AGE_MS,
  dreamRunMaxAgeMs,
  isDreamRunLive,
} from "@/agent/dream/dream-liveness";
import { markDreamRunActive } from "@/cron/dream-signal";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;
const root = mkdtempSync(join(tmpdir(), "hryk-dream-liveness-"));
process.env.HARUYUKI_HOME = root;

afterAll(() => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(root, "dream"), { recursive: true, force: true });
});

const HOUR = 60 * 60_000;

describe("dreamRunMaxAgeMs", () => {
  test("no configured limit assumes a 24h run plus grace, floored at 1h", () => {
    expect(dreamRunMaxAgeMs(null)).toBe(
      Math.max(
        DREAM_LIVENESS_MIN_AGE_MS,
        DREAM_LIVENESS_DEFAULT_LIMIT_MINUTES * 60_000 +
          DREAM_LIVENESS_LIMIT_GRACE_MS,
      ),
    );
  });

  test("a short limit never drops below the 1h floor", () => {
    expect(dreamRunMaxAgeMs(1)).toBe(DREAM_LIVENESS_MIN_AGE_MS);
  });

  test("a long limit widens the window by the grace period", () => {
    expect(dreamRunMaxAgeMs(120)).toBe(
      120 * 60_000 + DREAM_LIVENESS_LIMIT_GRACE_MS,
    );
  });
});

describe("isDreamRunLive", () => {
  test("marker + live lease + fresh stamp is live", () => {
    const now = new Date();
    markDreamRunActive("agent-a", "run-1", now);
    createDreamLease({ agentId: "agent-a", runId: "run-1" });
    expect(isDreamRunLive("agent-a", now)).toBe(true);
  });

  test("marker + dead lease owner is not live", () => {
    const now = new Date();
    markDreamRunActive("agent-a", "run-1", now);
    createDreamLease({ agentId: "agent-a", runId: "run-1" });
    const path = getDreamLeasePath("agent-a");
    const lease = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      path,
      JSON.stringify({
        ...lease,
        pid: 2_147_483_000,
        processStartTicks: null,
        bootId: null,
      }),
    );
    expect(isDreamRunLive("agent-a", now)).toBe(false);
  });

  test("marker with no lease is not live (crash remnant)", () => {
    const now = new Date();
    markDreamRunActive("agent-a", "run-1", now);
    expect(isDreamRunLive("agent-a", now)).toBe(false);
  });

  test("an aged marker is not live even with an alive lease", () => {
    const now = new Date();
    markDreamRunActive("agent-a", "run-1", new Date(now.getTime() - 30 * HOUR));
    createDreamLease({ agentId: "agent-a", runId: "run-1" });
    expect(isDreamRunLive("agent-a", now)).toBe(false);
  });

  test("an agent without any state is not live", () => {
    expect(isDreamRunLive("agent-none", new Date())).toBe(false);
  });
});
