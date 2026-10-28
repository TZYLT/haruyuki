import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CronTask, listTasks } from "@/cron";
import { runWithRuntimeContext } from "@/runtime-context";
import { wake } from "./wake";

const NOW = new Date("2026-09-24T05:00:00.000Z");

const SCOPE = {
  agentId: "agent-test",
  conversationId: "conv-current",
};

function payload(result: Awaited<ReturnType<typeof wake>>) {
  return JSON.parse(result.content) as Record<string, unknown>;
}

function localTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: "schedule-local",
    agent_id: SCOPE.agentId,
    conversation_id: SCOPE.conversationId,
    name: "check worker",
    description: "Self-scheduled wake: check worker",
    cron: "5 5 24 9 *",
    timezone: "UTC",
    recurring: false,
    prompt: "Check the worker.",
    status: "active",
    created_at: NOW.toISOString(),
    expires_at: null,
    last_fired_at: null,
    fire_count: 0,
    cancel_reason: null,
    jitter_offset_ms: 0,
    last_run_at: null,
    last_run_outcome: null,
    last_run_reason: null,
    last_run_error: null,
    last_missed_at: null,
    missed_count: 0,
    failed_count: 0,
    scheduled_for: new Date(NOW.getTime() + 300_000).toISOString(),
    fired_at: null,
    missed_at: null,
    ...overrides,
  };
}

function inScope<T>(fn: () => T): T {
  return runWithRuntimeContext(SCOPE, fn);
}

describe("Wake", () => {
  test("creates a local wake with an explicit timezone", async () => {
    let captured: unknown;
    const result = await inScope(() =>
      wake(
        {
          action: "create",
          name: "check worker",
          prompt: "Check the worker.",
          scheduled_at: "2026-09-24T09:00:00-07:00",
        },
        {
          now: () => NOW,
          listLocal: () => [],
          addLocal: (input) => {
            captured = input;
            return { task: localTask(), warning: "No listener is running." };
          },
        },
      ),
    );

    expect(captured).toMatchObject({
      agent_id: SCOPE.agentId,
      conversation_id: SCOPE.conversationId,
      timezone: "UTC",
      recurring: false,
      scheduled_for: new Date("2026-09-24T16:00:00Z"),
      // G-3/M-15: written explicitly, not left to the store's normalizer.
      type: "prompt",
      target: { kind: "existing", conversation_id: SCOPE.conversationId },
      permission: "unrestricted",
      catch_up: false,
      timeout_minutes: 30,
      wait_minutes: 10,
    });
    expect(payload(result)).toMatchObject({
      id: "schedule-local",
      runner: "local",
      warnings: ["No listener is running."],
    });
  });

  test("lists local wakes bound to the current conversation", async () => {
    const result = await inScope(() =>
      wake(
        { action: "list" },
        {
          listLocal: () => [
            localTask(),
            localTask({ id: "fired", status: "fired" }),
          ],
        },
      ),
    );

    expect(payload(result)).toMatchObject({
      action: "listed",
      conversation_id: SCOPE.conversationId,
      wakes: [{ id: "schedule-local", runner: "local" }],
    });
  });

  test("cancels only a wake visible in the current conversation", async () => {
    const deleted: string[] = [];
    const deps = {
      listLocal: () => [localTask()],
      deleteLocal: (id: string) => {
        deleted.push(id);
        return true;
      },
    };

    const missing = await inScope(() =>
      wake({ action: "cancel", id: "other" }, deps),
    );
    expect(missing.status).toBe("error");
    expect(deleted).toEqual([]);

    const cancelled = await inScope(() =>
      wake({ action: "cancel", id: "schedule-local" }, deps),
    );
    expect(cancelled.status).toBe("success");
    expect(deleted).toEqual(["schedule-local"]);
  });

  test("rejects ambiguous timing and high-frequency recurring wakes", async () => {
    const deps = {
      now: () => NOW,
      listLocal: () => [],
    };
    const ambiguous = await inScope(() =>
      wake(
        {
          action: "create",
          name: "ambiguous",
          prompt: "Do the thing.",
          after_seconds: 300,
          cron: "*/5 * * * *",
        },
        deps,
      ),
    );
    expect(ambiguous.status).toBe("error");

    const tooFrequent = await inScope(() =>
      wake(
        {
          action: "create",
          name: "too frequent",
          prompt: "Do the thing.",
          cron: "* * * * *",
        },
        deps,
      ),
    );
    expect(tooFrequent.status).toBe("error");
    expect(payload(tooFrequent).error).toContain("more often than hourly");
  });

  test("allows hourly recurrence and caps active wakes per conversation", async () => {
    let recurringInput: unknown;
    const hourly = await inScope(() =>
      wake(
        {
          action: "create",
          name: "hourly check",
          prompt: "Run the hourly check.",
          cron: "0 * * * *",
        },
        {
          now: () => NOW,
          listLocal: () => [],
          addLocal: (input) => {
            recurringInput = input;
            return {
              task: localTask({ recurring: true, cron: "0 * * * *" }),
            };
          },
        },
      ),
    );
    expect(hourly.status).toBe("success");
    expect(recurringInput).toMatchObject({
      recurring: true,
      cron: "0 * * * *",
      timezone: "UTC",
    });

    const capped = await inScope(() =>
      wake(
        {
          action: "create",
          name: "one too many",
          prompt: "This should not be created.",
          after_seconds: 300,
        },
        {
          now: () => NOW,
          listLocal: () =>
            Array.from({ length: 20 }, (_, index) =>
              localTask({ id: `wake-${index}` }),
            ),
        },
      ),
    );
    expect(capped.status).toBe("error");
    expect(payload(capped).error).toContain("max 20");
  });

  test("requires an active runtime scope", async () => {
    const result = await wake({ action: "list" }, { listLocal: () => [] });
    expect(result.status).toBe("error");
    expect(payload(result).error).toContain("current agent and conversation");
  });

  test("uses the real local scheduler for local-backend conversations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "letta-wake-test-"));
    const previousHome = process.env.HARUYUKI_HOME;
    process.env.HARUYUKI_HOME = directory;
    try {
      const scope = {
        agentId: "agent-local-test",
        conversationId: "conv-local",
      };
      const created = await runWithRuntimeContext(scope, () =>
        wake({
          action: "create",
          name: "local follow-up",
          prompt: "Resume local work.",
          after_seconds: 60,
        }),
      );
      expect(created.status).toBe("success");
      expect(payload(created)).toMatchObject({
        runner: "local",
        conversation_id: scope.conversationId,
      });
      expect(listTasks({ agent_id: scope.agentId })[0]?.timezone).toBe("UTC");
      // The persisted record carries the defaults, so a later edit/panel shows
      // the values the task actually runs with (M-15).
      const persisted = listTasks({ agent_id: scope.agentId })[0];
      expect(persisted?.permission).toBe("unrestricted");
      expect(persisted?.catch_up).toBe(false);
      expect(persisted?.timeout_minutes).toBe(30);
      expect(persisted?.wait_minutes).toBe(10);
      expect(persisted?.type).toBe("prompt");
      expect(persisted?.target).toEqual({
        kind: "existing",
        conversation_id: scope.conversationId,
      });

      const id = String(payload(created).id);
      const listed = await runWithRuntimeContext(scope, () =>
        wake({ action: "list" }),
      );
      expect(payload(listed)).toMatchObject({
        wakes: [{ id, runner: "local" }],
      });

      const cancelled = await runWithRuntimeContext(scope, () =>
        wake({ action: "cancel", id }),
      );
      expect(cancelled.status).toBe("success");
    } finally {
      if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
      else process.env.HARUYUKI_HOME = previousHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
