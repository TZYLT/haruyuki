import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestDirectory } from "@/test-utils/test-fs";
import { remapSettingsBucket } from "./remap";
import { SnapshotError } from "./types";

let dir: TestDirectory;

beforeEach(() => {
  dir = new TestDirectory();
});

afterEach(() => {
  dir.cleanup();
});

function settingsPath(): string {
  return dir.resolve("settings.json");
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<
    string,
    unknown
  >;
}

function writeSettings(value: unknown): void {
  writeFileSync(settingsPath(), JSON.stringify(value, null, 2), "utf-8");
}

function sessionsOf(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return settings.sessionsByServer as Record<string, unknown>;
}

test("same storage root leaves settings.json byte-identical", async () => {
  const root = dir.resolve("store");
  writeSettings({
    sessionsByServer: { [`local:${root}`]: { agentId: "agent-1" } },
    env: { LETTA_BASE_URL: "http://localhost:8283" },
  });
  const before = readFileSync(settingsPath(), "utf-8");

  const result = await remapSettingsBucket(settingsPath(), root, root);

  expect(result.remapped).toEqual([]);
  expect(result.notRemapped).toEqual([]);
  expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
});

test("changed storage root rewrites the local bucket key and keeps its value", async () => {
  const oldRoot = dir.resolve("old-store");
  const newRoot = dir.resolve("new-store");
  writeSettings({
    sessionsByServer: {
      [`local:${oldRoot}`]: { agentId: "agent-1", conversationId: "conv-1" },
      "api.letta.com": {
        agentId: "agent-cloud",
        conversationId: "conv-cloud",
      },
    },
  });

  const result = await remapSettingsBucket(settingsPath(), oldRoot, newRoot);

  expect(result.remapped).toHaveLength(1);
  expect(result.remapped[0]?.from).toBe(`local:${oldRoot}`);
  expect(result.remapped[0]?.to).toBe(`local:${newRoot}`);
  expect(result.remapped[0]?.field).toBe(`sessionsByServer.local:${oldRoot}`);

  const sessions = sessionsOf(readSettings());
  expect(sessions[`local:${oldRoot}`]).toBeUndefined();
  expect(sessions[`local:${newRoot}`]).toEqual({
    agentId: "agent-1",
    conversationId: "conv-1",
  });
  // Non-local buckets and unrelated settings are untouched.
  expect(sessions["api.letta.com"]).toEqual({
    agentId: "agent-cloud",
    conversationId: "conv-cloud",
  });
  expect(readSettings().env).toBeUndefined();
});

test("an existing target bucket keeps its current value and reports a conflict", async () => {
  const oldRoot = dir.resolve("old-store");
  const newRoot = dir.resolve("new-store");
  writeSettings({
    sessionsByServer: {
      [`local:${oldRoot}`]: {
        agentId: "agent-old",
        conversationId: "conv-old",
      },
      [`local:${newRoot}`]: {
        agentId: "agent-new",
        conversationId: "conv-new",
      },
    },
  });
  const before = readFileSync(settingsPath(), "utf-8");

  const result = await remapSettingsBucket(settingsPath(), oldRoot, newRoot);

  expect(result.remapped).toEqual([]);
  expect(result.notRemapped.join("\n")).toContain("already exists");

  const sessions = sessionsOf(readSettings());
  expect(sessions[`local:${newRoot}`]).toEqual({
    agentId: "agent-new",
    conversationId: "conv-new",
  });
  // The conflicting old key is left in place: no session reference is discarded.
  expect(sessions[`local:${oldRoot}`]).toEqual({
    agentId: "agent-old",
    conversationId: "conv-old",
  });
  expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
});

test("sessions.jsonl is never rewritten and is reported as not remapped", async () => {
  const newRoot = dir.resolve("new-store");
  const project = dir.resolve("some-project");
  writeSettings({ sessionsByServer: {} });
  const historyLines = [
    JSON.stringify({
      agent_id: "agent-1",
      session_id: "s1",
      timestamp: 1,
      project,
    }),
    JSON.stringify({
      agent_id: "agent-1",
      session_id: "s2",
      timestamp: 2,
      project: "C:\\unrelated",
    }),
  ].join("\n");
  writeFileSync(dir.resolve("sessions.jsonl"), `${historyLines}\n`, "utf-8");

  const result = await remapSettingsBucket(settingsPath(), project, newRoot);

  expect(result.remapped).toEqual([]);
  expect(result.notRemapped.join("\n")).toContain("sessions.jsonl.project");
  expect(readFileSync(dir.resolve("sessions.jsonl"), "utf-8")).toBe(
    `${historyLines}\n`,
  );
});

test("unparseable settings.json is an io_error and is not rewritten", async () => {
  const raw = '{"sessionsByServer": {';
  writeFileSync(settingsPath(), raw, "utf-8");

  const failure = remapSettingsBucket(
    settingsPath(),
    dir.resolve("old"),
    dir.resolve("new"),
  );

  await expect(failure).rejects.toBeInstanceOf(SnapshotError);
  await expect(failure).rejects.toMatchObject({ code: "io_error" });
  expect(readFileSync(settingsPath(), "utf-8")).toBe(raw);
});

test("a missing settings file is a no-op", async () => {
  const result = await remapSettingsBucket(
    join(dir.path, "does-not-exist.json"),
    dir.resolve("old"),
    dir.resolve("new"),
  );

  expect(result.remapped).toEqual([]);
  expect(result.notRemapped).toEqual([]);
  expect(existsSync(join(dir.path, "does-not-exist.json"))).toBe(false);
});

test.skipIf(process.platform !== "win32")(
  "windows storage roots compare case-insensitively",
  async () => {
    const oldRoot = dir.resolve("old-store");
    const newRoot = dir.resolve("new-store");
    writeSettings({
      sessionsByServer: {
        [`local:${oldRoot.toUpperCase()}`]: { agentId: "agent-1" },
      },
    });

    const result = await remapSettingsBucket(settingsPath(), oldRoot, newRoot);

    expect(result.remapped).toHaveLength(1);
    expect(sessionsOf(readSettings())[`local:${newRoot}`]).toEqual({
      agentId: "agent-1",
    });
  },
);
