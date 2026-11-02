// src/cli/app/pages/overview/overview-cache.test.ts

/** The overview store's own rules: the 30 s TTL and the generation counter. */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearInFlightOverviewPreview,
  currentOverviewGeneration,
  OVERVIEW_CACHE_TTL_MS,
  overviewPreviewKey,
  readCachedOverviewPreview,
  readCachedOverviewSnapshot,
  readInFlightOverviewPreview,
  readInFlightOverviewSnapshot,
  resetOverviewCache,
  setInFlightOverviewPreview,
  setInFlightOverviewSnapshot,
  storeOverviewPreview,
  storeOverviewSnapshot,
} from "./overview-cache";
import type { OverviewConversationPreview } from "./overview-fetch";
import type { OverviewSnapshot } from "./overview-types";

const NOW_MS = Date.parse("2026-11-02T15:00:00.000Z");

function snapshot(
  generatedAtMs: number,
  agentIds: readonly string[] = ["a1"],
): OverviewSnapshot {
  return {
    agents: agentIds.map((agentId) => ({
      agentId,
      name: agentId,
      description: null,
      conversationCount: 0,
      totalConversationCount: 0,
      conversationCountTruncated: false,
      lastActivityAtMs: null,
    })),
    conversations: Object.fromEntries(agentIds.map((agentId) => [agentId, []])),
    generatedAtMs,
  };
}

function preview(lastUserMessage: string | null): OverviewConversationPreview {
  return { lastUserMessage, lastAgentMessage: null };
}

beforeEach(() => {
  resetOverviewCache();
});

describe("snapshot TTL", () => {
  test("serves a snapshot younger than 30 s and drops it at the boundary", () => {
    const stored = snapshot(NOW_MS);
    storeOverviewSnapshot(stored);

    expect(readCachedOverviewSnapshot(NOW_MS)).toBe(stored);
    expect(readCachedOverviewSnapshot(NOW_MS + OVERVIEW_CACHE_TTL_MS - 1)).toBe(
      stored,
    );
    expect(
      readCachedOverviewSnapshot(NOW_MS + OVERVIEW_CACHE_TTL_MS),
    ).toBeNull();
  });

  test("has no snapshot before the first store and after a reset", () => {
    expect(readCachedOverviewSnapshot(NOW_MS)).toBeNull();

    storeOverviewSnapshot(snapshot(NOW_MS));
    resetOverviewCache();

    expect(readCachedOverviewSnapshot(NOW_MS)).toBeNull();
  });
});

describe("generation", () => {
  test("every stored snapshot opens the next generation", () => {
    const before = currentOverviewGeneration();

    const first = storeOverviewSnapshot(snapshot(NOW_MS));
    expect(first).toBe(before + 1);

    const second = storeOverviewSnapshot(snapshot(NOW_MS + 1));
    expect(second).toBe(first + 1);
    expect(currentOverviewGeneration()).toBe(second);
  });

  test("a new snapshot clears the cached previews", () => {
    const generation = storeOverviewSnapshot(snapshot(NOW_MS));
    expect(storeOverviewPreview(generation, "a1", "c1", preview("hello"))).toBe(
      true,
    );
    expect(readCachedOverviewPreview("a1", "c1")).toEqual(preview("hello"));

    storeOverviewSnapshot(snapshot(NOW_MS + 1));

    expect(readCachedOverviewPreview("a1", "c1")).toBeNull();
  });

  test("a preview read from an older generation is refused", () => {
    const generation = storeOverviewSnapshot(snapshot(NOW_MS));
    storeOverviewSnapshot(snapshot(NOW_MS + 1));

    expect(storeOverviewPreview(generation, "a1", "c1", preview("stale"))).toBe(
      false,
    );
    expect(readCachedOverviewPreview("a1", "c1")).toBeNull();
  });

  test("reset opens a new generation", () => {
    const generation = storeOverviewSnapshot(snapshot(NOW_MS));
    resetOverviewCache();
    expect(currentOverviewGeneration()).toBe(generation + 1);
  });
});

describe("preview cache", () => {
  test("keys by agent and conversation", () => {
    const generation = storeOverviewSnapshot(snapshot(NOW_MS, ["a1", "a2"]));

    storeOverviewPreview(generation, "a1", "default", preview("one"));
    storeOverviewPreview(generation, "a2", "default", preview("two"));

    expect(readCachedOverviewPreview("a1", "default")).toEqual(preview("one"));
    expect(readCachedOverviewPreview("a2", "default")).toEqual(preview("two"));
    expect(overviewPreviewKey("a1", "default")).not.toBe(
      overviewPreviewKey("a2", "default"),
    );
    expect(readCachedOverviewPreview("a1", "other")).toBeNull();
  });

  test("tracks one in-flight read per conversation", async () => {
    let resolveRead!: (value: OverviewConversationPreview) => void;
    const promise = new Promise<OverviewConversationPreview>((resolve) => {
      resolveRead = resolve;
    });
    const key = overviewPreviewKey("a1", "c1");

    expect(readInFlightOverviewPreview(key)).toBeNull();
    setInFlightOverviewPreview(key, promise);
    expect(readInFlightOverviewPreview(key)).toBe(promise);

    resolveRead(preview("done"));
    expect(await promise).toEqual(preview("done"));

    clearInFlightOverviewPreview(key);
    expect(readInFlightOverviewPreview(key)).toBeNull();
  });
});

describe("in-flight snapshot", () => {
  test("holds the running fetch until it is cleared", () => {
    const promise = Promise.resolve(snapshot(NOW_MS));

    expect(readInFlightOverviewSnapshot()).toBeNull();
    setInFlightOverviewSnapshot(promise);
    expect(readInFlightOverviewSnapshot()).toBe(promise);

    setInFlightOverviewSnapshot(null);
    expect(readInFlightOverviewSnapshot()).toBeNull();
  });
});
