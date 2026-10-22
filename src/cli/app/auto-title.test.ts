import { describe, expect, test } from "bun:test";
import { type AutoTitleInput, maybeAutoTitleConversation } from "./auto-title";

function harness(overrides: Partial<AutoTitleInput> = {}) {
  const applied: string[] = [];
  const failures: unknown[] = [];
  const flags = { shouldGenerate: true, inFlight: false };
  const input: AutoTitleInput = {
    shouldGenerate: flags.shouldGenerate,
    inFlight: flags.inFlight,
    conversationId: "conv-1",
    currentConversationId: () => "conv-1",
    stillWanted: () => flags.shouldGenerate,
    generate: async () => "Fix the mouse handover",
    update: async () => undefined,
    onApplied: (summary) => applied.push(summary),
    onFailure: (error) => failures.push(error),
    setShouldGenerate: (value) => {
      flags.shouldGenerate = value;
    },
    setInFlight: (value) => {
      flags.inFlight = value;
    },
    ...overrides,
  };
  return { input, flags, applied, failures };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("maybeAutoTitleConversation", () => {
  test("generates once and applies the title", async () => {
    const { input, flags, applied } = harness();
    await maybeAutoTitleConversation(input);
    await flush();
    expect(applied).toEqual(["Fix the mouse handover"]);
    expect(flags.shouldGenerate).toBe(false);
    expect(flags.inFlight).toBe(false);
  });

  test("does nothing when a title is not wanted or already in flight", async () => {
    let generated = 0;
    const skip = harness({
      shouldGenerate: false,
      generate: async () => {
        generated += 1;
        return "x";
      },
    });
    await maybeAutoTitleConversation(skip.input);
    const busy = harness({
      inFlight: true,
      generate: async () => {
        generated += 1;
        return "x";
      },
    });
    await maybeAutoTitleConversation(busy.input);
    expect(generated).toBe(0);
  });

  test("the default conversation never gets a generated title", async () => {
    let generated = 0;
    const { input } = harness({
      conversationId: "default",
      generate: async () => {
        generated += 1;
        return "x";
      },
    });
    await maybeAutoTitleConversation(input);
    expect(generated).toBe(0);
  });

  test("an empty title hands the flag back without a write", async () => {
    let updates = 0;
    const { input, flags } = harness({
      generate: async () => null,
      update: async () => {
        updates += 1;
      },
    });
    await maybeAutoTitleConversation(input);
    expect(updates).toBe(0);
    expect(flags.inFlight).toBe(false);
    expect(flags.shouldGenerate).toBe(true);
  });

  test("a conversation switched mid-generation is abandoned", async () => {
    let updates = 0;
    const { input, flags } = harness({
      currentConversationId: () => "conv-2",
      update: async () => {
        updates += 1;
      },
    });
    await maybeAutoTitleConversation(input);
    expect(updates).toBe(0);
    expect(flags.inFlight).toBe(false);
  });

  test("an unwanted title after the await is not written", async () => {
    const flags = { shouldGenerate: true, inFlight: false };
    let updates = 0;
    const { input } = harness({
      stillWanted: () => flags.shouldGenerate,
      update: async () => {
        updates += 1;
      },
    });
    // The user renamed the conversation while the model was thinking.
    flags.shouldGenerate = false;
    await maybeAutoTitleConversation(input);
    expect(updates).toBe(0);
  });

  test("a failed write is reported once and clears the in-flight flag", async () => {
    const failure = new Error("backend down");
    const { input, flags, failures } = harness({
      update: async () => {
        throw failure;
      },
    });
    await maybeAutoTitleConversation(input);
    await flush();
    expect(failures).toEqual([failure]);
    expect(flags.inFlight).toBe(false);
    expect(flags.shouldGenerate).toBe(true);
  });
});
