import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { TestDirectory } from "@/test-utils/test-fs";
import { writeTarGz } from "@/utils/tar-stream";
import {
  __setImportFaultForTests,
  type ImportOptions,
  runImport,
} from "./import";
import { __setFreeSpaceProbeForTests } from "./import-place";
import { buildManifest, serializeManifest } from "./manifest";
import { DIRECTORY_ENTRY_SHA256 } from "./scope";
import { __setSnapshotSecretsIoForTests, type SecretBundle } from "./secrets";
import type {
  SnapshotCliDeps,
  SnapshotEntry,
  SnapshotRoots,
  SnapshotScope,
} from "./types";
import { snapshotError } from "./types";

const CLOCK = new Date("2026-10-26T00:00:00.000Z");
const BACKUP_NAME = "pre-import.hryk";

const ENV_KEYS = [
  "HARUYUKI_HOME",
  "LETTA_LOCAL_BACKEND_DIR",
  "HOME",
  "USERPROFILE",
  "HARUYUKI_SKIP_KEYCHAIN_CHECK",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

let workspace: TestDirectory;
let homeRoot: string;
let storageDir: string;
/**
 * The literal home directory the pipeline sees. The test preload pins
 * `os.homedir()` to a disposable per-process directory; `HARUYUKI_HOME` points
 * somewhere else, so `channels/` and `transcripts/` exercise the split on every
 * test.
 */
let homedirRoot: string;
let cleanLiteralHome = false;
let packageCount = 0;

function fileModeSecretsIo() {
  return {
    isKeychainAvailable: async () => false,
    getSecureTokens: async () => ({}),
    setSecureTokens: async () => {},
  };
}

function deps(): SnapshotCliDeps {
  return {
    homeRoot,
    storageDir,
    cwd: workspace.path,
    appVersion: "0.0.0-test",
    hostname: () => "test-host",
    now: () => new Date(CLOCK.getTime()),
  };
}

beforeEach(() => {
  workspace = new TestDirectory();
  homeRoot = workspace.resolve("haruyuki-home");
  storageDir = workspace.resolve("lc-local-backend");
  homedirRoot = os.homedir();
  process.env.HARUYUKI_HOME = homeRoot;
  process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
  process.env.HOME = homedirRoot;
  process.env.USERPROFILE = homedirRoot;
  process.env.HARUYUKI_SKIP_KEYCHAIN_CHECK = "1";
  packageCount = 0;
  cleanLiteralHome = false;
  __setImportFaultForTests(null);
  __setFreeSpaceProbeForTests(null);
  __setSnapshotSecretsIoForTests(fileModeSecretsIo());
});

afterEach(() => {
  __setImportFaultForTests(null);
  __setFreeSpaceProbeForTests(null);
  __setSnapshotSecretsIoForTests(null);
  if (cleanLiteralHome) {
    // The literal home is shared by the whole test process; the two literal-root
    // tests clean up after themselves so no later test inherits their fixtures.
    for (const segment of ["channels", "transcripts"]) {
      try {
        rmSync(join(literalBase(), segment), { recursive: true, force: true });
      } catch {
        // Best effort: the preload removes the whole disposable home anyway.
      }
    }
  }
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  workspace.cleanup();
});

// ── package construction (independent of the export pipeline) ───────

interface PackageFile {
  path: string;
  content: string | Buffer;
}

interface PackageSpec {
  dirs?: string[];
  files?: PackageFile[];
  secrets?: SecretBundle;
  roots?: SnapshotRoots;
  schemaVersion?: number;
  manifestWarnings?: string[];
  /** Entry whose manifest SHA-256 is deliberately wrong. */
  tamperSha?: string;
  /** Leave `manifest.json` out of the archive entirely. */
  omitManifest?: boolean;
  /** Write one extra entry AFTER the manifest, unclaimed by it. */
  trailingEntry?: PackageFile;
}

function sha256(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function scopeOf(path: string): SnapshotScope {
  if (path === "secrets.json") return "secrets";
  if (path === "home" || path.startsWith("home/")) return "home";
  if (path === "local-backend" || path.startsWith("local-backend/")) {
    return "local-backend";
  }
  return "project";
}

function emptyBundle(): SecretBundle {
  return {
    version: 1,
    settings: {},
    agents: {},
    channels: {},
    meta: { channelStoreMode: "file", capturedAt: CLOCK.toISOString() },
  };
}

function secretValueCount(bundle: SecretBundle): number {
  let total = Object.keys(bundle.settings).length;
  for (const values of Object.values(bundle.agents)) {
    total += Object.keys(values).length;
  }
  for (const accounts of Object.values(bundle.channels)) {
    for (const fields of Object.values(accounts)) {
      total += Object.keys(fields).length;
    }
  }
  return total;
}

function settingsJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writePackage(name: string, spec: PackageSpec): Promise<string> {
  packageCount += 1;
  const packagePath = workspace.resolve(`${packageCount}-${name}`);
  const dirs = spec.dirs ?? [];
  const files = spec.files ?? [];
  const roots: SnapshotRoots = spec.roots ?? {
    home: homeRoot,
    localBackend: storageDir,
  };
  const bundle = spec.secrets ?? emptyBundle();
  const secretsBody = Buffer.from(`${JSON.stringify(bundle)}\n`, "utf-8");

  const entries: SnapshotEntry[] = [];
  for (const dir of dirs) {
    entries.push({
      path: dir,
      scope: scopeOf(dir),
      bytes: 0,
      sha256: DIRECTORY_ENTRY_SHA256,
    });
  }
  const bodies = new Map<string, Buffer>();
  for (const file of files) {
    const body = Buffer.from(file.content);
    bodies.set(file.path, body);
    entries.push({
      path: file.path,
      scope: scopeOf(file.path),
      bytes: body.length,
      sha256: sha256(body),
    });
  }
  entries.push({
    path: "secrets.json",
    scope: "secrets",
    bytes: secretsBody.length,
    sha256: sha256(secretsBody),
  });

  const manifest = buildManifest(entries, roots, {
    appVersion: "0.0.0-test",
    createdAt: CLOCK.toISOString(),
    platform: `${process.platform}-${process.arch}`,
    hostname: "test-host",
    secrets: secretValueCount(bundle),
    warnings: spec.manifestWarnings ?? [],
  });
  if (spec.schemaVersion !== undefined) {
    manifest.schemaVersion = spec.schemaVersion;
  }
  if (spec.tamperSha !== undefined) {
    const claimed = manifest.entries.find(
      (entry) => entry.path === spec.tamperSha,
    );
    if (claimed) claimed.sha256 = "0".repeat(64);
  }
  const manifestBody = Buffer.from(serializeManifest(manifest), "utf-8");

  async function* tarEntries() {
    for (const dir of dirs) {
      yield { path: dir, type: "dir" as const };
    }
    for (const file of files) {
      yield {
        path: file.path,
        type: "file" as const,
        content: bodies.get(file.path),
      };
    }
    yield { path: "secrets.json", type: "file" as const, content: secretsBody };
    if (!spec.omitManifest) {
      yield {
        path: "manifest.json",
        type: "file" as const,
        content: manifestBody,
      };
    }
    if (spec.trailingEntry) {
      yield {
        path: spec.trailingEntry.path,
        type: "file" as const,
        content: Buffer.from(spec.trailingEntry.content),
      };
    }
  }

  await writeTarGz({ entries: tarEntries(), outFile: packagePath });
  return packagePath;
}

function contentOf(file: PackageFile | undefined): string {
  if (file === undefined) return "";
  return typeof file.content === "string"
    ? file.content
    : file.content.toString("utf-8");
}

function writeUnder(
  root: string,
  relativePath: string,
  content: string,
): string {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf-8");
  return absolute;
}

function writeTarget(relativePath: string, content: string): string {
  return writeUnder(homeRoot, relativePath, content);
}

/** The literal home base: `<os.homedir()>/.haruyuki`. */
function literalBase(): string {
  return join(homedirRoot, ".haruyuki");
}

async function importPackage(
  packagePath: string,
  extra: Partial<ImportOptions> = {},
) {
  return runImport({ from: packagePath, deps: deps(), ...extra });
}

// ── success path ───────────────────────────────────────────────────

test("restores a valid package and fills the report contract", async () => {
  const dirs = ["home", "home/usage", "local-backend", "local-backend/agents"];
  const files: PackageFile[] = [
    {
      path: "home/settings.json",
      content: settingsJson({ recentModels: ["model-a"] }),
    },
    { path: "home/sessions.jsonl", content: '{"project":"new"}\n' },
    { path: "home/usage/ledger.jsonl", content: '{"tokens":3}\n' },
    {
      path: "local-backend/agents/agent1.json",
      content: settingsJson({ id: "agent-1", name: "Agent One" }),
    },
  ];
  const packagePath = await writePackage("valid.hryk", { dirs, files });
  writeTarget("sessions.jsonl", '{"project":"old"}\n');

  let confirmCalls = 0;
  const report = await importPackage(packagePath, {
    yes: true,
    verbose: true,
    requireConfirm: async () => {
      confirmCalls += 1;
      return true;
    },
  });

  expect(report.ok).toBe(true);
  expect(report.code).toBe("ok");
  expect(report.command).toBe("import");
  expect(report.dryRun).toBe(false);
  expect(report.package).toBe(packagePath);
  expect(report.counts.files).toBe(dirs.length + files.length + 1);
  expect(report.counts.bytes).toBeGreaterThan(0);
  expect(report.byScope?.home?.files).toBe(5);
  expect(report.excluded).toHaveLength(22);
  expect(report.remapped).toEqual([]);
  expect(report.failedSecrets).toEqual([]);
  expect(report.migrations).toEqual([]);
  expect(report.entries?.length).toBe(report.counts.files);
  // --yes skips the confirmation callback entirely.
  expect(confirmCalls).toBe(0);
  // A first import has no previous backup to size; the estimate says so.
  expect(report.warnings.join("\n")).toContain(
    "cannot estimate the backup size",
  );

  const backupPath = report.backupPath;
  expect(backupPath).toBe(join(homeRoot, "backups", BACKUP_NAME));
  if (backupPath) expect(existsSync(backupPath)).toBe(true);

  expect(readFileSync(join(homeRoot, "settings.json"), "utf-8")).toBe(
    contentOf(files[0]),
  );
  expect(readFileSync(join(homeRoot, "usage", "ledger.jsonl"), "utf-8")).toBe(
    contentOf(files[2]),
  );
  expect(readFileSync(join(storageDir, "agents", "agent1.json"), "utf-8")).toBe(
    contentOf(files[3]),
  );
  expect(readFileSync(join(homeRoot, "sessions.jsonl"), "utf-8")).toBe(
    '{"project":"new"}\n',
  );
});

test("skips the backup and says so when the target holds no managed data", async () => {
  const packagePath = await writePackage("fresh.hryk", {
    dirs: ["home"],
    files: [{ path: "home/sessions.jsonl", content: "one\n" }],
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(true);
  expect(report.backupPath).toBeUndefined();
  expect(
    report.warnings.some((warning) => warning.includes("no pre-import backup")),
  ).toBe(true);
});

// ── refusals before anything is written ────────────────────────────

test("a tampered SHA-256 fails verification and writes nothing", async () => {
  const packagePath = await writePackage("tampered.hryk", {
    dirs: ["home"],
    files: [{ path: "home/settings.json", content: settingsJson({}) }],
    tamperSha: "home/settings.json",
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(false);
  expect(report.code).toBe("verify_failed");
  expect(report.message).toContain("home/settings.json");
  expect(report.message).toContain("mismatch");
  // Not one file, directory or backup was created.
  expect(existsSync(homeRoot)).toBe(false);
  expect(existsSync(storageDir)).toBe(false);
  expect(existsSync(join(homeRoot, "backups"))).toBe(false);
});

test("a package with a missing or misplaced manifest is rejected", async () => {
  const missing = await writePackage("no-manifest.hryk", {
    dirs: ["home"],
    files: [{ path: "home/sessions.jsonl", content: "one\n" }],
    omitManifest: true,
  });
  const misplaced = await writePackage("late-manifest.hryk", {
    dirs: ["home"],
    files: [{ path: "home/sessions.jsonl", content: "one\n" }],
    trailingEntry: { path: "home/extra.json", content: "{}\n" },
  });

  const missingReport = await importPackage(missing, { yes: true });
  expect(missingReport.code).toBe("verify_failed");
  expect(missingReport.message).toContain("reading manifest.json failed");
  expect(missingReport.message).toContain("manifest.json is missing");

  const misplacedReport = await importPackage(misplaced, { yes: true });
  expect(misplacedReport.code).toBe("verify_failed");
  expect(misplacedReport.message).toContain("not the last entry");

  // Neither attempt wrote anything.
  expect(existsSync(homeRoot)).toBe(false);
});

test("a schemaVersion above the program is refused", async () => {
  const packagePath = await writePackage("future.hryk", {
    dirs: ["home"],
    files: [{ path: "home/sessions.jsonl", content: "one\n" }],
    schemaVersion: 2,
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(false);
  expect(report.code).toBe("version_unsupported");
  expect(report.message).toContain("schemaVersion 2");
  expect(report.message).toContain("supports 1");
  expect(existsSync(homeRoot)).toBe(false);
});

test("--verify validates only: no writes, no backup, no confirmation", async () => {
  const packagePath = await writePackage("verify.hryk", {
    dirs: ["home", "home/skills", "home/skills/new"],
    files: [
      { path: "home/settings.json", content: settingsJson({ a: 1 }) },
      { path: "home/skills/new/SKILL.md", content: "# new\n" },
    ],
  });
  const existing = writeTarget("settings.json", settingsJson({ keep: true }));

  const report = await importPackage(packagePath, {
    verify: true,
    requireConfirm: async () => {
      throw new Error("--verify must never ask for confirmation");
    },
  });

  expect(report.ok).toBe(true);
  expect(report.code).toBe("ok");
  expect(report.message).toContain("Nothing was written");
  expect(report.counts.files).toBeGreaterThan(0);
  expect(report.byScope?.home?.files).toBeGreaterThan(0);
  expect(report.backupPath).toBeUndefined();
  expect(report.entries).toBeUndefined();
  expect(report.remapped).toEqual([]);
  expect(report.failedSecrets).toEqual([]);

  expect(readFileSync(existing, "utf-8")).toBe(settingsJson({ keep: true }));
  expect(existsSync(join(homeRoot, "skills"))).toBe(false);
  expect(existsSync(join(homeRoot, "backups"))).toBe(false);
});

test("a refused confirmation changes nothing", async () => {
  const packagePath = await writePackage("refused.hryk", {
    dirs: ["home"],
    files: [{ path: "home/settings.json", content: settingsJson({ new: 1 }) }],
  });
  const existing = writeTarget("settings.json", settingsJson({ old: 1 }));

  const report = await importPackage(packagePath, {
    requireConfirm: async () => false,
  });

  expect(report.ok).toBe(false);
  expect(report.code).toBe("confirm_required");
  expect(readFileSync(existing, "utf-8")).toBe(settingsJson({ old: 1 }));
  expect(existsSync(join(homeRoot, "backups"))).toBe(false);
});

// ── disk space preflight ──────────────────────────────────────────

test("refuses before confirmation when the target volume is too small", async () => {
  __setFreeSpaceProbeForTests(async () => 1024);
  const packagePath = await writePackage("space.hryk", {
    dirs: ["home"],
    files: [{ path: "home/sessions.jsonl", content: "x".repeat(4096) }],
  });

  let confirmCalls = 0;
  const report = await importPackage(packagePath, {
    requireConfirm: async () => {
      confirmCalls += 1;
      return true;
    },
  });

  expect(report.ok).toBe(false);
  expect(report.code).toBe("insufficient_space");
  expect(report.message).toContain("not enough free space");
  expect(report.message).toContain("needs about");
  expect(confirmCalls).toBe(0);
  // Nothing was created: the check runs before the backup and the clear.
  expect(existsSync(homeRoot)).toBe(false);
  expect(existsSync(join(homeRoot, "backups"))).toBe(false);

  // --verify writes nothing, so it never runs the write-side disk check.
  const verified = await importPackage(packagePath, { verify: true });
  expect(verified.ok).toBe(true);
});

test("continues with a warning when free space cannot be determined", async () => {
  __setFreeSpaceProbeForTests(async () => undefined);
  const packagePath = await writePackage("unknown-space.hryk", {
    dirs: ["home"],
    files: [{ path: "home/sessions.jsonl", content: "one\n" }],
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(true);
  expect(
    report.warnings.some((warning) =>
      warning.includes("cannot determine the free space"),
    ),
  ).toBe(true);
  expect(readFileSync(join(homeRoot, "sessions.jsonl"), "utf-8")).toBe("one\n");
});

// ── snapshot semantics ────────────────────────────────────────────

test("managed files outside the package are removed, excluded ones are kept", async () => {
  writeTarget("skills/old/SKILL.md", "# old\n");
  writeTarget("runs/old/run.log", "log\n");
  writeTarget("logs/keep.log", "keep\n");
  writeTarget("backups/keep.hryk", "keep\n");
  writeTarget("projects/some/agent-tools/out.txt", "keep\n");

  const packagePath = await writePackage("snapshot.hryk", {
    dirs: ["home", "home/skills", "home/skills/new"],
    files: [
      { path: "home/skills/new/SKILL.md", content: "# new\n" },
      { path: "home/sessions.jsonl", content: "one\n" },
    ],
  });

  const report = await importPackage(packagePath, { yes: true });
  expect(report.ok).toBe(true);

  expect(existsSync(join(homeRoot, "skills", "old"))).toBe(false);
  expect(existsSync(join(homeRoot, "runs"))).toBe(false);
  expect(existsSync(join(homeRoot, "skills", "new", "SKILL.md"))).toBe(true);
  // Excluded trees are never touched by the clear.
  expect(existsSync(join(homeRoot, "logs", "keep.log"))).toBe(true);
  expect(existsSync(join(homeRoot, "backups", "keep.hryk"))).toBe(true);
  expect(
    existsSync(join(homeRoot, "projects", "some", "agent-tools", "out.txt")),
  ).toBe(true);
});

// ── literal home root (channels / transcripts) ────────────────────

test("channels and transcripts land in the literal home root, not HARUYUKI_HOME", async () => {
  cleanLiteralHome = true;
  const base = literalBase();
  writeUnder(base, "channels/stale.json", "{}\n");
  writeUnder(base, "transcripts/old.jsonl", "old\n");
  writeUnder(base, "logs/keep.log", "keep\n");
  writeUnder(base, "cache/keep.bin", "keep\n");
  // A stray channels/ tree under the app home root is not managed by this import.
  writeUnder(homeRoot, "channels/app-home-stale.json", "{}\n");
  writeUnder(homeRoot, "logs/keep.log", "keep\n");

  const accounts = settingsJson({ accounts: [] });
  const packagePath = await writePackage("literal-home.hryk", {
    dirs: [
      "home",
      "home/channels",
      "home/channels/slack",
      "home/transcripts",
      "home/transcripts/background",
    ],
    files: [
      { path: "home/settings.json", content: settingsJson({ marker: "app" }) },
      { path: "home/sessions.jsonl", content: "app\n" },
      { path: "home/channels/slack/accounts.json", content: accounts },
      {
        path: "home/transcripts/background/t1.jsonl",
        content: '{"line":1}\n',
      },
    ],
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(true);
  expect(report.warnings.join("\n")).toContain("literal home root");

  // channels/ and transcripts/ follow the literal base.
  expect(
    readFileSync(join(base, "channels", "slack", "accounts.json"), "utf-8"),
  ).toBe(accounts);
  expect(
    readFileSync(join(base, "transcripts", "background", "t1.jsonl"), "utf-8"),
  ).toBe('{"line":1}\n');
  // Managed stale files under the literal base are cleared; excluded ones stay.
  expect(existsSync(join(base, "channels", "stale.json"))).toBe(false);
  expect(existsSync(join(base, "transcripts", "old.jsonl"))).toBe(false);
  expect(existsSync(join(base, "logs", "keep.log"))).toBe(true);
  expect(existsSync(join(base, "cache", "keep.bin"))).toBe(true);

  // The rest of home/ follows HARUYUKI_HOME.
  expect(readFileSync(join(homeRoot, "settings.json"), "utf-8")).toBe(
    settingsJson({ marker: "app" }),
  );
  expect(readFileSync(join(homeRoot, "sessions.jsonl"), "utf-8")).toBe("app\n");
  expect(existsSync(join(homeRoot, "channels", "slack"))).toBe(false);
  expect(existsSync(join(homeRoot, "channels", "app-home-stale.json"))).toBe(
    true,
  );
  expect(existsSync(join(homeRoot, "logs", "keep.log"))).toBe(true);
});

test("one home base clears and places channels in a single pass", async () => {
  cleanLiteralHome = true;
  // Point the app home root at the literal base itself: the two families meet.
  homeRoot = literalBase();
  process.env.HARUYUKI_HOME = homeRoot;

  writeTarget("channels/stale.json", "{}\n");
  writeTarget("channels/slack/old.json", "{}\n");
  writeTarget("transcripts/old.jsonl", "old\n");
  writeTarget("logs/keep.log", "keep\n");

  const accounts = settingsJson({ accounts: [] });
  const packagePath = await writePackage("same-home.hryk", {
    dirs: ["home", "home/channels", "home/channels/slack"],
    files: [
      { path: "home/sessions.jsonl", content: "app\n" },
      { path: "home/channels/slack/accounts.json", content: accounts },
    ],
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(true);
  expect(
    report.warnings.some((warning) => warning.includes("literal home root")),
  ).toBe(false);
  expect(
    readFileSync(join(homeRoot, "channels", "slack", "accounts.json"), "utf-8"),
  ).toBe(accounts);
  expect(existsSync(join(homeRoot, "channels", "stale.json"))).toBe(false);
  expect(existsSync(join(homeRoot, "channels", "slack", "old.json"))).toBe(
    false,
  );
  expect(existsSync(join(homeRoot, "transcripts", "old.jsonl"))).toBe(false);
  expect(existsSync(join(homeRoot, "logs", "keep.log"))).toBe(true);
});

// ── path remapping ────────────────────────────────────────────────

test("remaps the local sessions bucket when the storage root moved", async () => {
  const oldStore = workspace.resolve("old-store");
  const packaged = {
    sessionsByServer: {
      [`local:${oldStore}`]: { agentId: "agent-1", conversationId: "c1" },
    },
  };
  const packagePath = await writePackage("remap.hryk", {
    dirs: ["home"],
    files: [{ path: "home/settings.json", content: settingsJson(packaged) }],
    roots: { home: workspace.resolve("old-home"), localBackend: oldStore },
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(true);
  expect(report.remapped).toHaveLength(1);
  expect(report.remapped[0]?.from).toBe(`local:${oldStore}`);
  expect(report.remapped[0]?.to).toBe(`local:${resolve(storageDir)}`);

  const settings = JSON.parse(
    readFileSync(join(homeRoot, "settings.json"), "utf-8"),
  ) as { sessionsByServer: Record<string, unknown> };
  expect(settings.sessionsByServer[`local:${oldStore}`]).toBeUndefined();
  expect(settings.sessionsByServer[`local:${resolve(storageDir)}`]).toEqual({
    agentId: "agent-1",
    conversationId: "c1",
  });
});

test("does not remap when the storage root did not move", async () => {
  const bucket = `local:${resolve(storageDir)}`;
  const packaged = { sessionsByServer: { [bucket]: { agentId: "agent-1" } } };
  const content = settingsJson(packaged);
  const packagePath = await writePackage("same-root.hryk", {
    dirs: ["home"],
    files: [{ path: "home/settings.json", content }],
    roots: { home: homeRoot, localBackend: storageDir },
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(true);
  expect(report.remapped).toEqual([]);
  expect(readFileSync(join(homeRoot, "settings.json"), "utf-8")).toBe(content);
});

// ── credentials ───────────────────────────────────────────────────

test("a failed secret write is reported but does not fail the import", async () => {
  __setSnapshotSecretsIoForTests({
    isKeychainAvailable: async () => true,
    getSecureTokens: async () => ({}),
    setSecureTokens: async () => {
      throw new Error("keychain denied");
    },
  });
  const bundle: SecretBundle = {
    version: 1,
    settings: { "letta-api-key": "sk-test-value" },
    agents: {},
    channels: {},
    meta: { channelStoreMode: "keyring", capturedAt: CLOCK.toISOString() },
  };
  const packagePath = await writePackage("secrets.hryk", {
    dirs: ["home"],
    files: [{ path: "home/sessions.jsonl", content: "one\n" }],
    secrets: bundle,
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(true);
  expect(report.code).toBe("ok");
  expect(report.failedSecrets).toHaveLength(1);
  expect(report.failedSecrets[0]?.scope).toBe("settings");
  expect(report.failedSecrets[0]?.name).toBe("letta-api-key");
  expect(JSON.stringify(report)).not.toContain("sk-test-value");
});

// ── rollback ──────────────────────────────────────────────────────

function rollbackFixture(): {
  settings: string;
  sessions: string;
  beforeSettings: string;
  beforeSessions: string;
} {
  const beforeSettings = settingsJson({ sessionsByServer: {} });
  const beforeSessions = '{"project":"before"}\n';
  return {
    settings: writeTarget("settings.json", beforeSettings),
    sessions: writeTarget("sessions.jsonl", beforeSessions),
    beforeSettings,
    beforeSessions,
  };
}

async function rollbackPackage(): Promise<string> {
  return writePackage("rollback.hryk", {
    dirs: ["home", "home/skills", "home/skills/new"],
    files: [
      { path: "home/settings.json", content: settingsJson({ fresh: true }) },
      { path: "home/sessions.jsonl", content: '{"project":"after"}\n' },
      { path: "home/skills/new/SKILL.md", content: "# new\n" },
    ],
  });
}

test("restores the pre-import backup when a later step fails", async () => {
  const target = rollbackFixture();
  const packagePath = await rollbackPackage();
  __setImportFaultForTests((point) => {
    if (point === "after-place") {
      throw snapshotError("io_error", "injected landing failure");
    }
  });

  const report = await importPackage(packagePath, { yes: true });

  expect(report.ok).toBe(false);
  expect(report.message).toContain("injected landing failure");
  expect(report.rollback?.attempted).toBe(true);
  expect(report.rollback?.ok).toBe(true);
  expect(report.rollback?.backupPath).toBe(
    join(homeRoot, "backups", BACKUP_NAME),
  );

  expect(readFileSync(target.settings, "utf-8")).toBe(target.beforeSettings);
  expect(readFileSync(target.sessions, "utf-8")).toBe(target.beforeSessions);
  expect(existsSync(join(homeRoot, "skills", "new", "SKILL.md"))).toBe(false);
  const backupPath = report.backupPath;
  expect(backupPath).toBe(join(homeRoot, "backups", BACKUP_NAME));
  if (backupPath) expect(existsSync(backupPath)).toBe(true);
});

test("reports rollback_failed and keeps the backup when the restore also fails", async () => {
  const target = rollbackFixture();
  const packagePath = await rollbackPackage();
  __setImportFaultForTests((point) => {
    if (point === "after-place") {
      throw snapshotError("io_error", "injected landing failure");
    }
    if (point === "during-restore") {
      throw snapshotError("io_error", "injected restore failure");
    }
  });

  const report = await importPackage(packagePath, { yes: true });
  const backupPath = join(homeRoot, "backups", BACKUP_NAME);

  expect(report.ok).toBe(false);
  expect(report.code).toBe("rollback_failed");
  expect(report.rollback?.attempted).toBe(true);
  expect(report.rollback?.ok).toBe(false);
  expect(report.rollback?.backupPath).toBe(backupPath);
  expect(report.message).toContain(backupPath);
  expect(report.message).toContain(
    `haruyuki import --from "${backupPath}" --yes`,
  );
  // The backup is kept, and the half state is what the failed import placed.
  expect(existsSync(backupPath)).toBe(true);
  expect(readFileSync(target.sessions, "utf-8")).toBe('{"project":"after"}\n');
});

// ── the backup is itself a package ────────────────────────────────

test("the pre-import backup can be imported again", async () => {
  writeTarget("settings.json", settingsJson({ marker: "old" }));
  writeTarget("sessions.jsonl", '{"project":"old"}\n');
  const packagePath = await writePackage("round-trip.hryk", {
    dirs: ["home"],
    files: [
      { path: "home/settings.json", content: settingsJson({ marker: "new" }) },
      { path: "home/sessions.jsonl", content: '{"project":"new"}\n' },
    ],
  });

  const first = await importPackage(packagePath, { yes: true });
  expect(first.ok).toBe(true);
  const backupPath = first.backupPath;
  expect(backupPath).toBeDefined();
  if (!backupPath) return;
  expect(readFileSync(join(homeRoot, "settings.json"), "utf-8")).toBe(
    settingsJson({ marker: "new" }),
  );

  const second = await importPackage(backupPath, { yes: true });
  expect(second.ok).toBe(true);
  expect(second.backupPath).toBeUndefined();
  expect(
    second.warnings.some((warning) =>
      warning.includes("no second backup was written"),
    ),
  ).toBe(true);
  expect(readFileSync(join(homeRoot, "settings.json"), "utf-8")).toBe(
    settingsJson({ marker: "old" }),
  );
  expect(readFileSync(join(homeRoot, "sessions.jsonl"), "utf-8")).toBe(
    '{"project":"old"}\n',
  );
});

// ── project data (narrow §5.3 C scope) ────────────────────────────

test("project data is skipped with a warning unless --with-project is given", async () => {
  const projectTarget = workspace.resolve("project-target");
  const packagePath = await writePackage("project.hryk", {
    dirs: ["home", "project/.haruyuki"],
    files: [
      { path: "home/sessions.jsonl", content: "one\n" },
      { path: "project/.haruyuki/settings.json", content: settingsJson({}) },
    ],
    roots: {
      home: homeRoot,
      localBackend: storageDir,
      project: workspace.resolve("old-project"),
    },
  });

  const skipped = await importPackage(packagePath, { yes: true });
  expect(skipped.ok).toBe(true);
  expect(
    skipped.warnings.some((warning) =>
      warning.includes("--with-project was not given"),
    ),
  ).toBe(true);
  expect(existsSync(join(projectTarget, ".haruyuki"))).toBe(false);

  const restored = await importPackage(packagePath, {
    yes: true,
    withProject: projectTarget,
  });
  expect(restored.ok).toBe(true);
  expect(
    readFileSync(join(projectTarget, ".haruyuki", "settings.json"), "utf-8"),
  ).toBe(settingsJson({}));
});

test("a project restore only touches the narrow project scope", async () => {
  const projectTarget = workspace.resolve("project-target");
  writeUnder(projectTarget, "src/index.ts", "export const a = 1;\n");
  writeUnder(projectTarget, ".env", "SECRET=1\n");
  writeUnder(
    projectTarget,
    ".haruyuki/settings.json",
    settingsJson({ old: 1 }),
  );
  writeUnder(projectTarget, ".haruyuki/extra.json", settingsJson({ keep: 1 }));
  writeUnder(projectTarget, ".commands/old.md", "# old command\n");
  writeUnder(projectTarget, ".git/config", "[core]\n");
  writeUnder(projectTarget, "node_modules/dep/index.js", "module.exports={}\n");
  writeUnder(projectTarget, ".haruyuki/worktrees/wt/file.txt", "keep\n");

  const narrowed = settingsJson({ fromPackage: true });
  const packagePath = await writePackage("project-narrow.hryk", {
    dirs: ["home", "project/.haruyuki"],
    files: [
      { path: "home/sessions.jsonl", content: "one\n" },
      { path: "project/.haruyuki/settings.json", content: narrowed },
    ],
    roots: {
      home: homeRoot,
      localBackend: storageDir,
      project: workspace.resolve("old-project"),
    },
  });

  const report = await importPackage(packagePath, {
    yes: true,
    withProject: projectTarget,
  });
  expect(report.ok).toBe(true);

  // The six §5.3 C rows: settings is overwritten, stale commands are cleared.
  expect(
    readFileSync(join(projectTarget, ".haruyuki", "settings.json"), "utf-8"),
  ).toBe(narrowed);
  expect(existsSync(join(projectTarget, ".commands", "old.md"))).toBe(false);
  // Everything outside the narrow scope survives, including .git and .env.
  expect(readFileSync(join(projectTarget, "src", "index.ts"), "utf-8")).toBe(
    "export const a = 1;\n",
  );
  expect(readFileSync(join(projectTarget, ".env"), "utf-8")).toBe("SECRET=1\n");
  expect(
    readFileSync(join(projectTarget, ".haruyuki", "extra.json"), "utf-8"),
  ).toBe(settingsJson({ keep: 1 }));
  expect(readFileSync(join(projectTarget, ".git", "config"), "utf-8")).toBe(
    "[core]\n",
  );
  expect(
    existsSync(join(projectTarget, "node_modules", "dep", "index.js")),
  ).toBe(true);
  expect(
    existsSync(join(projectTarget, ".haruyuki", "worktrees", "wt", "file.txt")),
  ).toBe(true);
});

// ── packages stored inside the data they restore ──────────────────

test("a package stored under a managed tree survives its own import", async () => {
  const built = await writePackage("self.hryk", {
    dirs: ["home"],
    files: [{ path: "home/sessions.jsonl", content: "one\n" }],
  });
  mkdirSync(join(homeRoot, "usage"), { recursive: true });
  const selfPath = join(homeRoot, "usage", "self.hryk");
  copyFileSync(built, selfPath);
  writeTarget("usage/ledger.jsonl", "old\n");

  const report = await importPackage(selfPath, { yes: true });

  expect(report.ok).toBe(true);
  expect(existsSync(selfPath)).toBe(true);
  // The rest of the managed tree is still cleared around it.
  expect(existsSync(join(homeRoot, "usage", "ledger.jsonl"))).toBe(false);
});
