import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { TestDirectory } from "@/test-utils/test-fs";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";
import {
  __testOverrideLocalSecretStorage,
  clearSecretsCache,
} from "@/utils/secrets-store";
import { readTarGz } from "@/utils/tar-stream";
import { runExport } from "./export";
import { parseManifest, verifyManifest } from "./manifest";
import { DIRECTORY_ENTRY_SHA256, scopeExclusions } from "./scope";
import {
  __setSnapshotSecretsIoForTests,
  type SecretBundle,
  type SnapshotSecretsIo,
} from "./secrets";
import type {
  SnapshotEntry,
  SnapshotManifest,
  SnapshotPhase,
  SnapshotProgress,
  SnapshotReport,
  SnapshotScope,
} from "./types";
import { SnapshotError } from "./types";

/* ------------------------------------------------------------------ */
/* Isolation                                                            */
/* ------------------------------------------------------------------ */

const initialHaruyukiHome = process.env.HARUYUKI_HOME;
const initialLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;

let directory: TestDirectory;
let appHome: string;
let storageDir: string;
let channelsRoot: string;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Keychain unavailable: the settings tokens come from the file fallback. */
function fileSecretsIo(): SnapshotSecretsIo {
  return {
    isKeychainAvailable: async () => false,
    getSecureTokens: async () => {
      throw new Error("the keychain is unavailable in this test");
    },
    setSecureTokens: async () => {
      throw new Error("export never writes secrets");
    },
  };
}

interface MemorySecretStorage {
  get(name: string, label: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

function memorySecretStorage(
  seed: Record<string, string>,
): MemorySecretStorage {
  const values = new Map(Object.entries(seed));
  return {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => values.delete(name),
  };
}

function seedAgentSecrets(
  agentId: string,
  secrets: Record<string, string>,
): Record<string, string> {
  const seed: Record<string, string> = {
    [`agent:${agentId}:secrets:index`]: JSON.stringify(
      Object.keys(secrets).sort(),
    ),
  };
  for (const [name, value] of Object.entries(secrets)) {
    seed[`agent:${agentId}:secrets:${name}`] = value;
  }
  return seed;
}

/**
 * A secret store that resolves its file through `getLocalBackendStorageDir()`
 * at call time, i.e. through `LETTA_LOCAL_BACKEND_DIR`. It is how the
 * storage-root/environment agreement is proved rather than assumed.
 */
function envRootedSecretStorage(): MemorySecretStorage {
  const read = (): Record<string, string> => {
    const path = join(
      getLocalBackendStorageDir(),
      "secrets",
      "local-agent-secrets.json",
    );
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      secrets?: Record<string, string>;
    };
    return parsed.secrets ?? {};
  };
  return {
    get: async (name) => read()[name] ?? null,
    set: async () => {},
    delete: async () => false,
  };
}

function writeFileAt(
  root: string,
  relativePath: string,
  content: string,
): string {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf-8");
  return target;
}

/** The smallest tree that produces `home/`, `local-backend/` and secrets. */
function seedMinimalTree(): void {
  writeFileAt(
    appHome,
    "settings.json",
    JSON.stringify({ permissions: {}, tokenStreaming: true }),
  );
  writeFileAt(appHome, "sessions.jsonl", '{"id":"session-1"}\n');
  writeFileAt(storageDir, join("agents", "agent-1.json"), '{"id":"agent-1"}');
  writeFileAt(
    storageDir,
    join("conversations", "c1", "conversation.json"),
    '{"id":"c1"}',
  );
  writeFileAt(storageDir, join("conversations", "c1", "manifest.json"), "{}");
  writeFileAt(
    storageDir,
    join("conversations", "c1", "messages.jsonl"),
    '{"id":"m1"}\n',
  );
}

beforeEach(() => {
  directory = new TestDirectory();
  appHome = join(directory.path, "app-home");
  storageDir = join(directory.path, "storage");
  channelsRoot = join(directory.path, "channels-root");
  mkdirSync(appHome, { recursive: true });
  mkdirSync(storageDir, { recursive: true });

  // The pipeline is told the roots twice on purpose: through `deps` (what it
  // must use) and through the environment (what the secret stores resolve).
  process.env.HARUYUKI_HOME = appHome;
  process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
  __testOverrideChannelsRoot(channelsRoot);
  __setSnapshotSecretsIoForTests(fileSecretsIo());
  __testOverrideLocalSecretStorage(memorySecretStorage({}));
  clearSecretsCache(null);
});

afterEach(() => {
  __setSnapshotSecretsIoForTests(null);
  __testOverrideLocalSecretStorage(null);
  clearSecretsCache(null);
  __testOverrideChannelsRoot(null);
  restoreEnv("HARUYUKI_HOME", initialHaruyukiHome);
  restoreEnv("LETTA_LOCAL_BACKEND_DIR", initialLocalBackendDir);
  directory.cleanup();
});

/* ------------------------------------------------------------------ */
/* Reading a package back                                               */
/* ------------------------------------------------------------------ */

interface ReadBack {
  /** Entry paths in archive order. */
  order: string[];
  /** Independent digests of everything but `manifest.json`. */
  actual: SnapshotEntry[];
  bodies: Map<string, Buffer>;
  manifest: SnapshotManifest;
}

function scopeFor(path: string): SnapshotScope {
  if (path === "secrets.json") return "secrets";
  // The narrow project scope (§5.3 C) no longer emits a bare `project` root
  // entry; the branch stays as a guard so a regression lands in the project
  // bucket (and fails the managed-path whitelist) instead of hiding under home.
  if (path === "project" || path.startsWith("project/")) return "project";
  if (path === "local-backend" || path.startsWith("local-backend/")) {
    return "local-backend";
  }
  return "home";
}

/**
 * Read the package with the real reader and recompute every digest from the
 * bytes that came back, so the assertions never trust the manifest's own claims.
 */
async function readBack(file: string): Promise<ReadBack> {
  const order: string[] = [];
  const actual: SnapshotEntry[] = [];
  const bodies = new Map<string, Buffer>();

  await readTarGz({
    file,
    onEntry: async (entry) => {
      order.push(entry.path);
      const scope = scopeFor(entry.path);
      if (entry.type === "dir") {
        actual.push({
          path: entry.path,
          scope,
          bytes: 0,
          sha256: DIRECTORY_ENTRY_SHA256,
        });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of entry.open()) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      bodies.set(entry.path, body);
      actual.push({
        path: entry.path,
        scope,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    },
  });

  const manifestText = bodies.get("manifest.json");
  if (manifestText === undefined)
    throw new Error("package has no manifest.json");
  return {
    order,
    actual: actual.filter((entry) => entry.path !== "manifest.json"),
    bodies,
    manifest: parseManifest(manifestText.toString("utf-8")),
  };
}

function bodyText(read: ReadBack, path: string): string {
  const body = read.bodies.get(path);
  if (body === undefined) throw new Error(`package has no ${path}`);
  return body.toString("utf-8");
}

function pathsWithScope(read: ReadBack, scope: SnapshotScope): string[] {
  return read.actual
    .filter((entry) => entry.scope === scope)
    .map((entry) => entry.path);
}

async function expectRejected(
  promise: Promise<unknown>,
): Promise<SnapshotError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotError);
    return error as SnapshotError;
  }
  throw new Error("expected the export to fail");
}

function expectOk(report: SnapshotReport): void {
  expect(report.ok).toBe(true);
  expect(report.code).toBe("ok");
  expect(report.command).toBe("export");
}

/* ------------------------------------------------------------------ */
/* A real package                                                       */
/* ------------------------------------------------------------------ */

test("writes a readable package whose manifest is last and verifies", async () => {
  seedMinimalTree();
  const out = join(directory.path, "one.hryk");

  const report = await runExport({
    out,
    deps: { homeRoot: appHome, storageDir },
  });

  expectOk(report);
  expect(report.out).toBe(out);
  expect(report.dryRun).toBe(false);
  expect(existsSync(out)).toBe(true);
  expect(existsSync(`${out}.partial`)).toBe(false);

  const read = await readBack(out);
  // manifest.json is the last entry: the archive names itself only once every
  // other entry is on disk.
  expect(read.order[read.order.length - 1]).toBe("manifest.json");
  expect(read.order).toContain("home/settings.json");
  expect(read.order).toContain("home/sessions.jsonl");
  expect(read.order).toContain("local-backend/agents/agent-1.json");
  expect(read.order).toContain("secrets.json");

  // The archive is what the manifest claims, entry for entry.
  const verification = verifyManifest(read.manifest, read.actual);
  expect(verification).toEqual({ ok: true, failures: 0 });
  expect(read.manifest.counts).toEqual(report.counts);
  expect(report.counts.files).toBe(read.actual.length);
  expect(read.manifest.entries).toEqual(read.actual);

  // byScope adds up to counts, and every packed tree has a bucket.
  expect(report.byScope).toBeDefined();
  const byScope = report.byScope ?? {};
  expect(Object.keys(byScope).sort()).toEqual([
    "home",
    "local-backend",
    "secrets",
  ]);
  const files = Object.values(byScope).reduce(
    (total, bucket) => total + (bucket?.files ?? 0),
    0,
  );
  const bytes = Object.values(byScope).reduce(
    (total, bucket) => total + (bucket?.bytes ?? 0),
    0,
  );
  expect(files).toBe(report.counts.files);
  expect(bytes).toBe(report.counts.bytes);
  expect(byScope.secrets).toEqual({
    files: 1,
    bytes: bodyText(read, "secrets.json").length,
  });

  // Non-verbose runs never carry the entry list.
  expect(report.entries).toBeUndefined();
});

test("--dry-run writes nothing and reports the same entries and totals", async () => {
  seedMinimalTree();
  const out = join(directory.path, "preview.hryk");

  const preview = await runExport({
    out,
    dryRun: true,
    verbose: true,
    deps: { homeRoot: appHome, storageDir },
  });

  expectOk(preview);
  expect(preview.dryRun).toBe(true);
  // Nothing on disk: no package, no half package.
  expect(existsSync(out)).toBe(false);
  expect(existsSync(`${out}.partial`)).toBe(false);
  const leftovers = readdirNames(directory.path);
  expect(leftovers).not.toContain("preview.hryk");
  expect(leftovers).not.toContain("preview.hryk.partial");

  const real = await runExport({
    out,
    verbose: true,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(real);

  expect(preview.counts).toEqual(real.counts);
  expect(preview.byScope).toEqual(real.byScope);
  expect(preview.entries?.map((entry) => entry.path)).toEqual(
    real.entries?.map((entry) => entry.path),
  );
  // A preview has sizes but no hashes (§5.7.1 forbids hashing a preview).
  for (const entry of preview.entries ?? []) {
    expect(entry.sha256).toBe("");
  }
  // A real verbose run carries exactly the manifest's entry list.
  const read = await readBack(out);
  expect(real.entries).toEqual(read.manifest.entries);
});

function readdirNames(root: string): string[] {
  return readdirSync(root);
}

test("reports the §5.13.1 stages and no secret values in the report", async () => {
  seedMinimalTree();
  const out = join(directory.path, "stages.hryk");
  const phases: SnapshotPhase[] = [];

  const report = await runExport(
    { out, deps: { homeRoot: appHome, storageDir } },
    (update: SnapshotProgress) => {
      phases.push(update.phase);
    },
  );

  expectOk(report);
  expect([...new Set(phases)]).toEqual([
    "prepare",
    "scan",
    "pack",
    "verify",
    "done",
  ]);

  const previewPhases: SnapshotPhase[] = [];
  await runExport(
    {
      out: join(directory.path, "stages-preview.hryk"),
      dryRun: true,
      deps: { homeRoot: appHome, storageDir },
    },
    (update: SnapshotProgress) => {
      previewPhases.push(update.phase);
    },
  );
  expect([...new Set(previewPhases)]).toEqual(["prepare", "scan", "done"]);
});

/* ------------------------------------------------------------------ */
/* Settings sanitisation                                                */
/* ------------------------------------------------------------------ */

test("packages a sanitised settings copy and leaves the source untouched", async () => {
  const settingsPath = writeFileAt(
    appHome,
    "settings.json",
    JSON.stringify({
      tokenStreaming: true,
      refreshToken: "refresh-token-value",
      env: { LETTA_API_KEY: "api-key-value", LETTA_BASE_URL: "http://local" },
    }),
  );
  const sourceBefore = readFileSync(settingsPath, "utf-8");
  writeFileAt(appHome, "sessions.jsonl", "{}\n");
  const out = join(directory.path, "settings.hryk");

  const report = await runExport({
    out,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(report);

  const read = await readBack(out);
  const packagedSettings = bodyText(read, "home/settings.json");
  expect(packagedSettings).not.toContain("LETTA_API_KEY");
  expect(packagedSettings).not.toContain("api-key-value");
  expect(packagedSettings).not.toContain("refreshToken");
  expect(packagedSettings).not.toContain("refresh-token-value");
  const parsed = JSON.parse(packagedSettings) as Record<string, unknown>;
  expect(parsed.tokenStreaming).toBe(true);
  expect(parsed.env).toEqual({ LETTA_BASE_URL: "http://local" });

  // Export is read-only: the source file is byte-for-byte what it was.
  expect(readFileSync(settingsPath, "utf-8")).toBe(sourceBefore);

  // The values did not vanish: they travel in secrets.json.settings instead.
  const bundle = JSON.parse(bodyText(read, "secrets.json")) as SecretBundle;
  expect(bundle.version).toBe(1);
  expect(bundle.settings["letta-api-key"]).toBe("api-key-value");
  expect(bundle.settings["letta-refresh-token"]).toBe("refresh-token-value");
  expect(report.counts.secrets).toBe(2);

  // No output channel carries a value (§5.4.5).
  expect(report.message).not.toContain("api-key-value");
  expect(report.message).not.toContain("refresh-token-value");
  expect(JSON.stringify(report.warnings)).not.toContain("api-key-value");
});

/* ------------------------------------------------------------------ */
/* Schedule leases                                                      */
/* ------------------------------------------------------------------ */

test("schedules.json ships with scheduler and task leases cleared, source untouched", async () => {
  const schedulesPath = writeFileAt(
    appHome,
    "schedules.json",
    JSON.stringify(
      {
        version: 2,
        scheduler_owner: { pid: 4242, token: "machine-a" },
        scheduler_owners: { local: { pid: 4242, token: "machine-a" } },
        signal_state: { cursor: { cron: "2026-10-26T00:00:00.000Z" } },
        tasks: [
          {
            id: "task-1",
            cron: "0 * * * *",
            status: "active",
            prompt: "ping",
            lease: {
              runId: "run-1",
              host: "long-lived",
              pid: 4242,
              token: "machine-a",
              startedAt: "2026-10-26T00:00:00.000Z",
              heartbeatAt: "2026-10-26T00:00:00.000Z",
              expiresAt: "2026-10-26T00:01:30.000Z",
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  // The v1 backup is read-only history and must not travel; crons.json is not
  // managed any more either, so neither old filename is packed.
  writeFileAt(appHome, "crons.v1.json", '{"version":1,"tasks":[]}');
  writeFileAt(appHome, "crons.json", '{"version":1,"tasks":[]}');
  const sourceBefore = readFileSync(schedulesPath, "utf-8");
  const out = join(directory.path, "schedules.hryk");

  // The preview must already count the rewritten copy's size.
  const preview = await runExport({
    out,
    dryRun: true,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(preview);

  const report = await runExport({
    out,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(report);
  expect(preview.counts).toEqual(report.counts);

  const read = await readBack(out);
  const packaged = bodyText(read, "home/schedules.json");
  const parsed = JSON.parse(packaged) as Record<string, unknown>;
  // Both lease levels are cleared: the target never adopts the exporter's.
  expect(parsed.scheduler_owner).toBeNull();
  expect(parsed.scheduler_owners).toEqual({});
  const tasks = parsed.tasks as Record<string, unknown>[];
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.lease).toBeNull();
  // Tasks, the signal cursor and every other field travel verbatim.
  expect(tasks[0]?.id).toBe("task-1");
  expect(tasks[0]?.cron).toBe("0 * * * *");
  expect(tasks[0]?.prompt).toBe("ping");
  expect(parsed.signal_state).toEqual({
    cursor: { cron: "2026-10-26T00:00:00.000Z" },
  });
  expect(packaged).not.toContain("machine-a");
  expect(packaged).not.toContain("run-1");
  expect(read.manifest.entries.some((e) => e.path === "home/crons.json")).toBe(
    false,
  );
  expect(
    read.manifest.entries.some((e) => e.path === "home/crons.v1.json"),
  ).toBe(false);

  // Export is read-only: the source keeps its leases byte for byte.
  expect(readFileSync(schedulesPath, "utf-8")).toBe(sourceBefore);

  // The packaged copy is a normal manifest entry with its own size.
  const entry = read.manifest.entries.find(
    (candidate) => candidate.path === "home/schedules.json",
  );
  expect(entry?.bytes).toBe(Buffer.byteLength(packaged, "utf-8"));
});

test("unparseable schedules.json aborts before anything is written", async () => {
  writeFileAt(appHome, "settings.json", JSON.stringify({ permissions: {} }));
  writeFileAt(appHome, "schedules.json", "{ not json");
  const out = join(directory.path, "bad-schedules.hryk");

  const failure = await expectRejected(
    runExport({ out, deps: { homeRoot: appHome, storageDir } }),
  );

  expect(failure.code).toBe("io_error");
  expect(failure.message).toContain("home/schedules.json");
  expect(existsSync(out)).toBe(false);
  expect(existsSync(`${out}.partial`)).toBe(false);
});

/* ------------------------------------------------------------------ */
/* Secrets                                                              */
/* ------------------------------------------------------------------ */

test("secrets.json is a manifest entry under the secrets scope, with tree-derived agents", async () => {
  writeFileAt(appHome, "settings.json", JSON.stringify({ permissions: {} }));
  // Three agent ids, three derivations: a home agent directory, a memfs tree
  // and a local-backend agent record.
  mkdirSync(join(appHome, "agents", "agent-a"), { recursive: true });
  writeFileAt(
    storageDir,
    join("memfs", "agent-b", "memory", "README.md"),
    "# b",
  );
  writeFileAt(storageDir, join("agents", "agent-c.json"), '{"id":"agent-c"}');
  __testOverrideLocalSecretStorage(
    memorySecretStorage({
      ...seedAgentSecrets("agent-a", { OPENAI_KEY: "sk-a" }),
      ...seedAgentSecrets("agent-b", { ANTHROPIC_KEY: "sk-b" }),
      ...seedAgentSecrets("agent-c", { GEMINI_KEY: "sk-c" }),
    }),
  );
  const out = join(directory.path, "secrets.hryk");

  const report = await runExport({
    out,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(report);

  const read = await readBack(out);
  const secretsEntry = read.manifest.entries.find(
    (entry) => entry.path === "secrets.json",
  );
  expect(secretsEntry?.scope).toBe("secrets");
  expect(report.byScope?.secrets).toEqual({
    files: 1,
    bytes: secretsEntry?.bytes ?? -1,
  });

  const bundle = JSON.parse(bodyText(read, "secrets.json")) as SecretBundle;
  expect(Object.keys(bundle.agents).sort()).toEqual([
    "agent-a",
    "agent-b",
    "agent-c",
  ]);
  expect(bundle.agents["agent-b"]).toEqual({ ANTHROPIC_KEY: "sk-b" });
  expect(report.counts.secrets).toBe(3);
});

test("reads agent secrets from the pinned storageDir, not the ambient root", async () => {
  writeFileAt(storageDir, join("agents", "agent-1.json"), '{"id":"agent-1"}');
  const storageSecrets = join(
    storageDir,
    "secrets",
    "local-agent-secrets.json",
  );
  writeFileAt(
    storageDir,
    join("secrets", "local-agent-secrets.json"),
    JSON.stringify({
      secrets: seedAgentSecrets("agent-1", { OPENAI_KEY: "from-storage" }),
    }),
  );

  // The ambient root is somewhere else, with the same key and a different value.
  const decoyRoot = join(directory.path, "decoy-storage");
  writeFileAt(
    decoyRoot,
    join("secrets", "local-agent-secrets.json"),
    JSON.stringify({
      secrets: seedAgentSecrets("agent-1", { OPENAI_KEY: "from-decoy" }),
    }),
  );
  process.env.LETTA_LOCAL_BACKEND_DIR = decoyRoot;
  __testOverrideLocalSecretStorage(envRootedSecretStorage());
  clearSecretsCache(null);

  const out = join(directory.path, "pinned.hryk");
  await runExport({ out, deps: { homeRoot: appHome, storageDir } });

  const read = await readBack(out);
  const bundle = JSON.parse(bodyText(read, "secrets.json")) as SecretBundle;
  expect(bundle.agents["agent-1"]).toEqual({ OPENAI_KEY: "from-storage" });
  // The preference is scoped to the export: the ambient root is restored.
  expect(process.env.LETTA_LOCAL_BACKEND_DIR).toBe(decoyRoot);
  expect(existsSync(storageSecrets)).toBe(true);
});

/* ------------------------------------------------------------------ */
/* Project tree (narrow scope: §5.3 C, 2026-10-26 ruling)               */
/* ------------------------------------------------------------------ */

/**
 * The project scope is the six §5.3 C rows (2026-10-26 ruling), not a mirror of
 * the checkout: three literal files plus three managed directories. Anything
 * else under `project/` — source files, `.env`, `.git`, `node_modules`, the
 * harness's own worktrees — must stay out of a package.
 */
const MANAGED_PROJECT_PREFIXES = [
  "project/.commands",
  "project/.agents/skills",
  "project/.skills",
] as const;

/** The three literal project files the narrow scope carries. */
const MANAGED_PROJECT_FILES = [
  "project/.haruyuki/settings.json",
  "project/.haruyuki/settings.local.json",
  "project/.haruyukiignore",
] as const;

function isManagedProjectPath(path: string): boolean {
  if ((MANAGED_PROJECT_FILES as readonly string[]).includes(path)) return true;
  return MANAGED_PROJECT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

test("--with-project adds only the six managed project paths", async () => {
  seedMinimalTree();
  const project = join(directory.path, "repo");
  // All six managed rows, plus one file for every tree the narrow scope drops.
  writeFileAt(project, join(".haruyuki", "settings.json"), "{}");
  writeFileAt(project, join(".haruyuki", "settings.local.json"), "{}");
  writeFileAt(project, ".haruyukiignore", "ignore");
  writeFileAt(project, join(".commands", "ship.md"), "ship");
  writeFileAt(
    project,
    join(".agents", "skills", "project-skill", "SKILL.md"),
    "# skill",
  );
  writeFileAt(
    project,
    join(".skills", "legacy-skill", "SKILL.md"),
    "# legacy skill",
  );
  // Not managed: sources, dotenv, git metadata, dependencies, worktrees.
  writeFileAt(project, join("src", "index.ts"), "export {};");
  writeFileAt(project, ".env", "SECRET=value");
  writeFileAt(project, join("node_modules", "left-pad", "index.js"), "module");
  writeFileAt(project, join(".git", "HEAD"), "ref: main");
  writeFileAt(project, join(".haruyuki", "worktrees", "wt", "draft.md"), "x");

  const withoutProject = join(directory.path, "plain.hryk");
  const plain = await runExport({
    out: withoutProject,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(plain);
  const plainRead = await readBack(withoutProject);
  expect(pathsWithScope(plainRead, "project")).toEqual([]);
  expect(plainRead.manifest.roots.project).toBeUndefined();
  expect(plain.byScope?.project).toBeUndefined();

  const withProject = join(directory.path, "project.hryk");
  const report = await runExport({
    out: withProject,
    withProject: project,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(report);
  const read = await readBack(withProject);
  const projectPaths = pathsWithScope(read, "project");

  // All six managed rows are in, including the two skills trees.
  for (const expected of MANAGED_PROJECT_FILES) {
    expect(projectPaths).toContain(expected);
  }
  expect(projectPaths).toContain("project/.commands/ship.md");
  expect(projectPaths).toContain(
    "project/.agents/skills/project-skill/SKILL.md",
  );
  expect(projectPaths).toContain("project/.skills/legacy-skill/SKILL.md");

  // Nothing outside the managed rows is in — and that includes the source
  // file, `.env`, git metadata, dependencies and managed worktrees.
  for (const path of projectPaths) {
    expect(isManagedProjectPath(path)).toBe(true);
  }
  expect(projectPaths).not.toContain("project/src/index.ts");
  expect(projectPaths).not.toContain("project/.env");
  for (const dropped of [
    "project/src",
    "project/node_modules",
    "project/.git",
    "project/.haruyuki/worktrees",
  ]) {
    expect(projectPaths.some((path) => path.startsWith(dropped))).toBe(false);
  }

  // The packaged bytes are the managed ones only: the `.env` value never
  // reaches the archive.
  expect(read.bodies.has("project/.env")).toBe(false);

  expect(read.manifest.roots.project).toBe(project);
  expect(report.byScope?.project).toEqual({
    files: projectPaths.length,
    bytes: projectPaths.reduce(
      (total, path) => total + (read.bodies.get(path)?.length ?? 0),
      0,
    ),
  });
  // The only extra entries are the project rows: home, local-backend and
  // secrets.json are unchanged.
  expect(report.counts.files).toBe(plain.counts.files + projectPaths.length);
  expect(report.counts.secrets).toBe(plain.counts.secrets);
  // A tree that does contribute must never draw the empty-tree warning.
  expect(
    report.warnings.some((warning) =>
      warning.includes("holds no managed paths"),
    ),
  ).toBe(false);
});

test("a project with only unmanaged files contributes no project entries", async () => {
  seedMinimalTree();
  const project = join(directory.path, "source-repo");
  // A real directory, but nothing the narrow scope manages.
  writeFileAt(project, join("src", "index.ts"), "export {};");
  writeFileAt(project, ".env", "SECRET=value");
  writeFileAt(project, join("node_modules", "left-pad", "index.js"), "module");
  const out = join(directory.path, "unmanaged-project.hryk");

  const report = await runExport({
    out,
    withProject: project,
    deps: { homeRoot: appHome, storageDir },
  });

  expectOk(report);
  const read = await readBack(out);
  expect(pathsWithScope(read, "project")).toEqual([]);
  // Nothing was collected, so the manifest records no project root and the
  // report has no project bucket.
  expect(read.manifest.roots.project).toBeUndefined();
  expect(report.byScope?.project).toBeUndefined();
  // A silent empty tree is indistinguishable from a typo, so it is called out
  // once — the "directory does not exist" cause has its own, separate warning.
  const emptyWarnings = report.warnings.filter((warning) =>
    warning.includes("holds no managed paths"),
  );
  expect(emptyWarnings).toHaveLength(1);
  expect(emptyWarnings[0]).toContain(project);
  expect(report.warnings.some((warning) => warning.includes("not found"))).toBe(
    false,
  );
});

test("a missing --with-project directory is a warning, not a failure", async () => {
  seedMinimalTree();
  const out = join(directory.path, "missing-project.hryk");
  const missing = join(directory.path, "no-such-repo");

  const report = await runExport({
    out,
    withProject: missing,
    deps: { homeRoot: appHome, storageDir },
  });

  expectOk(report);
  // Exactly one project-related warning: the missing-directory cause never also
  // claims the empty-tree cause.
  const projectWarnings = report.warnings.filter((warning) =>
    warning.includes("project directory"),
  );
  expect(projectWarnings).toHaveLength(1);
  expect(projectWarnings[0]).toContain("no-such-repo");
  expect(projectWarnings[0]).toContain("not found");
  expect(
    report.warnings.some((warning) =>
      warning.includes("holds no managed paths"),
    ),
  ).toBe(false);
  const read = await readBack(out);
  expect(pathsWithScope(read, "project")).toEqual([]);
  expect(read.manifest.roots.project).toBeUndefined();
  expect(report.byScope?.project).toBeUndefined();
});

/* ------------------------------------------------------------------ */
/* Target handling                                                      */
/* ------------------------------------------------------------------ */

test("an existing target file is overwritten", async () => {
  seedMinimalTree();
  const out = join(directory.path, "existing.hryk");
  writeFileSync(out, "not a package", "utf-8");

  const report = await runExport({
    out,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(report);

  const read = await readBack(out);
  expect(read.manifest.format).toBe("haruyuki-snapshot");
  expect(read.order[read.order.length - 1]).toBe("manifest.json");
  expect(existsSync(`${out}.partial`)).toBe(false);
});

test("a target that is a directory is an io_error and writes nothing", async () => {
  seedMinimalTree();
  const out = join(directory.path, "a-directory");
  mkdirSync(out);

  const failure = await expectRejected(
    runExport({ out, deps: { homeRoot: appHome, storageDir } }),
  );

  expect(failure.code).toBe("io_error");
  expect(failure.message).toContain("is a directory");
  expect(existsSync(`${out}.partial`)).toBe(false);
});

/* ------------------------------------------------------------------ */
/* Failures                                                             */
/* ------------------------------------------------------------------ */

test("an unreadable entry aborts, deletes the .partial and names the entry", async () => {
  seedMinimalTree();
  const victim = join(appHome, "sessions.jsonl");
  const out = join(directory.path, "failing.hryk");
  const partial = `${out}.partial`;

  const progress = (update: SnapshotProgress): void => {
    // The pack stage is announced before the first byte is written, so removing
    // a collected file here is what a file vanishing mid-export looks like.
    if (update.phase === "pack") {
      unlinkSync(victim);
    }
  };

  const failure = await expectRejected(
    runExport({ out, deps: { homeRoot: appHome, storageDir } }, progress),
  );

  expect(failure.code).toBe("io_error");
  // First (and only) failing entry plus the failure total.
  expect(failure.message).toContain("sessions.jsonl");
  expect(failure.message).toContain("1 entry failed");
  expect(existsSync(partial)).toBe(false);
  expect(existsSync(out)).toBe(false);
});

test("unparseable settings abort before anything is written", async () => {
  writeFileAt(appHome, "settings.json", "{ this is not json");
  writeFileAt(appHome, "sessions.jsonl", "{}\n");
  const out = join(directory.path, "bad-settings.hryk");

  const failure = await expectRejected(
    runExport({ out, deps: { homeRoot: appHome, storageDir } }),
  );

  expect(failure.code).toBe("io_error");
  expect(failure.message).toContain("home/settings.json");
  expect(existsSync(out)).toBe(false);
  expect(existsSync(`${out}.partial`)).toBe(false);
});

/* ------------------------------------------------------------------ */
/* Exclusions                                                           */
/* ------------------------------------------------------------------ */

test("excluded paths never enter the package and stay out of the entry count", async () => {
  seedMinimalTree();
  writeFileAt(appHome, join("logs", "debug", "debug.log"), "noise");
  writeFileAt(appHome, join("cache", "index.bin"), "noise");
  writeFileAt(appHome, join("backups", "pre-import.hryk"), "noise");
  const out = join(directory.path, "excluded.hryk");

  const preview = await runExport({
    out,
    dryRun: true,
    deps: { homeRoot: appHome, storageDir },
  });
  expectOk(preview);
  const skipped = preview.excluded.map((exclusion) => exclusion.path);
  expect(skipped).toContain("home/logs");
  expect(skipped).toContain("home/cache");
  expect(skipped).toContain("home/backups");

  await runExport({ out, deps: { homeRoot: appHome, storageDir } });
  const read = await readBack(out);
  expect(read.order.some((path) => path.startsWith("home/logs"))).toBe(false);
  expect(read.order.some((path) => path.startsWith("home/cache"))).toBe(false);
  expect(read.order.some((path) => path.startsWith("home/backups"))).toBe(
    false,
  );
  // The manifest records the rule table (20 rows), not the evidence.
  expect(read.manifest.excluded).toEqual(scopeExclusions());
});
