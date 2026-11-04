/**
 * Startup boundary recovery for embedding builds (48-2 §3.1 A5, S-02).
 *
 * The pinned `src/index.ts` start path only calls this with
 * `void ... .catch(...)`, so the tests pin the two properties that make that
 * safe: no space is inspected without an ownership file, and one bad space
 * never aborts the pass. A final case runs A5's real recovery against a stale
 * lock written into a temp space (injected pid liveness; no real child).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { EMBEDDING_LEASE_FILE_NAME } from "@/backend/local/embedding-lease";
import { EMBEDDING_BUILD_LOCK_FILE_NAME } from "@/backend/local/embedding-lock";
import type {
  EmbeddingBoundaryRecoveryOptions,
  EmbeddingRecoveryReport,
} from "@/cli/helpers/embedding-boundary-recovery";
import {
  EMBEDDING_STARTUP_MAX_SPACES,
  recoverEmbeddingBoundariesAtStartup,
} from "@/cli/helpers/embedding-startup";

const AGENT = "agent-startup";
const SPACE = "space-startup";
const NOW = 1_700_000_000_000;
const DEAD_PID = 987_654;

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hryk-embedding-startup-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function makeSpace(root: string, agentId = AGENT, spaceId = SPACE): string {
  const spaceDir = join(root, agentId, spaceId);
  mkdirSync(spaceDir, { recursive: true });
  return spaceDir;
}

function emptyReport(spaceDir: string): EmbeddingRecoveryReport {
  return {
    spaceDir,
    verdict: { kind: "no_build", evidence: [] },
    removed: [],
    failures: [],
    markedInterrupted: false,
    stateSkipped: false,
    hints: [],
  };
}

interface Harness {
  calls: EmbeddingBoundaryRecoveryOptions[];
  deps: {
    recover: (
      options: EmbeddingBoundaryRecoveryOptions,
    ) => Promise<EmbeddingRecoveryReport>;
  };
}

function harness(
  options: { fail?: (spaceDir: string) => Error | undefined } = {},
): Harness {
  const calls: EmbeddingBoundaryRecoveryOptions[] = [];
  return {
    calls,
    deps: {
      recover: async (recoveryOptions) => {
        calls.push(recoveryOptions);
        const failure = options.fail?.(recoveryOptions.spaceDir);
        if (failure !== undefined) throw failure;
        return emptyReport(recoveryOptions.spaceDir);
      },
    },
  };
}

describe("recoverEmbeddingBoundariesAtStartup", () => {
  test("a missing recall root is a no-op", async () => {
    const h = harness();
    expect(
      await recoverEmbeddingBoundariesAtStartup({
        ...h.deps,
        root: join(freshRoot(), "does-not-exist"),
      }),
    ).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("a space without ownership residue is never inspected", async () => {
    const root = freshRoot();
    makeSpace(root);
    const h = harness();
    expect(
      await recoverEmbeddingBoundariesAtStartup({ ...h.deps, root }),
    ).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("a leftover lock, lease or reap marker triggers one recovery pass", async () => {
    const root = freshRoot();
    const locked = makeSpace(root);
    writeFileSync(join(locked, EMBEDDING_BUILD_LOCK_FILE_NAME), "{}");
    const leased = makeSpace(root, AGENT, "space-lease");
    writeFileSync(join(leased, EMBEDDING_LEASE_FILE_NAME), "{}");
    const reaped = makeSpace(root, AGENT, "space-reap");
    writeFileSync(join(reaped, `${EMBEDDING_BUILD_LOCK_FILE_NAME}.reap`), "");

    const h = harness();
    await recoverEmbeddingBoundariesAtStartup({ ...h.deps, root });
    expect(h.calls.map((call) => call.spaceDir).sort()).toEqual(
      [locked, leased, reaped].sort(),
    );
    for (const call of h.calls) {
      expect(call.agentId).toBe(AGENT);
      expect(call.spaceId?.startsWith("space-")).toBe(true);
    }
  });

  test("unsafe directory names are skipped", async () => {
    const root = freshRoot();
    makeSpace(root, "..", "escape");
    makeSpace(root, "bad name", SPACE);
    const good = makeSpace(root);
    writeFileSync(join(good, EMBEDDING_BUILD_LOCK_FILE_NAME), "{}");

    const h = harness();
    await recoverEmbeddingBoundariesAtStartup({ ...h.deps, root });
    expect(h.calls.map((call) => call.spaceDir)).toEqual([good]);
  });

  test("one failing space does not abort the rest", async () => {
    const root = freshRoot();
    const failing = makeSpace(root, AGENT, "space-failing");
    writeFileSync(join(failing, EMBEDDING_BUILD_LOCK_FILE_NAME), "{}");
    const healthy = makeSpace(root, AGENT, "space-healthy");
    writeFileSync(join(healthy, EMBEDDING_BUILD_LOCK_FILE_NAME), "{}");

    const h = harness({
      fail: (spaceDir) =>
        spaceDir === failing
          ? new Error("EPERM: locked by antivirus")
          : undefined,
    });
    await expect(
      recoverEmbeddingBoundariesAtStartup({ ...h.deps, root }),
    ).resolves.toEqual([]);
    expect(h.calls).toHaveLength(2);
  });

  test("only reports that changed something are returned", async () => {
    const root = freshRoot();
    const changed = makeSpace(root);
    writeFileSync(join(changed, EMBEDDING_BUILD_LOCK_FILE_NAME), "{}");
    const unchanged = makeSpace(root, AGENT, "space-unchanged");
    writeFileSync(join(unchanged, EMBEDDING_BUILD_LOCK_FILE_NAME), "{}");

    const reports = await recoverEmbeddingBoundariesAtStartup({
      root,
      recover: async (options) => {
        const report = emptyReport(options.spaceDir);
        return options.spaceDir === changed
          ? {
              ...report,
              removed: [join(changed, EMBEDDING_BUILD_LOCK_FILE_NAME)],
            }
          : report;
      },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.spaceDir).toBe(changed);
  });

  test("the pass is bounded", async () => {
    const root = freshRoot();
    for (let index = 0; index <= EMBEDDING_STARTUP_MAX_SPACES; index += 1) {
      const spaceDir = makeSpace(root, AGENT, `space-${index}`);
      writeFileSync(join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME), "{}");
    }
    const h = harness();
    await recoverEmbeddingBoundariesAtStartup({ ...h.deps, root });
    expect(h.calls).toHaveLength(EMBEDDING_STARTUP_MAX_SPACES);
  });

  test("A5's real recovery removes a provably stale lock and nothing else", async () => {
    const root = freshRoot();
    const spaceDir = makeSpace(root);
    const lockPath = join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME);
    // Same host + a dead pid + an ancient heartbeat is exactly A5's "stale".
    writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        agentId: AGENT,
        spaceId: SPACE,
        pid: DEAD_PID,
        host: hostname(),
        token: "tok-startup-test",
        acquiredAt: NOW - 600_000,
        heartbeatAt: NOW - 600_000,
      }),
    );
    const keeper = join(spaceDir, "keepers", "index.bin");
    mkdirSync(join(spaceDir, "keepers"), { recursive: true });
    writeFileSync(keeper, "not ours to delete");

    const reports = await recoverEmbeddingBoundariesAtStartup({
      root,
      recoveryOptions: { isPidAlive: () => false, clock: () => NOW },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.spaceDir).toBe(spaceDir);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(keeper)).toBe(true);
  });
});
