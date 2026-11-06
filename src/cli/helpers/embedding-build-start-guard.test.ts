/**
 * State machine behind the embedding build host's async start window
 * (`embedding-build-start-guard.ts`).
 *
 * These tests pin the two synchronous facts the host cannot derive later: only
 * one start may own the preflight window, and a cancel that lands in it is
 * recorded (not lost) and cleared by exactly the claim that owns it. The
 * host-level red/green evidence lives in `embedding-build-host-start-race.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { createEmbeddingBuildStartGuard } from "@/cli/helpers/embedding-build-start-guard";

describe("embedding build start guard", () => {
  test("a second claim while one is open is refused", () => {
    const guard = createEmbeddingBuildStartGuard();
    const first = guard.tryBegin();
    expect(first).not.toBeNull();
    expect(guard.tryBegin()).toBeNull();
    if (first !== null) guard.finish(first);
    expect(guard.tryBegin()).not.toBeNull();
  });

  test("a finish with an older token does not release a newer claim", () => {
    const guard = createEmbeddingBuildStartGuard();
    const first = guard.tryBegin();
    guard.reset();
    const second = guard.tryBegin();
    expect(second).not.toBeNull();
    if (first !== null) guard.finish(first);
    // Still claimed by `second`.
    expect(guard.tryBegin()).toBeNull();
  });

  test("cancel is recorded only while a start owns the window", () => {
    const guard = createEmbeddingBuildStartGuard();
    expect(guard.requestCancel()).toBe(false);
    expect(guard.isCancelRequested()).toBe(false);
    const token = guard.tryBegin();
    expect(guard.requestCancel()).toBe(true);
    expect(guard.isCancelRequested()).toBe(true);
    // The next claim starts clean: a fresh start is not cancelled by history.
    if (token !== null) guard.finish(token);
    guard.tryBegin();
    expect(guard.isCancelRequested()).toBe(false);
  });

  test("finish and reset both clear the intent", () => {
    const guard = createEmbeddingBuildStartGuard();
    const token = guard.tryBegin();
    guard.requestCancel();
    guard.reset();
    expect(guard.isCancelRequested()).toBe(false);
    expect(guard.tryBegin()).not.toBeNull();
    if (token !== null) guard.finish(token);
    expect(guard.isCancelRequested()).toBe(false);
  });
});
