import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentManager } from "@/experiments/manager";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalUiV2Flag = process.env.HARUYUKI_UI_V2;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-ui-v2-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  delete process.env.HARUYUKI_UI_V2;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  if (testHomeDir) {
    await rm(testHomeDir, { recursive: true, force: true });
    testHomeDir = "";
  }

  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  if (originalUiV2Flag === undefined) {
    delete process.env.HARUYUKI_UI_V2;
  } else {
    process.env.HARUYUKI_UI_V2 = originalUiV2Flag;
  }
});

describe("ui_v2 shell experiment", () => {
  test("is listed and off by default", () => {
    const snapshot = experimentManager
      .list()
      .find((entry) => entry.id === "ui_v2");
    expect(snapshot).toMatchObject({
      id: "ui_v2",
      enabled: false,
      source: "default",
      override: null,
    });
  });

  test("falls back to HARUYUKI_UI_V2 when no override is stored", () => {
    process.env.HARUYUKI_UI_V2 = "1";

    expect(experimentManager.getSnapshot("ui_v2")).toMatchObject({
      id: "ui_v2",
      enabled: true,
      source: "env",
    });
  });

  test("lets a stored override beat the env flag", async () => {
    process.env.HARUYUKI_UI_V2 = "true";

    expect(experimentManager.set("ui_v2", false)).toMatchObject({
      id: "ui_v2",
      enabled: false,
      source: "override",
      override: false,
    });
    await settingsManager.flush();

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(experimentManager.getSnapshot("ui_v2")).toMatchObject({
      id: "ui_v2",
      enabled: false,
      source: "override",
      override: false,
    });
  });
});
