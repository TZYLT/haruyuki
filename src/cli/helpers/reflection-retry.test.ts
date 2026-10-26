import { afterEach, describe, expect, test } from "bun:test";
import {
  clearReflectionRetry,
  isReflectionRetryDeferred,
  recordReflectionFailure,
  resetReflectionRetries,
} from "@/cli/helpers/reflection-retry";

afterEach(() => {
  resetReflectionRetries();
});

describe("reflection retry backoff", () => {
  test("is not deferred until a failure is recorded", () => {
    expect(isReflectionRetryDeferred("agent-a", "compaction")).toBe(false);
  });

  test("defers the next automatic trigger for 60s and doubles each failure", () => {
    const now = 1_000_000;
    expect(recordReflectionFailure("agent-a", now)).toBe(60_000);
    expect(
      isReflectionRetryDeferred("agent-a", "compaction", now + 59_999),
    ).toBe(true);
    expect(
      isReflectionRetryDeferred("agent-a", "compaction", now + 60_000),
    ).toBe(false);

    const second = recordReflectionFailure("agent-a", now + 60_000);
    expect(second).toBe(120_000);
    const third = recordReflectionFailure("agent-a", now + 180_000);
    expect(third).toBe(240_000);
  });

  test("caps the delay at 30 minutes", () => {
    let now = 0;
    let delay = 0;
    for (let index = 0; index < 12; index += 1) {
      delay = recordReflectionFailure("agent-a", now);
      now += delay;
    }
    expect(delay).toBe(30 * 60_000);
  });

  test("never defers a manual request, and scopes the window per agent", () => {
    recordReflectionFailure("agent-a", 5_000);
    expect(isReflectionRetryDeferred("agent-a", "manual", 5_001)).toBe(false);
    expect(isReflectionRetryDeferred("agent-b", "compaction", 5_001)).toBe(
      false,
    );
    expect(isReflectionRetryDeferred("agent-a", "user-messages", 5_001)).toBe(
      true,
    );
  });

  test("a success clears the window", () => {
    recordReflectionFailure("agent-a", 10_000);
    expect(isReflectionRetryDeferred("agent-a", "compaction", 10_001)).toBe(
      true,
    );
    clearReflectionRetry("agent-a");
    expect(isReflectionRetryDeferred("agent-a", "compaction", 10_001)).toBe(
      false,
    );
  });
});
