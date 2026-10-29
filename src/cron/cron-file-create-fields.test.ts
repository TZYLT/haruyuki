import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask, listTasks } from "@/cron/cron-file";

// ── Test setup (same isolation as cron-file.test.ts) ────────────────

const TEST_DIR = path.join(import.meta.dir, "__cron_create_fields_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: "agent-create-fields",
    conversation_id: "default",
    name: "Create fields",
    description: "",
    cron: "0 9 * * *",
    recurring: true,
    prompt: "hello",
    ...overrides,
  } as Parameters<typeof addTask>[0];
}

// ── M0 F-09 / F-14: target and conversation_id on creation ──────────

describe("addTask target fields", () => {
  test("derives conversation_id from an explicit target (M0 F-09)", () => {
    const { task } = addTask(
      makeInput({
        target: { kind: "existing", conversation_id: "conv-1" },
        conversation_id: undefined,
      }),
    );

    expect(task.conversation_id).toBe("conv-1");
    expect(task.target).toEqual({
      kind: "existing",
      conversation_id: "conv-1",
    });
    expect(listTasks({ conversation_id: "conv-1" })).toHaveLength(1);
    expect(listTasks({ conversation_id: "new" })).toHaveLength(0);
  });

  test("derives an existing target from conversation_id", () => {
    const { task } = addTask(
      makeInput({ conversation_id: "conv-2", target: undefined }),
    );

    expect(task.conversation_id).toBe("conv-2");
    expect(task.target).toEqual({
      kind: "existing",
      conversation_id: "conv-2",
    });
  });

  test("refuses a target that contradicts conversation_id", () => {
    expect(() =>
      addTask(
        makeInput({
          target: { kind: "existing", conversation_id: "conv-1" },
          conversation_id: "conv-2",
        }),
      ),
    ).toThrow(/disagree/);
  });

  test("refuses a command task that would create a new conversation (M0 F-14)", () => {
    expect(() =>
      addTask(
        makeInput({
          type: "command",
          payload: "compact",
          target: { kind: "new", hidden: false },
          conversation_id: undefined,
        }),
      ),
    ).toThrow(/existing conversation/);

    expect(() =>
      addTask(
        makeInput({
          type: "command",
          payload: "compact",
          conversation_id: "new",
          target: undefined,
        }),
      ),
    ).toThrow(/existing conversation/);

    const existing = addTask(
      makeInput({
        type: "command",
        payload: "compact",
        target: { kind: "existing", conversation_id: "conv-1" },
        conversation_id: undefined,
      }),
    );
    expect(existing.task.type).toBe("command");
  });
});
