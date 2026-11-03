/**
 * Tests for A5's boundary hardening (`embedding-boundary-recovery.ts`).
 *
 * Every case uses a fresh temp space directory, fake clock/host/pids and
 * injected liveness/start-time probes; no real child is spawned, signalled or
 * killed (48-2 §3.1 A5, §9.2 S-02). Preview and removal are asserted as two
 * phases, and the "never touch a live owner" rule is pinned for a same-host
 * live pid, a reused pid and a foreign-host record whose pid cannot be probed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEmptyEmbeddingBuildState,
  type EmbeddingBuildStateRecord,
  embeddingBuildStatePath,
  readEmbeddingBuildState,
  writeEmbeddingBuildState,
} from "@/backend/local/embedding-build-state";
import { EMBEDDING_LEASE_FILE_NAME } from "@/backend/local/embedding-lease";
import {
  acquireEmbeddingBuildLock,
  EMBEDDING_BUILD_LOCK_FILE_NAME,
  embeddingBuildLockPath,
} from "@/backend/local/embedding-lock";
import {
  applyEmbeddingBoundaryRecovery,
  classifyEmbeddingRecoveryFsError,
  EMBEDDING_RECOVERY_MIN_RESIDUE_AGE_MS,
  type EmbeddingBoundaryRecoveryOptions,
  type EmbeddingRecoveryPreview,
  previewEmbeddingBoundaryRecovery,
  recoverEmbeddingBoundary,
  withEmbeddingRecoveryRetry,
} from "@/cli/helpers/embedding-boundary-recovery";

const AGENT = "agent-a5-recovery";
const SPACE = "space-a5-recovery";
const HOST = "host-a5";
const NOW = 1_700_000_000_000;
const DEAD_PID = 424242;
const LIVE_PID = 515151;

const roots: string[] = [];

function freshSpaceDir(): string {
  const root = mkdtempSync(join(tmpdir(), "hryk-a5-recovery-"));
  roots.push(root);
  const spaceDir = join(root, AGENT, SPACE);
  mkdirSync(spaceDir, { recursive: true });
  return spaceDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function stateRecord(
  patch: Partial<EmbeddingBuildStateRecord> = {},
): EmbeddingBuildStateRecord {
  return {
    ...createEmptyEmbeddingBuildState(
      { agentId: AGENT, spaceId: SPACE },
      { clock: () => NOW },
    ),
    ...patch,
  };
}

async function writeRunningState(spaceDir: string): Promise<void> {
  const statePath = embeddingBuildStatePath(spaceDir);
  mkdirSync(join(statePath, ".."), { recursive: true });
  await writeEmbeddingBuildState(
    statePath,
    stateRecord({
      phase: "running",
      progress: {
        embeddedChunks: 10,
        totalChunks: 100,
        processedConversations: 1,
        totalConversations: 4,
      },
      startedAt: NOW - 5_000,
      updatedAt: NOW,
    }),
  );
}

interface LockFixture {
  pid?: number;
  host?: string;
  token?: string;
  heartbeatAt?: number;
}

function writeLock(spaceDir: string, fixture: LockFixture = {}): void {
  writeFileSync(
    join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME),
    JSON.stringify({
      schemaVersion: 1,
      agentId: AGENT,
      spaceId: SPACE,
      pid: fixture.pid ?? DEAD_PID,
      host: fixture.host ?? HOST,
      token: fixture.token ?? "lock-token",
      acquiredAt: NOW - 1_000,
      heartbeatAt: fixture.heartbeatAt ?? NOW,
    }),
  );
}

function writeLease(spaceDir: string, fixture: LockFixture = {}): void {
  writeFileSync(
    join(spaceDir, EMBEDDING_LEASE_FILE_NAME),
    JSON.stringify({
      schemaVersion: 1,
      agentId: AGENT,
      spaceId: SPACE,
      token: fixture.token ?? "lock-token",
      pid: fixture.pid ?? DEAD_PID,
      host: fixture.host ?? HOST,
      ttlMs: 120_000,
      createdAt: NOW - 1_000,
      heartbeatAt: fixture.heartbeatAt ?? NOW,
      expiresAt: (fixture.heartbeatAt ?? NOW) + 120_000,
    }),
  );
}

interface OptionsFixture {
  isPidAlive?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => Promise<string | null>;
  detachedPid?: number | null;
  detachedStartedAt?: string | null;
  host?: string;
  pid?: number;
  removePath?: (path: string, type: "file" | "directory") => Promise<void>;
  minResidueAgeMs?: number;
  maxEntries?: number;
}

function recoveryOptions(
  spaceDir: string,
  fixture: OptionsFixture = {},
): EmbeddingBoundaryRecoveryOptions {
  return {
    spaceDir,
    agentId: AGENT,
    spaceId: SPACE,
    clock: () => NOW,
    host: fixture.host ?? HOST,
    pid: fixture.pid ?? 9_999,
    detachedPid: fixture.detachedPid ?? null,
    detachedStartedAt: fixture.detachedStartedAt ?? null,
    isPidAlive: fixture.isPidAlive ?? (() => false),
    getProcessStartTime: fixture.getProcessStartTime ?? (async () => null),
    sleep: async () => undefined,
    removePath: fixture.removePath,
    minResidueAgeMs: fixture.minResidueAgeMs,
    maxEntries: fixture.maxEntries,
  };
}

/** One B2 unit directory with a real generation plus staging leftovers. */
function writeUnitResidues(spaceDir: string): {
  unitDir: string;
  stagingDir: string;
  pointerTemp: string;
  keepFile: string;
  generationDir: string;
} {
  const unitDir = join(spaceDir, "conv-1");
  const generationDir = join(unitDir, "gen-1");
  const stagingDir = join(unitDir, ".tmp-deadbeef");
  mkdirSync(generationDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(generationDir, "meta.json"), "{}\n");
  const keepFile = join(unitDir, "keep.txt");
  writeFileSync(keepFile, "user file\n");
  const pointerTemp = join(unitDir, ".current-deadbeef");
  writeFileSync(pointerTemp, "{}\n");
  return { unitDir, stagingDir, pointerTemp, keepFile, generationDir };
}

describe("withEmbeddingRecoveryRetry · antivirus lock policy", () => {
  test("retries a retryable error exactly once, then succeeds", async () => {
    let attempts = 0;
    const result = await withEmbeddingRecoveryRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("locked"), { code: "EPERM" });
        }
        return "done";
      },
      { sleep: async () => undefined },
    );
    expect(result).toEqual({ ok: true, value: "done", attempts: 2 });
    expect(attempts).toBe(2);
  });

  test("reports an actionable failure after the single retry", async () => {
    let attempts = 0;
    const result = await withEmbeddingRecoveryRetry(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
      { sleep: async () => undefined },
    );
    expect(attempts).toBe(2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatchObject({ code: "EBUSY", retryable: true });
    expect(result.error.action).toContain("Nothing was force-deleted");
    expect(classifyEmbeddingRecoveryFsError(new Error("x")).retryable).toBe(
      false,
    );
  });
});

describe("previewEmbeddingBoundaryRecovery · ownership verdicts", () => {
  test("a live same-host builder blocks every change", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    writeLock(spaceDir, { pid: LIVE_PID });
    writeLease(spaceDir, { pid: LIVE_PID });
    const residues = writeUnitResidues(spaceDir);

    const options = recoveryOptions(spaceDir, {
      isPidAlive: (pid) => pid === LIVE_PID,
    });
    const preview = await previewEmbeddingBoundaryRecovery(options);
    expect(preview.verdict.kind).toBe("live_owner");
    expect(preview.items).toEqual([]);
    expect(preview.state.nextPhase).toBeNull();
    expect(preview.skipped.length).toBeGreaterThan(0);

    const report = await applyEmbeddingBoundaryRecovery(preview, options);
    expect(report.removed).toEqual([]);
    expect(report.markedInterrupted).toBe(false);
    expect(existsSync(residues.stagingDir)).toBe(true);
    expect(existsSync(join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME))).toBe(
      true,
    );
    const state = await readEmbeddingBuildState(
      embeddingBuildStatePath(spaceDir),
      {
        agentId: AGENT,
        spaceId: SPACE,
      },
    );
    expect(state.state.phase).toBe("running");
  });

  test("a dead owner is an orphan: preview lists residues, apply removes and marks interrupted", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    writeLock(spaceDir, { pid: DEAD_PID });
    writeLease(spaceDir, { pid: DEAD_PID });
    const residues = writeUnitResidues(spaceDir);
    const stateTemp = join(
      spaceDir,
      "state.json.424242.11111111-2222-3333-4444-555555555555.tmp",
    );
    writeFileSync(stateTemp, "partial\n");

    const options = recoveryOptions(spaceDir, { isPidAlive: () => false });
    const preview = await previewEmbeddingBoundaryRecovery(options);
    expect(preview.verdict.kind).toBe("orphan");
    const paths = preview.items.map((item) => item.path);
    expect(paths).toContain(residues.stagingDir);
    expect(paths).toContain(residues.pointerTemp);
    expect(paths).toContain(stateTemp);
    expect(paths).toContain(join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME));
    expect(paths).toContain(join(spaceDir, EMBEDDING_LEASE_FILE_NAME));
    expect(preview.state.nextPhase).toBe("cancelled");

    // Preview is read-only: the files are still there.
    expect(existsSync(residues.stagingDir)).toBe(true);
    expect(existsSync(stateTemp)).toBe(true);

    const report = await applyEmbeddingBoundaryRecovery(preview, options);
    expect(report.removed).toContain(residues.stagingDir);
    expect(report.failures).toEqual([]);
    expect(report.markedInterrupted).toBe(true);
    expect(existsSync(residues.stagingDir)).toBe(false);
    expect(existsSync(residues.pointerTemp)).toBe(false);
    expect(existsSync(stateTemp)).toBe(false);
    expect(existsSync(join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME))).toBe(
      false,
    );
    // User files and committed generations are never touched.
    expect(existsSync(residues.keepFile)).toBe(true);
    expect(existsSync(join(residues.generationDir, "meta.json"))).toBe(true);
    const state = await readEmbeddingBuildState(
      embeddingBuildStatePath(spaceDir),
      {
        agentId: AGENT,
        spaceId: SPACE,
      },
    );
    expect(state.state.phase).toBe("cancelled");
  });

  test("a reused pid is an orphan, and the new process is never signalled", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    const probed: number[] = [];
    const options = recoveryOptions(spaceDir, {
      detachedPid: DEAD_PID,
      detachedStartedAt: "start-token-original",
      isPidAlive: (pid) => pid === DEAD_PID,
      getProcessStartTime: async (pid) => {
        probed.push(pid);
        return "start-token-someone-else";
      },
    });
    const preview = await previewEmbeddingBoundaryRecovery(options);
    expect(preview.verdict.kind).toBe("orphan");
    if (preview.verdict.kind !== "orphan") throw new Error("expected orphan");
    expect(preview.verdict.evidence.join(" ")).toContain("reused");
    expect(probed).toContain(DEAD_PID);

    // Recovery has no kill/signal path at all: it can only clean files.
    const report = await applyEmbeddingBoundaryRecovery(preview, options);
    expect(report.failures).toEqual([]);
    expect(report.markedInterrupted).toBe(true);
  });

  test("a matching start token confirms the detached owner is live", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    const options = recoveryOptions(spaceDir, {
      detachedPid: LIVE_PID,
      detachedStartedAt: "start-token-current",
      isPidAlive: () => true,
      getProcessStartTime: async () => "start-token-current",
    });
    const preview = await previewEmbeddingBoundaryRecovery(options);
    expect(preview.verdict.kind).toBe("live_owner");
    expect(preview.items).toEqual([]);
  });

  test("a foreign-host record with no live witness is an orphan and its pid is not probed", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    writeLock(spaceDir, {
      pid: DEAD_PID,
      host: "other-host",
      heartbeatAt: NOW - 200_000,
    });
    writeLease(spaceDir, {
      pid: DEAD_PID,
      host: "other-host",
      heartbeatAt: NOW - 200_000,
    });
    const probedPids: number[] = [];
    const options = recoveryOptions(spaceDir, {
      isPidAlive: (pid) => {
        probedPids.push(pid);
        return true;
      },
    });
    const preview = await previewEmbeddingBoundaryRecovery(options);
    expect(preview.verdict.kind).toBe("orphan");
    expect(probedPids).not.toContain(DEAD_PID);
    expect(preview.items.map((item) => item.path)).toContain(
      join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME),
    );
  });
});

describe("residue gating and fs retry", () => {
  test("without an owner, only residues older than the stale window are collected", async () => {
    const spaceDir = freshSpaceDir();
    const young = writeUnitResidues(spaceDir);
    await writeEmbeddingBuildState(
      embeddingBuildStatePath(spaceDir),
      stateRecord({ phase: "idle", updatedAt: NOW }),
    );
    const options = recoveryOptions(spaceDir, { minResidueAgeMs: 60_000 });
    const youngPreview = await previewEmbeddingBoundaryRecovery(options);
    expect(youngPreview.verdict.kind).toBe("no_build");
    expect(youngPreview.items).toEqual([]);
    expect(
      youngPreview.skipped.some((entry) => entry.path === young.stagingDir),
    ).toBe(true);

    const old = new Date(NOW - EMBEDDING_RECOVERY_MIN_RESIDUE_AGE_MS * 10);
    utimesSync(young.stagingDir, old, old);
    utimesSync(young.pointerTemp, old, old);
    const oldPreview = await previewEmbeddingBoundaryRecovery(options);
    expect(oldPreview.items.map((item) => item.path)).toContain(
      young.stagingDir,
    );
    expect(oldPreview.items.map((item) => item.path)).toContain(
      young.pointerTemp,
    );
    expect(oldPreview.state.nextPhase).toBeNull();
  });

  test("a temp file whose embedded pid is alive is skipped", async () => {
    const spaceDir = freshSpaceDir();
    const liveTemp = join(
      spaceDir,
      "state.json.515151.11111111-2222-3333-4444-555555555555.tmp",
    );
    writeFileSync(liveTemp, "partial\n");
    const options = recoveryOptions(spaceDir, {
      isPidAlive: (pid) => pid === LIVE_PID,
      minResidueAgeMs: 1,
    });
    const preview = await previewEmbeddingBoundaryRecovery(options);
    expect(preview.items).toEqual([]);
    expect(preview.skipped.some((entry) => entry.path === liveTemp)).toBe(true);
  });

  test("a retryable delete error retries once, succeeds, and does not abort the pass", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    writeLock(spaceDir, { pid: DEAD_PID });
    const residues = writeUnitResidues(spaceDir);
    let stagingAttempts = 0;
    const options = recoveryOptions(spaceDir, {
      isPidAlive: () => false,
      removePath: async (path, type) => {
        if (path === residues.stagingDir) {
          stagingAttempts += 1;
          if (stagingAttempts === 1) {
            throw Object.assign(new Error("locked"), { code: "EPERM" });
          }
        }
        if (type === "directory") {
          rmSync(path, { recursive: true, force: true });
          return;
        }
        rmSync(path, { force: true });
      },
    });
    const preview = await previewEmbeddingBoundaryRecovery(options);
    const report = await applyEmbeddingBoundaryRecovery(preview, options);
    expect(stagingAttempts).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.removed).toContain(residues.stagingDir);
  });

  test("a persistent lock error is reported with the actionable hint", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    writeLock(spaceDir, { pid: DEAD_PID });
    const residues = writeUnitResidues(spaceDir);
    const options = recoveryOptions(spaceDir, {
      isPidAlive: () => false,
      removePath: async (path) => {
        if (path === residues.stagingDir) {
          throw Object.assign(new Error("busy"), { code: "EACCES" });
        }
        rmSync(path, { recursive: true, force: true });
      },
    });
    const preview = await previewEmbeddingBoundaryRecovery(options);
    const report = await applyEmbeddingBoundaryRecovery(preview, options);
    expect(report.failures.length).toBe(1);
    expect(report.failures[0]?.code).toBe("EACCES");
    expect(report.failures[0]?.action).toContain("Nothing was force-deleted");
    expect(report.hints.length).toBeGreaterThan(0);
    expect(existsSync(residues.stagingDir)).toBe(true);
    // The state correction still happens: an orphan is not left `running`.
    expect(report.markedInterrupted).toBe(true);
  });

  test("apply refuses a preview item that escapes the space directory", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    const outside = join(spaceDir, "..", "outside.txt");
    writeFileSync(outside, "keep\n");
    const preview = await previewEmbeddingBoundaryRecovery(
      recoveryOptions(spaceDir, { isPidAlive: () => false }),
    );
    const tampered: EmbeddingRecoveryPreview = {
      ...preview,
      items: [
        ...preview.items,
        {
          kind: "staging_dir",
          path: outside,
          type: "file",
          reason: "tampered",
        },
      ],
    };
    const report = await applyEmbeddingBoundaryRecovery(
      tampered,
      recoveryOptions(spaceDir, { isPidAlive: () => false }),
    );
    expect(report.failures.some((failure) => failure.path === outside)).toBe(
      true,
    );
    expect(existsSync(outside)).toBe(true);
  });

  test("a running state with no owner witness is recovered as an orphan", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    const options = recoveryOptions(spaceDir);
    const preview = await previewEmbeddingBoundaryRecovery(options);
    expect(preview.verdict.kind).toBe("orphan");
    expect(preview.state.nextPhase).toBe("cancelled");
    const report = await recoverEmbeddingBoundary(options);
    expect(report.markedInterrupted).toBe(true);
    const state = await readEmbeddingBuildState(
      embeddingBuildStatePath(spaceDir),
      {
        agentId: AGENT,
        spaceId: SPACE,
      },
    );
    expect(state.state.phase).toBe("cancelled");
  });

  test("a live lock acquired through A2's writer is honoured", async () => {
    const spaceDir = freshSpaceDir();
    await writeRunningState(spaceDir);
    await acquireEmbeddingBuildLock(
      spaceDir,
      { agentId: AGENT, spaceId: SPACE },
      {
        clock: () => NOW,
        pid: LIVE_PID,
        host: HOST,
        token: "real-token",
        isPidAlive: () => true,
      },
    );
    const preview = await previewEmbeddingBoundaryRecovery(
      recoveryOptions(spaceDir, { isPidAlive: (pid) => pid === LIVE_PID }),
    );
    expect(preview.verdict.kind).toBe("live_owner");
    expect(existsSync(embeddingBuildLockPath(spaceDir))).toBe(true);
  });

  test("the entry cap reports a truncated scan instead of walking forever", async () => {
    const spaceDir = freshSpaceDir();
    const residues = writeUnitResidues(spaceDir);
    const preview = await previewEmbeddingBoundaryRecovery(
      recoveryOptions(spaceDir, { maxEntries: 1, minResidueAgeMs: 1 }),
    );
    expect(preview.truncated).toBe(true);
    const report = await applyEmbeddingBoundaryRecovery(
      preview,
      recoveryOptions(spaceDir, { maxEntries: 1, minResidueAgeMs: 1 }),
    );
    expect(report.hints.join(" ")).toContain("entry cap");
    // Nothing outside the scanned prefix was deleted.
    expect(existsSync(residues.keepFile)).toBe(true);
  });
});
