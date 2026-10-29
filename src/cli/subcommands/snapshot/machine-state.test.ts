import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readScheduleFile } from "@/cron/cron-store";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  __setCronLockTimeoutForTests,
  clearCronLease,
  clearGitLocks,
  listMemoryRepoDirs,
  reinstallHooks,
  removePlatformHelpers,
} from "./machine-state";
import { SnapshotError } from "./types";

let dir: TestDirectory;
const initialHaruyukiHome = process.env.HARUYUKI_HOME;

beforeEach(() => {
  dir = new TestDirectory();
});

afterEach(() => {
  __setCronLockTimeoutForTests(null);
  if (initialHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = initialHaruyukiHome;
  dir.cleanup();
});

function writeCronsFile(appHome: string, value: unknown): string {
  mkdirSync(appHome, { recursive: true });
  const path = join(appHome, "crons.json");
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
  return path;
}

function writeSchedulesFile(appHome: string, value: unknown): string {
  mkdirSync(appHome, { recursive: true });
  const path = join(appHome, "schedules.json");
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
  return path;
}

function leaseFixture() {
  const owner = {
    pid: 1234,
    token: "dead-token",
    started_at: "2026-10-20T00:00:00.000Z",
  };
  return {
    version: 1,
    scheduler_owner: owner,
    scheduler_owners: { local: owner },
    tasks: [
      {
        id: "task-1",
        agent_id: "agent-1",
        conversation_id: "default",
        name: "daily",
        description: "",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        recurring: true,
        prompt: "hello",
        status: "active",
        created_at: "2026-10-20T00:00:00.000Z",
      },
    ],
  };
}

function makeRepo(base: string, name: string): string {
  const repo = join(base, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

test("clearCronLease clears both lease fields and keeps tasks and status", async () => {
  const appHome = dir.resolve("apphome");
  const cronPath = writeCronsFile(appHome, leaseFixture());

  const result = await clearCronLease(appHome);

  expect(result).toEqual({ cleared: true });
  const written = JSON.parse(readFileSync(cronPath, "utf-8"));
  expect(written.scheduler_owner).toBeNull();
  expect(written.scheduler_owners).toEqual({});
  expect(written.tasks).toEqual(leaseFixture().tasks);
  expect(written.tasks[0].status).toBe("active");
  // The lock directory is released afterwards.
  expect(existsSync(join(appHome, "crons.lock"))).toBe(false);
});

test("corrupt crons.json is an io_error and is never overwritten", async () => {
  const appHome = dir.resolve("apphome");
  mkdirSync(appHome, { recursive: true });
  const cronPath = join(appHome, "crons.json");
  const raw = '{"version":1,"tasks":[';
  writeFileSync(cronPath, raw, "utf-8");

  const failure = clearCronLease(appHome);

  await expect(failure).rejects.toBeInstanceOf(SnapshotError);
  await expect(failure).rejects.toMatchObject({ code: "io_error" });
  expect(readFileSync(cronPath, "utf-8")).toBe(raw);
  expect(existsSync(join(appHome, "crons.lock"))).toBe(false);
});

test("a lease-free crons.json is a no-op", async () => {
  const appHome = dir.resolve("apphome");
  const cronPath = writeCronsFile(appHome, {
    version: 1,
    scheduler_owner: null,
    scheduler_owners: {},
    tasks: [],
  });
  const before = readFileSync(cronPath, "utf-8");

  const result = await clearCronLease(appHome);

  expect(result).toEqual({ cleared: false });
  expect(readFileSync(cronPath, "utf-8")).toBe(before);
});

test("a missing crons.json is a no-op and creates nothing", async () => {
  const appHome = dir.resolve("apphome");
  mkdirSync(appHome, { recursive: true });

  const result = await clearCronLease(appHome);

  expect(result).toEqual({ cleared: false });
  expect(existsSync(join(appHome, "crons.json"))).toBe(false);
  expect(existsSync(join(appHome, "crons.lock"))).toBe(false);
});

test("a held lock times out with a warning and leaves the lease in place", async () => {
  const appHome = dir.resolve("apphome");
  const cronPath = writeCronsFile(appHome, leaseFixture());
  const before = readFileSync(cronPath, "utf-8");

  const lockDir = join(appHome, "crons.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      token: "held-by-live-process",
      acquired_at: Date.now(),
    }),
  );

  __setCronLockTimeoutForTests(80);
  const result = await clearCronLease(appHome);

  expect(result.cleared).toBe(false);
  expect(result.warning).toContain("crons.lock");
  expect(readFileSync(cronPath, "utf-8")).toBe(before);
  // A live owner is not stolen.
  expect(existsSync(lockDir)).toBe(true);
});

test("a stale lock is stolen and the lease is cleared", async () => {
  const appHome = dir.resolve("apphome");
  const cronPath = writeCronsFile(appHome, leaseFixture());

  const lockDir = join(appHome, "crons.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 999_999,
      token: "stale",
      acquired_at: Date.now() - 60_000,
    }),
  );

  __setCronLockTimeoutForTests(200);
  const result = await clearCronLease(appHome);

  expect(result).toEqual({ cleared: true });
  const written = JSON.parse(readFileSync(cronPath, "utf-8"));
  expect(written.scheduler_owner).toBeNull();
});

test("schedules.json loses both lease levels and keeps every other field", async () => {
  const appHome = dir.resolve("apphome");
  const owner = {
    pid: 1234,
    token: "dead-token",
    started_at: "2026-10-20T00:00:00.000Z",
  };
  const taskLease = {
    runId: "run-1",
    host: "long-lived",
    pid: 1234,
    token: "dead-token",
    startedAt: "2026-10-20T00:00:00.000Z",
    heartbeatAt: "2026-10-20T00:00:30.000Z",
    expiresAt: "2026-10-20T00:01:30.000Z",
  };
  const source = {
    version: 2,
    scheduler_owner: owner,
    scheduler_owners: { local: owner },
    signal_state: { cursor: { cron: "2026-10-20T00:00:00.000Z" } },
    tasks: [
      {
        id: "task-1",
        status: "active",
        lease: taskLease,
        last_consumed_occurrence: "2026-10-20T00:00:00.000Z",
      },
      { id: "task-2", status: "paused", lease: null },
    ],
  };
  const schedulePath = writeSchedulesFile(appHome, source);

  const result = await clearCronLease(appHome);

  expect(result).toEqual({ cleared: true });
  const written = JSON.parse(readFileSync(schedulePath, "utf-8"));
  expect(written.scheduler_owner).toBeNull();
  expect(written.scheduler_owners).toEqual({});
  expect(written.signal_state).toEqual(source.signal_state);
  expect(written.tasks).toEqual([
    {
      id: "task-1",
      status: "active",
      lease: null,
      last_consumed_occurrence: "2026-10-20T00:00:00.000Z",
    },
    { id: "task-2", status: "paused", lease: null },
  ]);
  // The lock directory is released afterwards.
  expect(existsSync(join(appHome, "crons.lock"))).toBe(false);
});

test("only a read-only crons.v1.json backup is a no-op", async () => {
  const appHome = dir.resolve("apphome");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(
    join(appHome, "crons.v1.json"),
    JSON.stringify(leaseFixture(), null, 2),
    "utf-8",
  );

  const result = await clearCronLease(appHome);

  expect(result).toEqual({ cleared: false });
  expect(existsSync(join(appHome, "schedules.json"))).toBe(false);
});

test("a legacy crons.json is cleared in place and lazily migrates on first read", async () => {
  const appHome = dir.resolve("apphome");
  const cronPath = writeCronsFile(appHome, leaseFixture());
  process.env.HARUYUKI_HOME = appHome;

  const result = await clearCronLease(appHome);

  expect(result).toEqual({ cleared: true });
  // No phantom v2 store: the store's own lazy migration owns that write.
  expect(existsSync(join(appHome, "schedules.json"))).toBe(false);
  const legacy = JSON.parse(readFileSync(cronPath, "utf-8"));
  expect(legacy.scheduler_owner).toBeNull();
  expect(legacy.scheduler_owners).toEqual({});

  // The first read migrates v1 -> v2 and keeps the lease-free state.
  const migrated = readScheduleFile();
  expect(migrated.version).toBe(2);
  expect(migrated.tasks.map((task) => task.id)).toEqual(["task-1"]);
  expect(migrated.tasks[0]?.lease ?? null).toBeNull();
  expect(existsSync(join(appHome, "schedules.json"))).toBe(true);
  expect(existsSync(join(appHome, "crons.v1.json"))).toBe(true);
  expect(existsSync(cronPath)).toBe(false);
});

test("clearGitLocks removes lock and in-progress files only", async () => {
  const base = dir.resolve("storage");
  const repo = makeRepo(base, "memfs/agent-1/memory");
  mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(join(repo, ".git", "objects", "pack"), { recursive: true });
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });

  const locks = [
    join(repo, ".git", "index.lock"),
    join(repo, ".git", "letta-memory-operation.lock"),
    join(repo, ".git", "refs", "heads", "main.lock"),
    join(repo, ".git", "objects", "pack", "tmp.pack.lock"),
    join(repo, ".git", "some-operation.inprogress"),
  ];
  const kept = [
    join(repo, ".git", "config"),
    join(repo, ".git", "hooks", "pre-commit"),
    join(repo, ".git", "HEAD"),
  ];
  for (const path of [...locks, ...kept]) {
    writeFileSync(path, "x", "utf-8");
  }

  const removed = await clearGitLocks([repo, repo, join(base, "no-such-repo")]);

  expect(removed).toBe(locks.length);
  for (const path of locks) expect(existsSync(path)).toBe(false);
  for (const path of kept) expect(existsSync(path)).toBe(true);
});

test("removePlatformHelpers removes credential helpers and keeps other files", async () => {
  const base = dir.resolve("storage");
  const first = makeRepo(base, "memfs/agent-1/memory");
  const second = makeRepo(base, "agents/agent-2/memory");
  writeFileSync(
    join(first, ".git", "letta-credential-helper.cmd"),
    "@echo off\n",
    "utf-8",
  );
  writeFileSync(
    join(second, ".git", "letta-credential-helper.sh"),
    "#!/bin/sh\n",
    "utf-8",
  );
  writeFileSync(join(second, ".git", "config"), "x", "utf-8");

  const removed = await removePlatformHelpers([first, second]);

  expect(removed).toBe(2);
  expect(existsSync(join(first, ".git", "letta-credential-helper.cmd"))).toBe(
    false,
  );
  expect(existsSync(join(second, ".git", "letta-credential-helper.sh"))).toBe(
    false,
  );
  expect(existsSync(join(second, ".git", "config"))).toBe(true);
});

test("reinstallHooks is idempotent and skips directories without .git", async () => {
  const base = dir.resolve("storage");
  const first = makeRepo(base, "memfs/agent-1/memory");
  const second = makeRepo(base, "agents/agent-2/memory");
  const notARepo = join(base, "memfs", "agent-3", "memory");
  mkdirSync(notARepo, { recursive: true });

  const firstPass = await reinstallHooks([first, second, notARepo]);
  expect(firstPass).toEqual({ ok: 2, failed: [] });

  const hookPath = join(first, ".git", "hooks", "pre-commit");
  const firstBytes = readFileSync(hookPath, "utf-8");
  expect(existsSync(join(first, ".git", "hooks", "post-commit"))).toBe(true);
  expect(existsSync(join(first, ".git", "letta-memory-layout-policy"))).toBe(
    true,
  );

  const secondPass = await reinstallHooks([first, second, notARepo]);

  expect(secondPass).toEqual({ ok: 2, failed: [] });
  expect(readFileSync(hookPath, "utf-8")).toBe(firstBytes);
  // The non-repo directory was left alone (no fabricated .git tree).
  expect(existsSync(join(notARepo, ".git"))).toBe(false);
});

test("listMemoryRepoDirs covers memfs and agents checkouts only", () => {
  const storage = dir.resolve("storage");
  const memfsA = join(storage, "memfs", "agent-a", "memory");
  const memfsB = join(storage, "memfs", "agent-b", "memory");
  const agentsC = join(storage, "agents", "agent-c", "memory");
  mkdirSync(memfsA, { recursive: true });
  mkdirSync(memfsB, { recursive: true });
  mkdirSync(agentsC, { recursive: true });
  // An agent directory without a memory checkout is not a repository.
  mkdirSync(join(storage, "agents", "agent-d"), { recursive: true });

  const found = listMemoryRepoDirs(storage);

  expect(found).toEqual([memfsA, memfsB, agentsC]);
  expect(listMemoryRepoDirs(join(storage, "missing"))).toEqual([]);
  expect(listMemoryRepoDirs("")).toEqual([]);
});
