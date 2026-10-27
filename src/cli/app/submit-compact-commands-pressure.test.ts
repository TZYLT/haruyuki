/**
 * The pre-send pressure path (D-112 + F-04 §5.1 step 1).
 *
 * `offerTrimBeforeSend` runs before a message goes out, and its contract is that
 * the message is sent whatever happens: the compaction may run, be cancelled, or
 * fail, and none of those may drop what the user typed. What the tests pin is
 * therefore the order and the exits:
 *
 * - `ok`/`soft` never call the summarizer;
 * - `hard` runs one `prepare`, then one `apply` with the rate's own pick — no
 *   picker, because the user already said "send this";
 * - Esc aborts the call (`signal.aborted`), writes nothing, and records
 *   `cancelled`;
 * - a failure is reported in words and names `/compact`, instead of letting a
 *   still-oversized turn go out silently.
 *
 * The summarizer and the write-back are other milestones', so the runtime is a
 * fixture; the conversation and its topic blocks are real (temporary root).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { offerTrimBeforeSend } from "@/cli/app/submit-compact-commands";
import { compactionOverlayRequest } from "@/cli/helpers/topic-trim-request";
import { settingsManager } from "@/settings-manager";
import {
  cleanupCompactHarness,
  createStorageDirectory,
  fixtureRuntime,
  type Harness,
  harness,
  localConversation,
  topicBlocks,
} from "@/test-utils/compact-command-harness";
import { readUsageLedger } from "@/usage/ledger";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;

beforeEach(async () => {
  // The hard tier now writes a ledger row, whose default path is the real home.
  process.env.HARUYUKI_HOME = await createStorageDirectory();
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  __testSetBackend(null);
  await cleanupCompactHarness();
});

/** A conversation at the hard threshold, optionally with one marker. */
async function crowded(options: {
  turns?: number;
  marker?: string;
  contextTokens?: number;
}): Promise<Harness & { blocks: ReturnType<typeof topicBlocks> }> {
  const local = await localConversation(
    options.turns ?? 8,
    options.marker === undefined
      ? undefined
      : { afterTurn: 4, title: options.marker },
  );
  const h = harness({
    conversationId: local.conversationId,
    agentId: local.agentId,
    contextWindow: 1_000,
    contextTokens: options.contextTokens ?? 900,
  });
  return {
    ...h,
    blocks: topicBlocks(local.backend, local.conversationId, local.agentId),
  };
}

describe("offerTrimBeforeSend (D-112)", () => {
  test("an uncrowded context says nothing and calls no summarizer", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 100,
    });
    const { runtime, calls } = fixtureRuntime({
      blocks: [],
      suggestionIndex: 1,
    });
    h.ctx.compaction = runtime;

    await offerTrimBeforeSend(h.ctx);

    expect(h.commands).toEqual([]);
    expect(h.overlays).toEqual([]);
    expect(calls.prepared).toEqual([]);
    expect(calls.applied).toEqual([]);
  });

  test("a soft crossing prints one line, does not repeat it, and does not compact", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 750,
    });
    const { runtime, calls } = fixtureRuntime({
      blocks: [],
      suggestionIndex: 1,
    });
    h.ctx.compaction = runtime;

    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("about 75%");
    expect(h.commands[0]?.output).toContain("/compact compresses older topics");
    expect(calls.prepared).toEqual([]);

    // Same tier again: no second line.
    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toHaveLength(1);

    // Dropping back under the threshold re-arms the notice.
    h.tracker.lastContextTokens = 100;
    await offerTrimBeforeSend(h.ctx);
    h.tracker.lastContextTokens = 750;
    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toHaveLength(2);
  });

  test("a hard crossing prepares once and applies the rate's own pick, with no picker", async () => {
    const h = await crowded({ marker: "Alpha" });
    const { runtime, calls } = fixtureRuntime({
      blocks: h.blocks,
      suggestionIndex: 2,
    });
    h.ctx.compaction = runtime;

    await offerTrimBeforeSend(h.ctx);

    expect(calls.prepared).toHaveLength(1);
    expect(calls.applied).toEqual([{ kind: "ratio_suggestion" }]);
    // No picker: the user already asked to send, so nothing parks a request.
    expect(compactionOverlayRequest()).toBeNull();
    // The preparing face was raised and taken down again.
    expect(h.overlays).toEqual(["compaction", null]);
    expect(h.commands.at(-1)?.output).toContain("Compaction complete.");
    // The pressure baseline is re-based on what was kept.
    expect(h.tracker.lastContextTokens).toBe(320);
    expect(h.tracker.lastPressureNotice).toBeUndefined();
  });

  test("a hard crossing with no markers still compacts, and says why the rate decided", async () => {
    const h = await crowded({});
    const { runtime, calls } = fixtureRuntime({
      blocks: h.blocks,
      suggestionIndex: 1,
    });
    h.ctx.compaction = runtime;

    await offerTrimBeforeSend(h.ctx);

    expect(calls.applied).toEqual([{ kind: "ratio_suggestion" }]);
    expect(h.commands.at(-1)?.output).toContain("Compaction complete.");
    // The hint explains that no marker defines a boundary, so the rate did it.
    expect(h.commands.at(-1)?.output).toContain("No topic markers yet");
  });

  test("a degraded preview is reported, not hidden", async () => {
    const h = await crowded({ marker: "Alpha" });
    const { runtime } = fixtureRuntime({
      blocks: h.blocks,
      suggestionIndex: 2,
      degraded: "refusal",
    });
    h.ctx.compaction = runtime;

    await offerTrimBeforeSend(h.ctx);

    expect(h.commands.at(-1)?.output).toContain(
      "the summarizer refused or was unavailable",
    );
  });

  test("a failed preparation writes nothing and says the turn is going out uncompressed", async () => {
    const h = await crowded({ marker: "Alpha" });
    const { runtime, calls } = fixtureRuntime({
      blocks: h.blocks,
      suggestionIndex: 2,
      prepareError: new Error("the provider is offline"),
    });
    h.ctx.compaction = runtime;

    await offerTrimBeforeSend(h.ctx);

    expect(calls.applied).toEqual([]);
    expect(h.commands.at(-1)?.failed).toBe(true);
    expect(h.commands.at(-1)?.output).toContain("could not run");
    expect(h.commands.at(-1)?.output).toContain("the provider is offline");
    // Not silent, and not a dead end: the row names the way to try again.
    expect(h.commands.at(-1)?.output).toContain("/compact");
    expect(h.overlays).toEqual(["compaction", null]);
    expect((await readUsageLedger()).at(-1)).toMatchObject({
      source: "compaction",
      outcome: "failed",
    });
  });

  test("Esc during the preparation aborts the call, writes nothing, and records the cancellation", async () => {
    const h = await crowded({ marker: "Alpha" });
    const { runtime, calls } = fixtureRuntime({
      blocks: h.blocks,
      suggestionIndex: 2,
    });
    let preparedSignal: AbortSignal | undefined;
    // A summarizer that only ends when the signal fires: the case §5.2.6 says the
    // user's Escape is the only exit from.
    runtime.prepare = (input) => {
      calls.prepared.push({
        conversationId: input.conversationId,
        agentId: input.agentId,
        hasSignal: input.signal !== undefined,
      });
      preparedSignal = input.signal;
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    };
    h.ctx.compaction = runtime;

    const pending = offerTrimBeforeSend(h.ctx);
    await Bun.sleep(0);

    // What the overlay's Esc binding does: the face parks an `onCancel`.
    const face = compactionOverlayRequest();
    expect(face?.kind).toBe("preparing");
    if (face?.kind === "preparing") face.request.onCancel();
    await pending;

    expect(preparedSignal?.aborted).toBe(true);
    expect(calls.applied).toEqual([]);
    expect(h.commands.at(-1)?.output).toContain("Compaction cancelled");
    expect(h.commands.at(-1)?.output).toContain("message is being sent");
    expect((await readUsageLedger()).at(-1)).toMatchObject({
      source: "compaction",
      outcome: "cancelled",
    });
  });

  test("a failed write-back writes no context change and records the failure", async () => {
    const h = await crowded({ marker: "Alpha" });
    const { runtime } = fixtureRuntime({
      blocks: h.blocks,
      suggestionIndex: 2,
      applyError: new Error("the rewrite was refused"),
    });
    h.ctx.compaction = runtime;

    await offerTrimBeforeSend(h.ctx);

    expect(h.commands.at(-1)?.failed).toBe(true);
    expect(h.commands.at(-1)?.output).toContain("the rewrite was refused");
    // Nothing was written, so the baseline is exactly where the turn left it.
    expect(h.tracker.lastContextTokens).toBe(900);
    expect(h.descriptions()).toBe(0);
    expect((await readUsageLedger()).at(-1)).toMatchObject({
      source: "compaction",
      outcome: "failed",
    });
  });

  test("a cloud backend is left alone", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const h = harness({
      conversationId: "default",
      agentId: "agent-x",
      contextWindow: 1_000,
      contextTokens: 900,
    });

    await offerTrimBeforeSend(h.ctx);

    expect(h.commands).toEqual([]);
    expect(h.overlays).toEqual([]);
  });
});

/**
 * D-115: `topicSoftPressureRatio` decides where the advisory line starts, and
 * `0` turns it off (the hard tier is not the user's to configure here).
 */
describe("the advisory tier follows topicSoftPressureRatio (D-115)", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "compact-ratio-settings-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  /** 75% of the window: above the default 0.7, below the 0.8 hard threshold. */
  async function crowdedForRatio(): Promise<Harness> {
    const local = await localConversation(2);
    return harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 750,
    });
  }

  test("0 turns the advisory line off", async () => {
    settingsManager.updateSettings({ topicSoftPressureRatio: 0 });
    const h = await crowdedForRatio();

    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toEqual([]);
    expect(h.overlays).toEqual([]);
  });

  test("a lower ratio starts advising sooner", async () => {
    settingsManager.updateSettings({ topicSoftPressureRatio: 0.5 });
    const h = await crowdedForRatio();

    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("about 75%");
  });
});

/**
 * D-114: the user's half of the no-marker nudge. The reminder engine decides it
 * while building this turn's message and parks the numbers on the shared
 * reminder state; the send path prints the line once and clears it.
 */
describe("the topic nudge line (D-114)", () => {
  test("prints the parked notice once and clears it", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 10_000,
      contextTokens: 100,
    });
    h.reminderState.pendingTopicNudge = {
      turnsSinceLastMarker: 52,
      nudgeTurns: 50,
    };

    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain(
      "52 user turns without a topic marker",
    );
    expect(h.commands[0]?.output).toContain("/topic <title>");
    expect(h.reminderState.pendingTopicNudge).toBeNull();

    // Nothing parked: the next send says nothing at all.
    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toHaveLength(1);
  });

  test("a cloud backend never prints it", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const h = harness({
      conversationId: "default",
      agentId: "agent-x",
      contextWindow: 10_000,
      contextTokens: 100,
    });
    h.reminderState.pendingTopicNudge = {
      turnsSinceLastMarker: 52,
      nudgeTurns: 50,
    };

    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toEqual([]);
    expect(h.reminderState.pendingTopicNudge).not.toBeNull();
  });
});

/**
 * Feature ②: the user's half of a recall degradation, timeout, or breaker trip.
 * Same contract as the topic nudge above — the provider parks the notice while
 * the turn is being built, and the send path prints it once and clears it.
 */
describe("the recall notice line (feature ②)", () => {
  test("prints a parked degradation once and clears it", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 10_000,
      contextTokens: 100,
    });
    h.reminderState.pendingRecallNotice = { kind: "index-missing" };

    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("/recall build");
    expect(h.reminderState.pendingRecallNotice).toBeNull();

    // Nothing parked: the next send says nothing at all.
    await offerTrimBeforeSend(h.ctx);
    expect(h.commands).toHaveLength(1);
  });

  test("names the trip and how to undo it", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 10_000,
      contextTokens: 100,
    });
    h.reminderState.pendingRecallNotice = {
      kind: "tripped",
      failures: 3,
      reason: "the recall deadline expired",
    };

    await offerTrimBeforeSend(h.ctx);
    expect(h.commands[0]?.output).toContain("3 turns in a row");
    expect(h.commands[0]?.output).toContain("/recall on");
    expect(h.reminderState.pendingRecallNotice).toBeNull();
  });
});
