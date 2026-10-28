import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  applyScheduleTaskV2,
  emptyScheduleFile,
  getCronBackupFilePath,
  getCronFilePath,
  getLegacyCronFilePath,
  getScheduleFilePath,
  migrateLegacyCronFile,
  readCronFile,
  readScheduleFile,
  ScheduleStoreMigrationError,
  ScheduleStoreVersionError,
  toScheduleTaskV2,
  updateScheduleTask,
  writeScheduleFile,
} from "@/cron/cron-store";
import type { CronTask } from "@/cron/cron-types";

// ── Test setup ──────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__cron_store_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

/** A complete v1 record, exactly as 0.4.4 wrote it. */
function legacyTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "a1b2c3d4",
    agent_id: "agent-test",
    conversation_id: "new",
    name: "Daily summary",
    description: "summarise yesterday",
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    recurring: true,
    prompt: "summarise yesterday",
    status: "active",
    created_at: "2026-10-01T01:00:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 3,
    cancel_reason: null,
    jitter_offset_ms: 12,
    last_run_at: null,
    last_run_outcome: null,
    last_run_reason: null,
    last_run_error: null,
    last_missed_at: null,
    missed_count: 1,
    failed_count: 2,
    scheduled_for: null,
    fired_at: null,
    missed_at: null,
    ...overrides,
  };
}

function writeLegacyFile(body: unknown): string {
  const legacyPath = getLegacyCronFilePath();
  writeFileSync(legacyPath, JSON.stringify(body, null, 2));
  return legacyPath;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

// ── Paths ───────────────────────────────────────────────────────────

describe("store paths", () => {
  test("the live store is schedules.json next to the harness root", () => {
    expect(getScheduleFilePath()).toBe(path.join(TEST_DIR, "schedules.json"));
    expect(getCronFilePath()).toBe(getScheduleFilePath());
    expect(getLegacyCronFilePath()).toBe(path.join(TEST_DIR, "crons.json"));
    expect(getCronBackupFilePath()).toBe(path.join(TEST_DIR, "crons.v1.json"));
  });
});

// ── v1 → v2 migration ───────────────────────────────────────────────

describe("migrateLegacyCronFile", () => {
  test("maps a v1 file to v2, keeps identity and history, and backs the original up", () => {
    const legacyPath = writeLegacyFile({
      version: 1,
      scheduler_owner: null,
      scheduler_owners: {},
      tasks: [legacyTask()],
    });

    const result = migrateLegacyCronFile();

    expect(result?.taskCount).toBe(1);
    expect(result?.backupPath).toBe(getCronBackupFilePath());

    const data = readScheduleFile();
    expect(data.version).toBe(2);
    expect(data.signal_state).toEqual({ cursor: {} });

    const task = data.tasks[0];
    if (!task) throw new Error("expected a migrated task");
    // Identity and history survive untouched (R-5.13.1).
    expect(task.id).toBe("a1b2c3d4");
    expect(task.created_at).toBe("2026-10-01T01:00:00.000Z");
    expect(task.fire_count).toBe(3);
    expect(task.missed_count).toBe(1);
    expect(task.failed_count).toBe(2);
    expect(task.jitter_offset_ms).toBe(12);
    // New fields take the documented defaults (Q-53, R-5.13.2).
    expect(task.type).toBe("prompt");
    expect(task.payload).toBe("summarise yesterday");
    expect(task.target).toEqual({ kind: "new", hidden: false });
    expect(task.permission).toBe("unrestricted");
    expect(task.catch_up).toBe(false);
    expect(task.timeout_minutes).toBe(30);
    expect(task.wait_minutes).toBe(10);
    expect(task.lease).toBeNull();
    expect(task.last_consumed_occurrence).toBeNull();
    expect(task.consecutive_failures).toBe(0);
    expect(task.paused_reason).toBeNull();

    // New file name, old file gone, backup still readable (Q-46).
    expect(existsSync(getScheduleFilePath())).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    const backup = readJson(getCronBackupFilePath());
    expect(backup.version).toBe(1);
    expect((backup.tasks as unknown[]).length).toBe(1);
  });

  test("writes a v2 header and signal state on disk", () => {
    writeLegacyFile({ version: 1, tasks: [legacyTask()] });
    migrateLegacyCronFile();

    const raw = readJson(getScheduleFilePath());
    expect(raw.version).toBe(2);
    expect(raw.signal_state).toEqual({ cursor: {} });
    expect(raw.scheduler_owner).toBeNull();
  });

  test("maps every conversation target shape", () => {
    writeLegacyFile({
      version: 1,
      tasks: [
        legacyTask({ id: "aaaaaaaa", conversation_id: "new" }),
        legacyTask({ id: "bbbbbbbb", conversation_id: "default" }),
        legacyTask({ id: "cccccccc", conversation_id: "conv-42" }),
      ],
    });

    migrateLegacyCronFile();
    const byId = new Map(
      readScheduleFile().tasks.map((task) => [task.id, task.target]),
    );
    expect(byId.get("aaaaaaaa")).toEqual({ kind: "new", hidden: false });
    expect(byId.get("bbbbbbbb")).toEqual({
      kind: "existing",
      conversation_id: "default",
    });
    expect(byId.get("cccccccc")).toEqual({
      kind: "existing",
      conversation_id: "conv-42",
    });
  });

  test("a read migrates on first contact", () => {
    writeLegacyFile({ version: 1, tasks: [legacyTask()] });

    const data = readCronFile();

    expect(data.tasks).toHaveLength(1);
    expect(existsSync(getScheduleFilePath())).toBe(true);
    expect(existsSync(getCronBackupFilePath())).toBe(true);
  });

  test("returns null when there is nothing to migrate", () => {
    expect(migrateLegacyCronFile()).toBeNull();
    expect(existsSync(getScheduleFilePath())).toBe(false);
  });

  test("a corrupt v1 file is left untouched and nothing is written", () => {
    const legacyPath = getLegacyCronFilePath();
    writeFileSync(legacyPath, "{ not json");

    expect(() => migrateLegacyCronFile()).toThrow(ScheduleStoreMigrationError);

    expect(readFileSync(legacyPath, "utf-8")).toBe("{ not json");
    expect(existsSync(getScheduleFilePath())).toBe(false);
  });

  test("a v1 file that is not a schedule file is refused, untouched", () => {
    const legacyPath = writeLegacyFile({ version: 1, tasks: "nope" });

    const result = migrateLegacyCronFile();

    // Non-array tasks cannot corrupt the new store: they migrate as empty.
    expect(result?.taskCount).toBe(0);
    expect(existsSync(legacyPath)).toBe(false);
    expect(readScheduleFile().tasks).toEqual([]);
  });

  test("a higher legacy version is refused, untouched", () => {
    const legacyPath = writeLegacyFile({ version: 9, tasks: [] });

    expect(() => migrateLegacyCronFile()).toThrow(ScheduleStoreMigrationError);
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(getScheduleFilePath())).toBe(false);
  });
});

// ── Version gate ────────────────────────────────────────────────────

describe("version gate", () => {
  function writeNewerFile(): string {
    const filePath = getScheduleFilePath();
    writeFileSync(
      filePath,
      JSON.stringify({ version: 99, tasks: [{ id: "keep-me" }] }),
    );
    return filePath;
  }

  test("reading a newer file throws instead of reporting an empty store", () => {
    writeNewerFile();

    expect(() => readScheduleFile()).toThrow(ScheduleStoreVersionError);
  });

  test("writing a newer file is refused and the file is untouched", () => {
    const filePath = writeNewerFile();
    const before = readFileSync(filePath, "utf-8");

    expect(() => writeScheduleFile(emptyScheduleFile())).toThrow(
      ScheduleStoreVersionError,
    );
    expect(readFileSync(filePath, "utf-8")).toBe(before);
  });

  test("a v1 file at the new path is read and normalized", () => {
    writeFileSync(
      getScheduleFilePath(),
      JSON.stringify({ version: 1, tasks: [legacyTask()] }),
    );

    const data = readScheduleFile();

    expect(data.tasks[0]?.permission).toBe("unrestricted");
  });
});

// ── Frozen view adapters ────────────────────────────────────────────

describe("ScheduleTaskV2 adapters", () => {
  function record(): CronTask {
    return {
      ...(legacyTask() as unknown as CronTask),
      lease: {
        runId: "run-1",
        host: "short-lived",
        pid: process.pid,
        token: "tok",
        startedAt: "2026-10-28T10:00:00.000Z",
        heartbeatAt: "2026-10-28T10:00:00.000Z",
        expiresAt: "2026-10-28T10:01:30.000Z",
      },
      last_consumed_occurrence: "2026-10-28T09:00",
      catch_up: true,
      permission: "acceptEdits",
      timeout_minutes: 5,
      wait_minutes: 2,
      paused_reason: "manual",
      consecutive_failures: 2,
    };
  }

  test("projects the record onto the frozen view", () => {
    const view = toScheduleTaskV2(record());

    expect(view.agentId).toBe("agent-test");
    expect(view.payload).toBe("summarise yesterday");
    expect(view.target).toEqual({ kind: "new", hidden: false });
    expect(view.catchUp).toBe(true);
    expect(view.permission).toBe("acceptEdits");
    expect(view.timeoutMinutes).toBe(5);
    expect(view.waitMinutes).toBe(2);
    expect(view.pausedReason).toBe("manual");
    expect(view.consecutiveFailures).toBe(2);
    expect(view.lastConsumedOccurrence).toBe("2026-10-28T09:00");
    expect(view.lease?.runId).toBe("run-1");
    expect(view.lastOutcome).toBeNull();
  });

  test("folds the view back without losing v2-only fields", () => {
    const base = record();
    const view = toScheduleTaskV2(base);

    view.payload = "/compact 3";
    view.type = "command";
    view.target = { kind: "existing", conversation_id: "conv-9" };
    view.status = "paused";
    view.pausedReason = "auto_failures";

    const next = applyScheduleTaskV2(base, view);

    expect(next.payload).toBe("/compact 3");
    expect(next.type).toBe("command");
    expect(next.conversation_id).toBe("conv-9");
    expect(next.status).toBe("paused");
    expect(next.paused_reason).toBe("auto_failures");
    // Untouched v2 fields survive the round trip.
    expect(next.lease?.runId).toBe("run-1");
    expect(next.last_consumed_occurrence).toBe("2026-10-28T09:00");
    expect(next.catch_up).toBe(true);
    expect(next.id).toBe("a1b2c3d4");
  });

  test("a prompt task keeps its prompt mirror", () => {
    const base = record();
    const view = toScheduleTaskV2(base);
    view.payload = "new text";

    expect(applyScheduleTaskV2(base, view).prompt).toBe("new text");
  });
});

// ── updateScheduleTask ──────────────────────────────────────────────

describe("updateScheduleTask", () => {
  test("persists v2-only fields and leaves unknown ids alone", () => {
    writeLegacyFile({ version: 1, tasks: [legacyTask()] });
    readScheduleFile();

    const updated = updateScheduleTask("a1b2c3d4", (task) => {
      task.permission = "standard";
      task.catchUp = true;
      task.lastConsumedOccurrence = "2026-10-28T09:00";
    });

    expect(updated?.permission).toBe("standard");
    expect(updateScheduleTask("nope", () => {})).toBeNull();

    const task = readScheduleFile().tasks[0];
    expect(task?.permission).toBe("standard");
    expect(task?.catch_up).toBe(true);
    expect(task?.last_consumed_occurrence).toBe("2026-10-28T09:00");
  });
});
