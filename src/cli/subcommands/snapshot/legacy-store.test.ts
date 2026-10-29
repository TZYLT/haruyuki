import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSnapshotStoreVersion,
  preparePackagedSchedules,
  retireLegacyCronStore,
  warnLegacyCronOnlyExport,
} from "./legacy-store";
import type { ScopeEntry, ScopeRoots } from "./scope";
import { SnapshotError } from "./types";

const homes: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "hryk-legacy-store-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function roots(appHome: string): ScopeRoots {
  return {
    appHome,
    storageDir: join(appHome, "storage"),
    homedirRoot: appHome,
  };
}

function fileEntry(appHome: string, path: string): ScopeEntry {
  const absolutePath = join(appHome, path.replace(/^home\//, ""));
  const bytes = readFileSync(absolutePath).length;
  return { path, absolutePath, scope: "home", kind: "file", bytes };
}

function writeHomeFile(appHome: string, name: string, value: unknown): void {
  mkdirSync(appHome, { recursive: true });
  writeFileSync(
    join(appHome, name),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf-8",
  );
}

test("assertSnapshotStoreVersion accepts v1, v2 and the pre-versioned form", () => {
  expect(() =>
    assertSnapshotStoreVersion({}, "schedules.json", "x"),
  ).not.toThrow();
  expect(() =>
    assertSnapshotStoreVersion({ version: 1 }, "crons.json", "x"),
  ).not.toThrow();
  expect(() =>
    assertSnapshotStoreVersion({ version: 2 }, "schedules.json", "x"),
  ).not.toThrow();
});

test("assertSnapshotStoreVersion refuses newer and malformed versions", () => {
  for (const version of [3, 99, 0, -1, 1.5, "3", null]) {
    expect(() =>
      assertSnapshotStoreVersion({ version }, "schedules.json", "store.json"),
    ).toThrow(SnapshotError);
  }
});

test("preparePackagedSchedules clears both lease levels and keeps the rest", () => {
  const appHome = tempHome();
  writeHomeFile(appHome, "schedules.json", {
    version: 2,
    scheduler_owner: { pid: 1, token: "host" },
    scheduler_owners: { local: { pid: 1, token: "host" } },
    signal_state: { cursor: { cron: "2026-10-26T00:00:00.000Z" } },
    future_field: "kept",
    tasks: [
      { id: "a", lease: { token: "leased" }, prompt: "p" },
      { id: "b", lease: null },
    ],
  });
  const collected = [fileEntry(appHome, "home/schedules.json")];

  const packed = preparePackagedSchedules(collected);
  expect(packed).toBeDefined();
  const parsed = JSON.parse(packed?.toString("utf-8") ?? "{}") as Record<
    string,
    unknown
  >;
  expect(parsed.scheduler_owner).toBeNull();
  expect(parsed.scheduler_owners).toEqual({});
  expect(parsed.signal_state).toEqual({
    cursor: { cron: "2026-10-26T00:00:00.000Z" },
  });
  expect(parsed.future_field).toBe("kept");
  expect(parsed.tasks).toEqual([
    { id: "a", lease: null, prompt: "p" },
    { id: "b", lease: null },
  ]);
});

test("preparePackagedSchedules refuses a store written by a newer build", () => {
  const appHome = tempHome();
  writeHomeFile(appHome, "schedules.json", {
    version: 99,
    scheduler_owner: null,
    tasks: [],
  });
  const collected = [fileEntry(appHome, "home/schedules.json")];

  expect(() => preparePackagedSchedules(collected)).toThrow(SnapshotError);
});

test("warnLegacyCronOnlyExport fires only for a legacy-only machine", () => {
  const appHome = tempHome();
  const warnings: string[] = [];

  // Neither store: nothing to say.
  warnLegacyCronOnlyExport(roots(appHome), [], warnings);
  expect(warnings).toEqual([]);

  // Legacy store only: the export would pack no tasks, so warn.
  writeHomeFile(appHome, "crons.json", { version: 1, tasks: [] });
  warnLegacyCronOnlyExport(roots(appHome), [], warnings);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("has not migrated its schedule store");
  expect(warnings[0]).toContain("were NOT packed");

  // A migrated machine (schedules.json collected) stays quiet.
  writeHomeFile(appHome, "schedules.json", { version: 2, tasks: [] });
  const migrated: string[] = [];
  const collected = [fileEntry(appHome, "home/schedules.json")];
  warnLegacyCronOnlyExport(roots(appHome), collected, migrated);
  expect(migrated).toEqual([]);
});

test("retireLegacyCronStore moves the live store aside for a v2 restore", () => {
  const appHome = tempHome();
  writeHomeFile(appHome, "crons.json", { version: 1, tasks: [{ id: "old" }] });
  const before = readFileSync(join(appHome, "crons.json"), "utf-8");
  const warnings: string[] = [];

  retireLegacyCronStore(appHome, new Set(["home/schedules.json"]), warnings);

  expect(existsSync(join(appHome, "crons.json"))).toBe(false);
  expect(readFileSync(join(appHome, "crons.v1.json"), "utf-8")).toBe(before);
  expect(warnings).toEqual([]);
});

test("retireLegacyCronStore skips packages without a v2 store", () => {
  const appHome = tempHome();
  writeHomeFile(appHome, "crons.json", { version: 1, tasks: [] });
  const warnings: string[] = [];

  retireLegacyCronStore(appHome, new Set(["home/settings.json"]), warnings);
  expect(existsSync(join(appHome, "crons.json"))).toBe(true);
  expect(warnings).toEqual([]);
});

test("retireLegacyCronStore never overwrites an existing v1 backup", () => {
  const appHome = tempHome();
  writeHomeFile(appHome, "crons.json", { version: 1, tasks: [{ id: "new" }] });
  writeHomeFile(appHome, "crons.v1.json", {
    version: 1,
    tasks: [{ id: "backup" }],
  });
  const live = readFileSync(join(appHome, "crons.json"), "utf-8");
  const backup = readFileSync(join(appHome, "crons.v1.json"), "utf-8");

  retireLegacyCronStore(appHome, new Set(["home/schedules.json"]), []);

  expect(existsSync(join(appHome, "crons.json"))).toBe(false);
  expect(readFileSync(join(appHome, "crons.v1.json"), "utf-8")).toBe(backup);
  expect(readFileSync(join(appHome, "crons.json.restored"), "utf-8")).toBe(
    live,
  );
});
