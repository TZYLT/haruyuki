/**
 * `device_status.embedding` summary (D2, 48-2 §4.9).
 *
 * The summary rides a broadcast that fires many times per turn, so the read is
 * cached per agent (5s TTL) and deduped by JSON. These tests pin the `null`
 * projection, the TTL behaviour, the JSON dedup identity, the provider
 * swap/clear, and the `buildDeviceStatus` wiring that puts the projection on
 * the wire.
 *
 * The module installs A5's real reader at load time, so every test restores
 * that provider afterwards instead of leaving the process without one: a
 * cleared provider would silently disable `device_status.embedding` for any
 * later test file sharing this Bun worker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "@/websocket/listener/client";
import {
  EMBEDDING_DEVICE_SUMMARY_TTL_MS,
  getEmbeddingDeviceSummary,
  readEmbeddingBuildDeviceSummary,
  resetEmbeddingDeviceSummaryCache,
  setEmbeddingDeviceSummaryProvider,
} from "@/websocket/listener/embedding-device-status";
import { buildDeviceStatus } from "@/websocket/listener/protocol-outbound";

const AGENT = "agent-device-embedding";

afterEach(() => {
  setEmbeddingDeviceSummaryProvider(readEmbeddingBuildDeviceSummary);
  resetEmbeddingDeviceSummaryCache();
});

function runningSummary(progress = 0.4) {
  return {
    enabled: true,
    state: "running" as const,
    progress,
    processed_chunks: 40,
    total_chunks: 100,
    eta_ms: 1_200,
  };
}

describe("getEmbeddingDeviceSummary", () => {
  test("no agent scope means no summary", () => {
    let calls = 0;
    setEmbeddingDeviceSummaryProvider(() => {
      calls += 1;
      return runningSummary();
    });
    expect(getEmbeddingDeviceSummary(null)).toBeNull();
    expect(calls).toBe(0);
  });

  test("a cleared provider reports no embedding data", () => {
    setEmbeddingDeviceSummaryProvider(null);
    expect(getEmbeddingDeviceSummary(AGENT)).toBeNull();
  });

  test("the summary is cached until the TTL elapses", () => {
    const state = { calls: 0 };
    setEmbeddingDeviceSummaryProvider(() => {
      state.calls += 1;
      return runningSummary();
    });
    const now = Date.now();

    expect(getEmbeddingDeviceSummary(AGENT, now)?.progress).toBe(0.4);
    expect(state.calls).toBe(1);

    // Within the TTL the broadcast must not pay another build-state read.
    expect(getEmbeddingDeviceSummary(AGENT, now + 1_000)?.progress).toBe(0.4);
    expect(state.calls).toBe(1);

    expect(
      getEmbeddingDeviceSummary(
        AGENT,
        now + EMBEDDING_DEVICE_SUMMARY_TTL_MS + 1,
      )?.progress,
    ).toBe(0.4);
    expect(state.calls).toBe(2);
  });

  test("an unchanged projection keeps the cached object (JSON dedup)", () => {
    const state = { calls: 0 };
    setEmbeddingDeviceSummaryProvider(() => {
      state.calls += 1;
      // A fresh object every read, but identical JSON: no new emission.
      return runningSummary();
    });
    const now = Date.now();
    const first = getEmbeddingDeviceSummary(AGENT, now);
    const second = getEmbeddingDeviceSummary(
      AGENT,
      now + EMBEDDING_DEVICE_SUMMARY_TTL_MS + 1,
    );

    expect(state.calls).toBe(2);
    expect(second).toBe(first);
  });

  test("a changed projection replaces the cached object", () => {
    const state = { progress: 0.4 };
    setEmbeddingDeviceSummaryProvider(() => runningSummary(state.progress));
    const now = Date.now();
    const first = getEmbeddingDeviceSummary(AGENT, now);

    state.progress = 0.9;
    const second = getEmbeddingDeviceSummary(
      AGENT,
      now + EMBEDDING_DEVICE_SUMMARY_TTL_MS + 1,
    );

    expect(second).not.toBe(first);
    expect(second?.progress).toBe(0.9);
  });

  test("swapping the provider drops the previous projection", () => {
    setEmbeddingDeviceSummaryProvider(() => runningSummary());
    expect(getEmbeddingDeviceSummary(AGENT, 1_000)).not.toBeNull();

    // A different owner may disagree with the old summary; the cache must not
    // serve it for up to five more seconds.
    setEmbeddingDeviceSummaryProvider(() => null);
    expect(getEmbeddingDeviceSummary(AGENT, 1_000)).toBeNull();
  });
});

describe("buildDeviceStatus embedding wiring", () => {
  test("a conversation-scoped status carries the embedding summary", () => {
    setEmbeddingDeviceSummaryProvider(() => runningSummary());
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      AGENT,
      "conv-device-embedding",
    );

    const status = buildDeviceStatus(runtime);
    expect(status.embedding).toEqual(runningSummary());
  });

  test("a status without a listener runtime reports no embedding data", () => {
    setEmbeddingDeviceSummaryProvider(() => runningSummary());
    expect(buildDeviceStatus(null).embedding).toBeNull();
  });
});
