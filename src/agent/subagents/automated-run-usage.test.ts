/**
 * Automated-run tag resolution for a dream child (F-06 W7).
 *
 * The tag is resolved in the parent process at launch time; it must carry the
 * current dream tier from the parent's runtime context so the child (a separate
 * process) can prefix commits correctly. None of this may leak to an ordinary
 * subagent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAutomatedRunUsageTag } from "@/agent/subagents/automated-run-usage";
import { markDreamRunActive } from "@/cron/dream-signal";
import { runWithRuntimeContext } from "@/runtime-context";

const originalHome = process.env.HARUYUKI_HOME;
let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-usage-home-"));
  process.env.HARUYUKI_HOME = homeDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

describe("dream automated-run tag", () => {
  test("carries the tier from the parent runtime context", () => {
    const agentId = "agent-dream-tag";
    markDreamRunActive(agentId, "run-9", new Date());

    const tag = runWithRuntimeContext({ dreamTier: "task" }, () =>
      resolveAutomatedRunUsageTag("dream", agentId),
    );
    expect(tag).toEqual({
      usageSource: "dream",
      usageRunId: "run-9",
      dreamTier: "task",
    });

    // Outside a dream turn the tag still identifies the run (usage attribution),
    // but there is no tier to carry.
    expect(resolveAutomatedRunUsageTag("dream", agentId)).toEqual({
      usageSource: "dream",
      usageRunId: "run-9",
    });
  });

  test("an agent with no active run gets no tag", () => {
    expect(resolveAutomatedRunUsageTag("dream", "agent-quiet")).toBeUndefined();
  });

  test("an ordinary subagent never gets a tag", () => {
    expect(
      resolveAutomatedRunUsageTag("general-purpose", "agent-ordinary"),
    ).toBeUndefined();
  });
});
