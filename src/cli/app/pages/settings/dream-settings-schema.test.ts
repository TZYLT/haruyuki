import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDreamSettings } from "@/dream-settings";
import { settingsManager } from "@/settings-manager";
import { DREAM_SETTINGS_ITEMS } from "./dream-settings-schema";
import type { SettingsContext, SettingsItem } from "./settings-model";

/**
 * The settings page writes Dream's four tier switches one patch at a time.
 *
 * That is only correct because `updateDreamSettings` merges a tier patch into
 * the already-stored `dreamTiers` map: a whole-map write meant that turning
 * Tidy off and then Think off silently turned Tidy back on. These tests drive
 * the actual schema writers (not the resolver) with a real `settingsManager`
 * under a temporary HOME, which is the only place the merge is observable.
 */

const CTX: SettingsContext = {
  agentId: "agent-tiers",
  conversationId: "conv-tiers",
  projectDirectory: "/tmp/does-not-matter",
};

function writer(id: string): (ctx: SettingsContext, value: string) => void {
  const item = DREAM_SETTINGS_ITEMS.find(
    (entry): entry is SettingsItem => entry.id === id,
  );
  if (!item?.write) throw new Error(`${id} has no writer`);
  const write = item.write;
  return (ctx, value) => {
    void write(ctx, value);
  };
}

const originalHome = process.env.HOME;
let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-tiers-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe("the Dream tier switches", () => {
  test("turning two tiers off keeps both off", () => {
    writer("dreamTier-tidy")(CTX, "false");
    writer("dreamTier-think")(CTX, "false");
    const tiers = readDreamSettings(CTX.agentId).tiers;
    expect({ tidy: tiers.tidy, think: tiers.think }).toEqual({
      tidy: false,
      think: false,
    });
  });

  test("a tier nobody touched keeps its default", () => {
    writer("dreamTier-tidy")(CTX, "false");
    const tiers = readDreamSettings(CTX.agentId).tiers;
    expect(tiers.tidy).toBe(false);
    expect(tiers.task).toBe(true);
    expect(tiers.wander).toBe(true);
  });

  test("turning a tier back on after two writes does not resurrect the others", () => {
    writer("dreamTier-tidy")(CTX, "false");
    writer("dreamTier-think")(CTX, "false");
    writer("dreamTier-tidy")(CTX, "true");
    const tiers = readDreamSettings(CTX.agentId).tiers;
    expect({ tidy: tiers.tidy, think: tiers.think }).toEqual({
      tidy: true,
      think: false,
    });
  });
});
