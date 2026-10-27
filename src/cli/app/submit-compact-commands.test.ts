/**
 * `/compact`'s dispatch and its state machine (D-110 + D-119 + F-04).
 *
 * The command is where "the user picks the cut point" happens, so the claims
 * under test are: a numbered pick resolves to an identity and applies the
 * prepared preview; a bare `/compact` parks the preview's rows for the picker
 * instead of writing anything; an unmarked conversation applies the rate's own
 * pick without a picker; mode arguments are refused locally; and a non-local
 * backend keeps the cloud path.
 *
 * The summarizer and the write-back are other milestones' (`fixtureRuntime`), so
 * the environment here is a real `LocalBackend` on a temporary root (for the real
 * numbering table) plus a fake command runner. Receipts, cancellation and the
 * usage ledger have their own file (`submit-compact-commands.receipt.test.ts`);
 * the pre-send pressure path has another
 * (`submit-compact-commands-pressure.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  handleCompactCommand,
  isCompactCommand,
} from "@/cli/app/submit-compact-commands";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
} from "@/cli/helpers/compact-command";
import { takeTopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import {
  cleanupCompactHarness,
  createStorageDirectory,
  fixtureRuntime,
  harness,
  localConversation,
  topicBlocks,
} from "@/test-utils/compact-command-harness";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;

beforeEach(async () => {
  // Reaching `apply` also reaches the usage ledger, whose default path is the
  // real home; redirect it for the whole file (`《31》A2`).
  process.env.HARUYUKI_HOME = await createStorageDirectory();
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  __testSetBackend(null);
  takeTopicTrimRequest();
  await cleanupCompactHarness();
});

describe("isCompactCommand", () => {
  test("matches the command and its arguments only", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("  /compact 2 ")).toBe(true);
    expect(isCompactCommand("/compaction")).toBe(false);
    expect(isCompactCommand("/topics")).toBe(false);
  });
});

describe("handleCompactCommand", () => {
  test("help prints the new usage and touches no backend", async () => {
    const h = harness({ conversationId: "c", agentId: "a" });

    await handleCompactCommand("/compact help", h.ctx);

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.succeeded).toBe(true);
    expect(h.commands[0]?.output).toBe(COMPACT_COMMAND_USAGE);
    expect(h.commands[0]?.output).toContain("/compact <n>");
  });

  test("an invalid argument is refused with the usage", async () => {
    const h = harness({ conversationId: "c", agentId: "a" });

    await handleCompactCommand("/compact nope", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain('Unknown argument "nope"');
  });

  test("a numbered pick prepares once, then applies that block's identity", async () => {
    const local = await localConversation(8);
    local.markTopic("Alpha");
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    // Pretend the one-shot execution-context reminders were already sent: a
    // compaction must re-arm them, because it evicted what they described.
    h.reminderState.hasSentAgentInfo = true;
    h.reminderState.hasSentSessionContext = true;

    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({ blocks, suggestionIndex: 2 });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact 2", h.ctx);

    // One preparation, one apply, and the pick is the *identity* the numbering
    // table had at parse time — not a row number (§5.6.3).
    expect(calls.prepared).toEqual([
      {
        conversationId: local.conversationId,
        agentId: local.agentId,
        hasSignal: true,
      },
    ]);
    expect(calls.applied).toEqual([
      { kind: "message", messageId: blocks[1]?.boundaryMessageId ?? "" },
    ]);

    const receipt = h.commands.at(-1)?.output ?? "";
    expect(receipt).toContain("Compaction complete.");
    expect(receipt).toContain("cut point:  the topic block you picked");
    // A compaction owes the reminder runtime and the description a refresh.
    expect(h.reminderState.hasSentAgentInfo).toBe(false);
    expect(h.reminderState.pendingSessionContextReason).toBe("post_compaction");
    expect(h.descriptions()).toBe(1);
    // No picker was involved.
    expect(h.overlays).toEqual(["compaction", null]);
    expect(takeTopicTrimRequest()).toBeNull();
  });

  test("an out-of-range block is refused by name, before anything is prepared", async () => {
    const local = await localConversation(4);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const { runtime, calls } = fixtureRuntime({
      blocks: [],
      suggestionIndex: 1,
    });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact 9", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("There is no topic block 9");
    // The refusal costs no summarizer call: the numbering table answered.
    expect(calls.prepared).toEqual([]);
  });

  test("block 1 is a legal pick and the receipt says the rate decided", async () => {
    const local = await localConversation(8);
    local.markTopic("Alpha");
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({
      blocks,
      suggestionIndex: 1,
      // Block 1 keeps the whole context, so the rate caps the cut.
      applyResult: { source: "ratio_cap" },
    });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact 1", h.ctx);

    expect(calls.applied).toEqual([
      { kind: "message", messageId: blocks[0]?.boundaryMessageId ?? "" },
    ]);
    expect(h.commands.at(-1)?.output).toContain(
      "the picked block kept more than the rate allows",
    );
  });

  test("a successful compaction re-bases the pressure baseline (M-5)", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 2_000,
      contextTokens: 1_900,
    });
    h.tracker.lastPressureNotice = "hard";
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime } = fixtureRuntime({
      blocks,
      suggestionIndex: 2,
      applyResult: { stats: { context_tokens_after: 320 } },
    });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact 2", h.ctx);

    // The context shrank without a provider round trip, so the very next send has
    // to be judged on what is left rather than on the tokens the trim removed.
    expect(h.tracker.lastContextTokens).toBe(320);
    // A fresh baseline deserves a fresh notice.
    expect(h.tracker.lastPressureNotice).toBeUndefined();
  });

  test("a refused trim leaves the pressure baseline alone (M-5)", async () => {
    // An empty context cannot be trimmed at all, so the baseline must stay where
    // the last provider round trip left it.
    const local = await localConversation(0);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 2_000,
      contextTokens: 1_900,
    });

    await handleCompactCommand("/compact", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain(
      "nothing in this conversation's context to trim",
    );
    expect(h.tracker.lastContextTokens).toBe(1_900);
  });

  test("a bare /compact with blocks parks the preview's rows, then applies the pick", async () => {
    // The marker closes a topic early, so the ratio suggestion lands in the
    // second block: the cursor's default is a block the user can pick.
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({ blocks, suggestionIndex: 2 });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact", h.ctx);

    // The invocation itself is on the record before the picker opens, so Esc or
    // Cancel leaves a trace (L-1); nothing has been applied yet.
    expect(calls.prepared).toHaveLength(1);
    expect(calls.applied).toEqual([]);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.input).toBe("/compact");
    expect(h.commands[0]?.output).toBe("Choose the topic block to keep...");
    expect(h.commands[0]?.succeeded).toBe(false);
    expect(h.overlays).toEqual(["compaction"]);
    const request = takeTopicTrimRequest();
    expect(request).not.toBeNull();
    expect(request?.blocks.map((block) => block.title)).toEqual([
      "Alpha",
      null,
    ]);
    expect(request?.suggestionIndex).toBe(2);

    // The pick resolves to the row's boundary id and applies the preview.
    request?.onPick(2);
    await Bun.sleep(25);
    expect(h.overlays.at(-1)).toBeNull();
    expect(calls.applied).toEqual([
      { kind: "message", messageId: blocks[1]?.boundaryMessageId ?? "" },
    ]);
    expect(h.commands.at(-1)?.output).toContain("Compaction complete.");
  });

  test("confirming the suggested row is reported as the ratio's suggestion (V9)", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime } = fixtureRuntime({ blocks, suggestionIndex: 2 });
    h.ctx.compaction = runtime;
    await handleCompactCommand("/compact", h.ctx);

    const request = takeTopicTrimRequest();
    expect(request?.suggestionIndex).toBe(2);
    // Enter on the default cursor row: the block is the ratio's suggestion.
    request?.onPick(request?.suggestionIndex ?? 0);
    await Bun.sleep(25);

    expect(h.commands.at(-1)?.output).toContain(
      "cut point:  compression rate (the block it points at",
    );
    expect(h.commands.at(-1)?.output).not.toContain(
      "the topic block you picked",
    );
  });

  test("picking block 1 from the picker is applied, not refused", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({
      blocks,
      suggestionIndex: 2,
      applyResult: { source: "ratio_cap" },
    });
    h.ctx.compaction = runtime;
    await handleCompactCommand("/compact", h.ctx);

    // Block 1 keeps the whole context, and the rate caps what any cut may keep,
    // so the pick resolves to the rate's own cut instead of doing nothing.
    takeTopicTrimRequest()?.onPick(1);
    await Bun.sleep(25);

    expect(calls.applied).toEqual([
      { kind: "message", messageId: blocks[0]?.boundaryMessageId ?? "" },
    ]);
    expect(h.commands.at(-1)?.output).toContain(
      "the picked block kept more than the rate allows",
    );
    expect(h.commands.at(-1)?.output).not.toContain("Nothing was written");
  });

  test("a bare /compact with no markers applies the rate's own pick and says why (D-119)", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({ blocks, suggestionIndex: 1 });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact", h.ctx);

    // No picker: the ratio's own selection, with the hint that explains why.
    expect(h.overlays).toEqual(["compaction", null]);
    expect(takeTopicTrimRequest()).toBeNull();
    expect(calls.applied).toEqual([{ kind: "ratio_suggestion" }]);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("Compaction complete.");
    expect(h.commands[0]?.output).toContain(
      "compression rate decided the cut point",
    );
  });

  test("one marker at the start of the context applies by the rate instead of a one-row picker (H-2)", async () => {
    // The marker's effective boundary clamps onto the first message, so the
    // context has a single block and there is no choice to offer.
    const local = await localConversation(8, { afterTurn: 1, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    const blocks = topicBlocks(
      local.backend,
      local.conversationId,
      local.agentId,
    );
    const { runtime, calls } = fixtureRuntime({ blocks, suggestionIndex: 1 });
    h.ctx.compaction = runtime;

    await handleCompactCommand("/compact", h.ctx);

    expect(h.overlays).toEqual(["compaction", null]);
    expect(takeTopicTrimRequest()).toBeNull();
    expect(calls.applied).toEqual([{ kind: "ratio_suggestion" }]);
    // The note must not claim nothing was marked: the marker is right there.
    expect(h.commands[0]?.output).toContain(
      "sits at the very start of the current context",
    );
    expect(h.commands[0]?.output).not.toContain("No topic markers yet");
  });

  test("a mode argument is refused locally", async () => {
    const local = await localConversation(4);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact sliding_window", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toBe(COMPACT_MODE_LOCAL_UNSUPPORTED);
  });

  test("a non-local backend keeps the cloud path and rejects block numbers", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const h = harness({ conversationId: "default", agentId: "agent-x" });

    await handleCompactCommand("/compact 3", h.ctx);
    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("requires the local backend");
  });
});
