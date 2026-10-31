/**
 * `device_status.dream` summary (M5-A stage 2, B2).
 *
 * The summary rides a broadcast that fires many times per turn, so the read is
 * cached per agent. These tests pin the projection (`enabled` + live run id),
 * the TTL behaviour, and the `buildDeviceStatus` wiring that puts it on the
 * wire.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDreamLease, deleteDreamLease } from "@/agent/dream/dream-lease";
import { __testSetBackend } from "@/backend";
import { markDreamRunActive, markDreamRunFinished } from "@/cron/dream-signal";
import { settingsManager } from "@/settings-manager";
import { __listenClientTestUtils } from "@/websocket/listener/client";
import {
  DREAM_DEVICE_SUMMARY_TTL_MS,
  getDreamDeviceSummary,
  resetDreamDeviceSummaryCache,
} from "@/websocket/listener/device-status-cache";
import { buildDeviceStatus } from "@/websocket/listener/protocol-outbound";

const AGENT = "agent-device-dream";
const previousHome = process.env.HOME;
const previousHaruyukiHome = process.env.HARUYUKI_HOME;
let testHome: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHome = await mkdtemp(join(tmpdir(), "hryk-dream-device-"));
  process.env.HARUYUKI_HOME = testHome;
  process.env.HOME = testHome;
  await settingsManager.initialize();
  resetDreamDeviceSummaryCache();
});

afterEach(async () => {
  resetDreamDeviceSummaryCache();
  __testSetBackend(null);
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(testHome, { recursive: true, force: true });
});

describe("getDreamDeviceSummary", () => {
  test("no agent scope means no summary", () => {
    expect(getDreamDeviceSummary(null)).toBeNull();
  });

  test("a disabled agent answers from the settings alone", () => {
    expect(getDreamDeviceSummary(AGENT)).toEqual({
      enabled: false,
      runningRunId: null,
    });
  });

  test("the summary is cached until the TTL elapses", () => {
    const now = Date.now();
    expect(getDreamDeviceSummary(AGENT, now)?.enabled).toBe(false);

    // The switch changed, but the broadcast must not pay a liveness read on
    // every emission: within the TTL the cached projection wins.
    settingsManager.updateSettings({ dreamEnabled: true });
    expect(getDreamDeviceSummary(AGENT, now + 1_000)).toEqual({
      enabled: false,
      runningRunId: null,
    });

    expect(
      getDreamDeviceSummary(AGENT, now + DREAM_DEVICE_SUMMARY_TTL_MS + 1),
    ).toEqual({ enabled: true, runningRunId: null });
  });

  test("a live run is reported and disappears when it finishes", () => {
    settingsManager.updateSettings({ dreamEnabled: true });
    const now = new Date();
    createDreamLease({ agentId: AGENT, runId: "run-live" });
    markDreamRunActive(AGENT, "run-live", now);

    expect(getDreamDeviceSummary(AGENT)).toEqual({
      enabled: true,
      runningRunId: "run-live",
    });

    markDreamRunFinished(AGENT, "succeeded", now);
    deleteDreamLease(AGENT);
    resetDreamDeviceSummaryCache();
    expect(getDreamDeviceSummary(AGENT)).toEqual({
      enabled: true,
      runningRunId: null,
    });
  });
});

describe("buildDeviceStatus dream wiring", () => {
  test("a conversation-scoped status carries the dream summary", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      AGENT,
      "conv-device-dream",
    );

    const status = buildDeviceStatus(runtime);
    expect(status.dream).toEqual({ enabled: false, runningRunId: null });
  });

  test("a status without a listener runtime reports no dream data", () => {
    const status = buildDeviceStatus(null);
    expect(status.dream).toBeNull();
  });
});
