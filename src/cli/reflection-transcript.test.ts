import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendExternalTranscriptEntries,
  appendTranscriptDeltaJsonl,
  applyPendingReflectionUserMessages,
  buildParentMemorySnapshot,
  consumeReflectionUserMessageTrigger,
  getReflectionTranscriptPaths,
  getReflectionTranscriptState,
  markReflectionUserMessagesReflected,
  REFLECTION_STATE_SCHEMA_VERSION,
  recordReflectionUserMessage,
} from "@/cli/helpers/reflection-transcript";

describe("reflection-transcript user-message accounting (F-03)", () => {
  const agentId = "agent-test";
  const conversationId = "conv-test";
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "letta-transcript-test-"));
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.LETTA_TRANSCRIPT_ROOT;
    await rm(testRoot, { recursive: true, force: true });
  });

  test("a fresh conversation starts at zero", async () => {
    const state = await getReflectionTranscriptState(agentId, conversationId);

    expect(state).toEqual({
      schema_version: REFLECTION_STATE_SCHEMA_VERSION,
      total_user_messages: 0,
      reflected_user_messages: 0,
      messages_since_last_successful_reflection: 0,
    });
  });

  test("user messages accumulate per conversation", async () => {
    await recordReflectionUserMessage(agentId, conversationId);
    await recordReflectionUserMessage(agentId, conversationId, 2);
    await recordReflectionUserMessage(agentId, "other-conversation");

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_user_messages).toBe(3);
    expect(state.messages_since_last_successful_reflection).toBe(3);

    const other = await getReflectionTranscriptState(
      agentId,
      "other-conversation",
    );
    expect(other.total_user_messages).toBe(1);
  });

  test("a non-positive count is a no-op", async () => {
    await recordReflectionUserMessage(agentId, conversationId, 0);
    await recordReflectionUserMessage(agentId, conversationId, -4);
    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_user_messages).toBe(0);
  });

  test("counted messages arm the one-shot trigger flag", async () => {
    const before = await getReflectionTranscriptState(agentId, conversationId);
    expect(before.pending_user_message_trigger).toBeUndefined();

    await recordReflectionUserMessage(agentId, conversationId);
    const armed = await getReflectionTranscriptState(agentId, conversationId);
    expect(armed.pending_user_message_trigger).toBe(true);

    expect(
      await consumeReflectionUserMessageTrigger(agentId, conversationId),
    ).toBe(true);
    const consumed = await getReflectionTranscriptState(
      agentId,
      conversationId,
    );
    expect(consumed.pending_user_message_trigger).toBeUndefined();
    // Notification turns find nothing armed.
    expect(
      await consumeReflectionUserMessageTrigger(agentId, conversationId),
    ).toBe(false);
  });

  test("a launch stages the mark and completion applies it", async () => {
    await recordReflectionUserMessage(agentId, conversationId, 5);
    const staged = await markReflectionUserMessagesReflected(
      agentId,
      conversationId,
    );

    // A started run does not make the messages reflected yet.
    expect(staged.reflected_user_messages).toBe(0);
    expect(staged.pending_reflected_user_messages).toBe(5);
    expect(staged.last_reflection_started_at).toBeTruthy();

    const completed = await applyPendingReflectionUserMessages(
      agentId,
      conversationId,
    );
    expect(completed.reflected_user_messages).toBe(5);
    expect(completed.pending_reflected_user_messages).toBeUndefined();
    expect(completed.messages_since_last_successful_reflection).toBe(0);
    expect(completed.last_reflection_succeeded_at).toBeTruthy();

    // New messages arm the counter again without losing the mark.
    const next = await recordReflectionUserMessage(agentId, conversationId);
    expect(next.reflected_user_messages).toBe(5);
    expect(next.messages_since_last_successful_reflection).toBe(1);

    // Applying again is a no-op.
    const again = await applyPendingReflectionUserMessages(
      agentId,
      conversationId,
    );
    expect(again.reflected_user_messages).toBe(5);
  });

  test("appending the transcript does not touch the user-message counters", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "hello", messageId: "u1" },
      {
        kind: "assistant",
        id: "a1",
        text: "hi",
        phase: "finished",
        messageId: "a1",
      },
    ]);

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_user_messages).toBe(0);
  });

  test("an old state file is discarded and the counters restart at zero", async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await mkdir(paths.rootDir, { recursive: true });
    await writeFile(
      paths.statePath,
      JSON.stringify({
        schema_version: "v3_assistant_steps",
        total_completed_steps: 42,
        reflected_completed_steps: 17,
        steps_since_last_successful_reflection: 25,
        reflected_through_message_id: "msg-42",
      }),
      "utf-8",
    );

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.schema_version).toBe(REFLECTION_STATE_SCHEMA_VERSION);
    expect(state.total_user_messages).toBe(0);
    expect(state.reflected_user_messages).toBe(0);

    // The rewrite is persisted, so the next read is a plain v4 read.
    const persisted = JSON.parse(await readFile(paths.statePath, "utf-8"));
    expect(persisted.schema_version).toBe(REFLECTION_STATE_SCHEMA_VERSION);
    expect(persisted.total_completed_steps).toBeUndefined();
  });

  test("a corrupt reflected mark is clamped to the total", async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await mkdir(paths.rootDir, { recursive: true });
    await writeFile(
      paths.statePath,
      JSON.stringify({
        schema_version: REFLECTION_STATE_SCHEMA_VERSION,
        total_user_messages: 2,
        reflected_user_messages: 9,
      }),
      "utf-8",
    );

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.reflected_user_messages).toBe(2);
    expect(state.messages_since_last_successful_reflection).toBe(0);
  });

  test("external transcript ingestion stays idempotent", async () => {
    const first = await appendExternalTranscriptEntries(
      agentId,
      conversationId,
      [{ kind: "user", text: "one", source_message_id: "m1" }],
    );
    const second = await appendExternalTranscriptEntries(
      agentId,
      conversationId,
      [
        { kind: "user", text: "one", source_message_id: "m1" },
        { kind: "assistant", text: "two", source_message_id: "m2" },
      ],
    );

    expect(first).toEqual({ appended: 1, skipped: 0 });
    expect(second).toEqual({ appended: 1, skipped: 1 });
  });
});

describe("buildParentMemorySnapshot", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "letta-memory-snapshot-test-"));
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  test("renders the tree and inlines system memory only", async () => {
    const memoryDir = join(testRoot, "memory");
    await mkdir(join(memoryDir, "system"), { recursive: true });
    await mkdir(join(memoryDir, "reference"), { recursive: true });
    await mkdir(join(memoryDir, "skills", "bird"), { recursive: true });

    await writeFile(
      join(memoryDir, "system", "human.md"),
      "---\ndescription: User context\n---\nDr. Wooders prefers direct answers.\n",
      "utf-8",
    );
    await writeFile(
      join(memoryDir, "reference", "project.md"),
      "---\ndescription: Project notes\n---\nletta-code CLI details\n",
      "utf-8",
    );
    await writeFile(
      join(memoryDir, "skills", "bird", "SKILL.md"),
      "---\nname: bird\ndescription: X/Twitter CLI for posting\n---\nThis body should not be inlined into parent memory.\n",
      "utf-8",
    );

    const snapshot = await buildParentMemorySnapshot(memoryDir);

    expect(snapshot).toContain("<parent_memory>");
    expect(snapshot).toContain("project.md (Project notes)");
    expect(snapshot).toContain("<path>$MEMORY_DIR/system/human.md</path>");
    expect(snapshot).toContain("Dr. Wooders prefers direct answers.");
    expect(snapshot).not.toContain(
      "<path>$MEMORY_DIR/reference/project.md</path>",
    );
    expect(snapshot).not.toContain(
      "This body should not be inlined into parent memory.",
    );
    expect(snapshot).toContain("</parent_memory>");
  });
});
