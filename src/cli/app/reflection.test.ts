import { describe, expect, test } from "bun:test";
import { formatReflectionSettings } from "@/cli/app/reflection";

describe("formatReflectionSettings", () => {
  test("prints the two switches and the run policy", () => {
    expect(
      formatReflectionSettings({
        onCompaction: true,
        everyUserMessages: 0,
        timeoutMinutes: 3,
        deleteSessionOnSuccess: true,
      }),
    ).toBe("on compaction; timeout 3 min; delete session on success");

    expect(
      formatReflectionSettings({
        onCompaction: false,
        everyUserMessages: 0,
        timeoutMinutes: 5,
        deleteSessionOnSuccess: false,
      }),
    ).toBe("off; timeout 5 min; keep session on success");

    expect(
      formatReflectionSettings({
        onCompaction: true,
        everyUserMessages: 25,
        timeoutMinutes: 3,
        deleteSessionOnSuccess: true,
      }),
    ).toBe(
      "on compaction + every 25 user messages; timeout 3 min; delete session on success",
    );
  });
});
