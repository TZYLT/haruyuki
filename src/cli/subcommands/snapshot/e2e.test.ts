/**
 * End-to-end round trip over two sets of temporary roots (docs/44-2 §8.1).
 *
 * The first set is a plausible machine: one agent, two conversations, one memory
 * repository, one cron entry, two settings tokens, two agent secrets, one
 * transcript tree under the literal home root and a project tree. It is exported
 * into a `.hryk`; the second set — a different home root, a different storage
 * root and a different project directory, each already holding stale data —
 * verifies and then imports that package.
 *
 * Everything is compared item by item afterwards: bytes for the files that must
 * travel unchanged, the rewritten `sessionsByServer` key for the one structured
 * field that must move, and the survival of everything the scope table excludes
 * or does not know about. Nothing here touches the real harness roots; the
 * literal home is the disposable per-process directory the test preload pins.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { TestDirectory } from "@/test-utils/test-fs";
import { appHomeDirName } from "@/utils/app-paths";
import { LOCAL_BACKEND_DIR_ENV } from "@/utils/local-backend-paths";
import {
  applySecretBatch,
  clearSecretsCache,
  refreshAndListSecrets,
} from "@/utils/secrets-store";
import { readTarGz, type TarReadEntry } from "@/utils/tar-stream";
import { runExport } from "./export";
import { runImport } from "./import";
import type { SnapshotCliDeps } from "./types";

const AGENT_ID = "agent-e2e";
const CONVERSATIONS = ["conv-alpha", "conv-beta"] as const;
const SETTINGS_API_KEY = "sk-e2e-settings-key";
const SETTINGS_REFRESH_TOKEN = "rt-e2e-refresh";
const AGENT_SECRETS: Record<string, string> = {
  OPENAI_API_KEY: "sk-e2e-agent-openai",
  GITHUB_TOKEN: "ghp-e2e-agent-token",
};

const ENV_KEYS = [
  "HARUYUKI_HOME",
  LOCAL_BACKEND_DIR_ENV,
  "HOME",
  "USERPROFILE",
  "HARUYUKI_SKIP_KEYCHAIN_CHECK",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function writeFileAt(root: string, relativePath: string, body: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, "utf-8");
}

function readAt(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf-8");
}

function existsAt(root: string, relativePath: string): boolean {
  return existsSync(join(root, relativePath));
}

function readJsonAt(
  root: string,
  relativePath: string,
): Record<string, unknown> {
  return JSON.parse(readAt(root, relativePath)) as Record<string, unknown>;
}

/** Point the ambient environment at one machine, and drop the secrets cache. */
function pointAt(home: string, storage: string): void {
  process.env.HARUYUKI_HOME = home;
  process.env[LOCAL_BACKEND_DIR_ENV] = storage;
  clearSecretsCache();
}

function depsFor(home: string, storage: string, cwd: string): SnapshotCliDeps {
  return {
    homeRoot: home,
    storageDir: storage,
    cwd,
    appVersion: "0.0.0-e2e",
    hostname: () => "e2e-host",
    now: () => new Date("2026-10-26T00:00:00.000Z"),
  };
}

/** Every archive entry, in archive order, with its body when it is small. */
async function readPackage(
  file: string,
): Promise<{ path: string; type: "file" | "dir"; body?: string }[]> {
  const entries: { path: string; type: "file" | "dir"; body?: string }[] = [];
  await readTarGz({
    file,
    onEntry: async (entry: TarReadEntry) => {
      if (entry.type === "dir") {
        entries.push({ path: entry.path, type: "dir" });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of entry.open() as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf-8");
      entries.push({
        path: entry.path,
        type: "file",
        // Binary-safe enough for this fixture set; the byte comparison itself is
        // done on the restored files, not on this projection.
        body: body.includes("\uFFFD") ? undefined : body,
      });
    },
  });
  return entries;
}

let workspace: TestDirectory;
let sourceHome: string;
let sourceStorage: string;
let targetHome: string;
let targetStorage: string;
let sourceProject: string;
let targetProject: string;
let literalBase: string;
const literalsToClean: string[] = [];

beforeEach(() => {
  workspace = new TestDirectory();
  sourceHome = workspace.resolve("source-home");
  sourceStorage = workspace.resolve("source-storage");
  targetHome = workspace.resolve("target-home");
  targetStorage = workspace.resolve("target-storage");
  sourceProject = workspace.resolve("source-project");
  targetProject = workspace.resolve("target-project");
  literalBase = join(os.homedir(), appHomeDirName());
  process.env.HOME = os.homedir();
  process.env.USERPROFILE = os.homedir();
  process.env.HARUYUKI_SKIP_KEYCHAIN_CHECK = "1";
  literalsToClean.length = 0;
});

afterEach(() => {
  clearSecretsCache();
  for (const path of literalsToClean) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort: the preload removes the disposable home anyway.
    }
  }
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  workspace.cleanup();
});

interface SeededMachine {
  sessions: string;
  cron: string;
  conversation: Map<string, { conversation: string; messages: string }>;
  agentRecord: string;
  memory: string;
  transcript: string;
  projectSettings: string;
}

/** The source machine: one agent, two conversations, one memory repo, one cron. */
async function seedSourceMachine(): Promise<SeededMachine> {
  pointAt(sourceHome, sourceStorage);

  const settings = {
    env: { LETTA_API_KEY: SETTINGS_API_KEY, KEPT: "kept-value" },
    refreshToken: SETTINGS_REFRESH_TOKEN,
    permissions: { allow: ["Bash(ls)"] },
    recentModels: ["anthropic/claude"],
    sessionsByServer: {
      [`local:${sourceStorage}`]: { selected: CONVERSATIONS[0] },
    },
  };
  writeFileAt(
    sourceHome,
    "settings.json",
    `${JSON.stringify(settings, null, 2)}\n`,
  );

  const sessions = [
    `{"project":"${sourceProject}","startedAt":"2026-10-26T00:00:00.000Z"}`,
    `{"project":"${workspace.resolve("other-project")}","startedAt":"2026-10-26T00:05:00.000Z"}`,
    "",
  ].join("\n");
  writeFileAt(sourceHome, "sessions.jsonl", sessions);

  const cron = `${JSON.stringify(
    {
      version: 1,
      scheduler_owner: "source-host",
      scheduler_owners: { "source-host": 1 },
      tasks: [{ id: "task-1", schedule: "0 * * * *", prompt: "check" }],
    },
    null,
    2,
  )}\n`;
  writeFileAt(sourceHome, "crons.json", cron);

  const transcript = '{"role":"system","content":"background"}\n';
  writeFileAt(
    literalBase,
    join("transcripts", "background", "t1.jsonl"),
    transcript,
  );
  literalsToClean.push(join(literalBase, "transcripts"));

  // Two excluded trees that really exist, so the export report has evidence of
  // what the walk skipped; the manifest carries the 20-rule table instead.
  writeFileAt(sourceHome, join("logs", "skipped.log"), "debug\n");
  writeFileAt(sourceHome, join("cache", "derived.bin"), "cache\n");

  const agentRecord = `${JSON.stringify(
    {
      id: AGENT_ID,
      name: "e2e-agent",
      model: "local/model",
      model_settings: {},
      personality: "helpful",
    },
    null,
    2,
  )}\n`;
  writeFileAt(sourceStorage, join("agents", `${AGENT_ID}.json`), agentRecord);

  const conversation = new Map<
    string,
    { conversation: string; messages: string }
  >();
  for (const [index, key] of CONVERSATIONS.entries()) {
    const record = `${JSON.stringify({ id: key, agentId: AGENT_ID }, null, 2)}\n`;
    const messages = `{"role":"user","content":"hello ${key} ${index}"}\n`;
    writeFileAt(
      sourceStorage,
      join("conversations", key, "conversation.json"),
      record,
    );
    writeFileAt(
      sourceStorage,
      join("conversations", key, "manifest.json"),
      '{"v":1}\n',
    );
    writeFileAt(
      sourceStorage,
      join("conversations", key, "messages.jsonl"),
      messages,
    );
    conversation.set(key, { conversation: record, messages });
  }

  const memory = "# memory\n\nremembered\n";
  writeFileAt(
    sourceStorage,
    join("memfs", AGENT_ID, "memory", "notes.md"),
    memory,
  );
  writeFileAt(
    sourceStorage,
    join("memfs", AGENT_ID, "memory", ".git", "HEAD"),
    "ref: refs/heads/main\n",
  );
  writeFileAt(
    sourceStorage,
    join("memfs", AGENT_ID, "memory", ".git", "index.lock"),
    "",
  );

  await applySecretBatch({ set: AGENT_SECRETS }, AGENT_ID);

  const projectSettings = '{"projectLevel":true}\n';
  writeFileAt(
    sourceProject,
    join(".haruyuki", "settings.json"),
    projectSettings,
  );
  writeFileAt(sourceProject, join("src", "index.ts"), "export {};\n");
  writeFileAt(sourceProject, ".env", "SECRET=not-packaged\n");

  return {
    sessions,
    cron,
    conversation,
    agentRecord,
    memory,
    transcript,
    projectSettings,
  };
}

/** The target machine already holds stale managed data and must survive partially. */
function seedTargetMachine(): { staleSessions: string } {
  pointAt(targetHome, targetStorage);

  writeFileAt(targetHome, "settings.json", '{"stale":true}\n');
  const staleSessions =
    '{"project":"stale","startedAt":"2020-01-01T00:00:00.000Z"}\n';
  writeFileAt(targetHome, "sessions.jsonl", staleSessions);
  writeFileAt(
    targetHome,
    join("agents", "stale-agent", "note.txt"),
    "stale agent\n",
  );
  writeFileAt(targetHome, join("logs", "keep.log"), "keep me\n");
  writeFileAt(targetHome, join("work", "scratch.txt"), "not managed\n");
  writeFileAt(
    targetStorage,
    join("conversations", "conv-stale", "messages.jsonl"),
    "stale\n",
  );

  writeFileAt(
    targetProject,
    join("src", "index.ts"),
    "// the target project is not a snapshot\n",
  );
  writeFileAt(targetProject, ".env", "TARGET_SECRET=keep\n");
  writeFileAt(
    targetProject,
    join(".haruyuki", "settings.json"),
    '{"stale":true}\n',
  );

  return { staleSessions };
}

test("export then import restores the same data under a second set of roots", async () => {
  const source = await seedSourceMachine();
  const exportDeps = depsFor(sourceHome, sourceStorage, workspace.path);
  const packagePath = workspace.resolve("round-trip.hryk");

  const exported = await runExport({
    out: packagePath,
    withProject: sourceProject,
    verbose: true,
    deps: exportDeps,
  });

  // ── export ────────────────────────────────────────────────────────
  expect(exported.ok).toBe(true);
  expect(exported.code).toBe("ok");
  expect(exported.out).toBe(packagePath);
  expect(existsSync(packagePath)).toBe(true);
  expect(existsSync(`${packagePath}.partial`)).toBe(false);
  // The report lists what the walk really skipped; the manifest carries the rule
  // table instead (docs/46-2 §1.7 rule 4).
  const skippedPaths = exported.excluded.map((entry) => entry.path);
  expect(skippedPaths.some((path) => path.startsWith("home/logs"))).toBe(true);
  expect(skippedPaths.some((path) => path.startsWith("home/cache"))).toBe(true);
  expect(exported.counts.secrets).toBe(Object.keys(AGENT_SECRETS).length + 2);
  expect(exported.byScope?.home).toBeDefined();
  expect(exported.byScope?.["local-backend"]).toBeDefined();
  expect(exported.byScope?.project).toBeDefined();
  // `secrets.json` is one entry; `counts.secrets` counts the values it carries.
  expect(exported.byScope?.secrets).toEqual({
    files: 1,
    bytes: expect.any(Number),
  });
  const scopeTotals = Object.values(exported.byScope ?? {});
  expect(scopeTotals.reduce((total, bucket) => total + bucket.files, 0)).toBe(
    exported.counts.files,
  );

  // The source machine is only ever read, and the packaged cron copy carries no
  // scheduler lease while the source file keeps its own.
  expect(readAt(sourceHome, "settings.json")).toContain(SETTINGS_API_KEY);
  expect(readJsonAt(sourceHome, "crons.json").scheduler_owner).toBe(
    "source-host",
  );

  const archive = await readPackage(packagePath);
  expect(archive[archive.length - 1]?.path).toBe("manifest.json");
  expect(archive).toHaveLength(exported.counts.files + 1);
  const packagedCron = archive.find(
    (entry) => entry.path === "home/crons.json",
  );
  expect(packagedCron?.body).toBeDefined();
  const packagedCronBody = JSON.parse(packagedCron?.body ?? "{}") as Record<
    string,
    unknown
  >;
  expect(packagedCronBody.scheduler_owner).toBeNull();
  expect(packagedCronBody.scheduler_owners).toEqual({});
  const packagedSettings = JSON.parse(
    archive.find((entry) => entry.path === "home/settings.json")?.body ?? "{}",
  ) as Record<string, unknown>;
  expect(packagedSettings.refreshToken).toBeUndefined();
  expect(
    (packagedSettings.env as Record<string, unknown>).LETTA_API_KEY,
  ).toBeUndefined();

  // ── the second machine, verify only ───────────────────────────────
  const stale = seedTargetMachine();
  const targetDeps = depsFor(targetHome, targetStorage, workspace.path);
  const confirmations: string[] = [];

  const verified = await runImport({
    from: packagePath,
    verify: true,
    deps: targetDeps,
    requireConfirm: async () => {
      confirmations.push("verify");
      return true;
    },
  });
  expect(verified.ok).toBe(true);
  expect(confirmedNothing(confirmations)).toBe(true);
  expect(readAt(targetHome, "settings.json")).toBe('{"stale":true}\n');
  expect(existsAt(targetHome, join("backups", "pre-import.hryk"))).toBe(false);

  // ── the import ────────────────────────────────────────────────────
  const imported = await runImport({
    from: packagePath,
    withProject: targetProject,
    verbose: true,
    deps: targetDeps,
    requireConfirm: async () => {
      confirmations.push("import");
      return true;
    },
  });

  expect(imported.ok).toBe(true);
  expect(imported.code).toBe("ok");
  expect(confirmations).toEqual(["import"]);
  expect(imported.counts).toEqual(exported.counts);
  expect(imported.failedSecrets).toEqual([]);
  expect(imported.backupPath).toBe(
    join(targetHome, "backups", "pre-import.hryk"),
  );
  expect(existsSync(imported.backupPath ?? "")).toBe(true);
  expect(imported.remapped).toHaveLength(1);
  expect(imported.remapped[0]).toEqual({
    field: `sessionsByServer.local:${sourceStorage}`,
    from: `local:${sourceStorage}`,
    to: `local:${targetStorage}`,
  });
  expect(imported.notRemapped.length).toBeGreaterThanOrEqual(3);
  // The import report carries the manifest's rule table, so a reader can see
  // what a restore leaves alone without opening the package.
  expect(imported.excluded).toHaveLength(20);

  // ── settings: restored, token written back, bucket key rewritten ──
  const restoredSettings = readJsonAt(targetHome, "settings.json");
  expect(restoredSettings.permissions).toEqual({ allow: ["Bash(ls)"] });
  expect(restoredSettings.recentModels).toEqual(["anthropic/claude"]);
  expect(restoredSettings.refreshToken).toBe(SETTINGS_REFRESH_TOKEN);
  expect((restoredSettings.env as Record<string, unknown>).LETTA_API_KEY).toBe(
    SETTINGS_API_KEY,
  );
  expect((restoredSettings.env as Record<string, unknown>).KEPT).toBe(
    "kept-value",
  );
  expect(restoredSettings.sessionsByServer).toEqual({
    [`local:${targetStorage}`]: { selected: CONVERSATIONS[0] },
  });

  // ── the seven item classes ────────────────────────────────────────
  expect(readAt(targetHome, "sessions.jsonl")).toBe(source.sessions);
  const restoredCron = readJsonAt(targetHome, "crons.json");
  expect(restoredCron.scheduler_owner).toBeNull();
  expect(restoredCron.scheduler_owners).toEqual({});
  expect(restoredCron.tasks).toEqual([
    { id: "task-1", schedule: "0 * * * *", prompt: "check" },
  ]);

  expect(readAt(targetStorage, join("agents", `${AGENT_ID}.json`))).toBe(
    source.agentRecord,
  );
  for (const key of CONVERSATIONS) {
    const expected = source.conversation.get(key);
    expect(expected).toBeDefined();
    expect(
      readAt(targetStorage, join("conversations", key, "messages.jsonl")),
    ).toBe(expected?.messages ?? "");
    expect(
      readAt(targetStorage, join("conversations", key, "conversation.json")),
    ).toBe(expected?.conversation ?? "");
  }

  expect(
    readAt(targetStorage, join("memfs", AGENT_ID, "memory", "notes.md")),
  ).toBe(source.memory);
  expect(
    existsAt(targetStorage, join("memfs", AGENT_ID, "memory", ".git", "HEAD")),
  ).toBe(true);
  // The package carries the lock, and the import clears it (docs/44-2 §5.10.2).
  expect(
    existsAt(
      targetStorage,
      join("memfs", AGENT_ID, "memory", ".git", "index.lock"),
    ),
  ).toBe(false);

  // channels/ and transcripts/ follow the literal home root, not HARUYUKI_HOME.
  expect(
    readAt(literalBase, join("transcripts", "background", "t1.jsonl")),
  ).toBe(source.transcript);
  expect(
    existsAt(targetHome, join("transcripts", "background", "t1.jsonl")),
  ).toBe(false);

  // The project tree travels at its narrow scope only (user ruling 2026-10-26).
  expect(readAt(targetProject, join(".haruyuki", "settings.json"))).toBe(
    source.projectSettings,
  );
  expect(readAt(targetProject, join("src", "index.ts"))).toBe(
    "// the target project is not a snapshot\n",
  );
  expect(readAt(targetProject, ".env")).toBe("TARGET_SECRET=keep\n");

  // ── snapshot semantics: managed data outside the package is cleared ─
  expect(existsAt(targetHome, join("agents", "stale-agent", "note.txt"))).toBe(
    false,
  );
  expect(existsAt(targetStorage, join("conversations", "conv-stale"))).toBe(
    false,
  );
  // Excluded and unknown paths are never touched.
  expect(readAt(targetHome, join("logs", "keep.log"))).toBe("keep me\n");
  expect(readAt(targetHome, join("work", "scratch.txt"))).toBe("not managed\n");

  // ── the credentials really landed in the target store ─────────────
  pointAt(targetHome, targetStorage);
  const restoredSecrets = await refreshAndListSecrets(AGENT_ID);
  const restoredNames = restoredSecrets.map((entry) => entry.key).sort();
  expect(restoredNames).toEqual(Object.keys(AGENT_SECRETS).sort());
  for (const entry of restoredSecrets) {
    expect(entry.value).toBe(AGENT_SECRETS[entry.key] as string);
  }

  // ── the backup is a package: importing it is the manual recovery ──
  const recovered = await runImport({
    from: imported.backupPath as string,
    yes: true,
    deps: targetDeps,
  });
  expect(recovered.ok).toBe(true);
  expect(readAt(targetHome, "sessions.jsonl")).toBe(stale.staleSessions);
});

/** A verify-only run must never ask the user to confirm anything. */
function confirmedNothing(confirmations: readonly string[]): boolean {
  return confirmations.length === 0;
}

test("--dry-run reports the same entry count as the real package", async () => {
  await seedSourceMachine();
  const deps = depsFor(sourceHome, sourceStorage, workspace.path);
  const dryPackage = workspace.resolve("dry.hryk");
  const realPackage = workspace.resolve("real.hryk");

  const preview = await runExport({ out: dryPackage, dryRun: true, deps });
  expect(preview.ok).toBe(true);
  expect(preview.dryRun).toBe(true);
  expect(existsSync(dryPackage)).toBe(false);
  expect(existsSync(`${dryPackage}.partial`)).toBe(false);

  const real = await runExport({ out: realPackage, deps });
  expect(real.ok).toBe(true);
  expect(preview.counts).toEqual(real.counts);
  expect(preview.byScope).toEqual(real.byScope);
  expect(existsSync(realPackage)).toBe(true);
});
