/**
 * T-01 · the dream run status poller (47-1 R-01.5/R-01.7, 47-2 §1.1 G-1).
 *
 * The repository has no fake-timer precedent, so the hook is driven here the
 * way it is expected to run: short real intervals plus an injected clock and
 * injected lease/liveness readers. The assertions observe the hook's published
 * snapshots through a real Ink mount (the same probe pattern as
 * `use-autocomplete-navigation.test.tsx`) — a hook that stops publishing looks
 * exactly like one that never polled, and this catches the first.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import { useEffect } from "react";
import type { DreamRunLease } from "@/agent/dream/dream-lease";
import type { DreamStatusSnapshot } from "@/cli/display/product-status/dream";
import {
  type DreamRunStatusDepsOverrides,
  useDreamRunStatus,
} from "@/cli/hooks/use-dream-run-status";
import { resetInkTtyState } from "@/test-utils/ink-tty";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;
const root = mkdtempSync(join(tmpdir(), "hryk-w02-dream-status-"));
process.env.HARUYUKI_HOME = root;

afterAll(() => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  resetInkTtyState();
});

const POLL_MS = 15;
const TICK_MS = 5;
const STARTED_AT = 1_700_000_000_000;

class NullOutput extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

function createStdin(): NodeJS.ReadStream {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await tick(5);
  }
  throw new Error("waitFor timed out");
}

function lease(overrides: Partial<DreamRunLease> = {}): DreamRunLease {
  return {
    version: 1,
    agentId: "agent-a",
    runId: "run-1",
    taskId: null,
    pid: process.pid,
    processStartedAt: null,
    processStartTicks: null,
    bootId: null,
    startedAt: STARTED_AT - 60_000,
    heartbeatAt: STARTED_AT,
    status: "running",
    conversationId: "conv-1",
    baselineSha: "sha-1",
    tier: "tidy",
    spentTokens: 504,
    budgetTokens: 1200,
    ...overrides,
  };
}

interface ProbeProps {
  agentId: string | null;
  active: boolean;
  deps: DreamRunStatusDepsOverrides;
  doneLingerMs?: number;
  livenessCacheMs?: number;
  record(snapshot: DreamStatusSnapshot | null): void;
}

function mountProbe(
  initial: Omit<ProbeProps, "record">,
  published: (DreamStatusSnapshot | null)[],
): {
  rerender(next: Omit<ProbeProps, "record">): void;
  stop(): void;
} {
  const record = (snapshot: DreamStatusSnapshot | null): void => {
    published.push(snapshot);
  };

  function Probe(props: ProbeProps) {
    const snapshot = useDreamRunStatus({
      agentId: props.agentId,
      active: props.active,
      pollIntervalMs: POLL_MS,
      elapsedTickMs: TICK_MS,
      livenessCacheMs: props.livenessCacheMs ?? 60_000,
      doneLingerMs: props.doneLingerMs ?? 60_000,
      deps: props.deps,
    });
    useEffect(() => {
      props.record(snapshot);
    }, [snapshot, props.record]);
    return <Text>probe</Text>;
  }

  const stdin = createStdin();
  const instance = render(<Probe {...initial} record={record} />, {
    stdin,
    stdout: new NullOutput() as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    rerender(next: Omit<ProbeProps, "record">) {
      instance.rerender(<Probe {...next} record={record} />);
    },
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

function lastSnapshot(
  published: (DreamStatusSnapshot | null)[],
): DreamStatusSnapshot | undefined {
  return published
    .filter((snapshot): snapshot is DreamStatusSnapshot => snapshot !== null)
    .at(-1);
}

describe("useDreamRunStatus · polling and elapsed time", () => {
  test("publishes a live run and ticks the elapsed time locally", async () => {
    let nowMs = STARTED_AT;
    let leaseReads = 0;
    const deps: DreamRunStatusDepsOverrides = {
      now: () => nowMs,
      readLease: () => {
        leaseReads += 1;
        return lease();
      },
      isLive: () => true,
    };
    const published: (DreamStatusSnapshot | null)[] = [];
    const probe = mountProbe(
      { agentId: "agent-a", active: true, deps },
      published,
    );
    try {
      await waitFor(() => lastSnapshot(published) !== undefined);
      expect(lastSnapshot(published)).toMatchObject({
        agentId: "agent-a",
        runId: "run-1",
        phase: "running",
        tier: "tidy",
        spentTokens: 504,
        budgetTokens: 1200,
      });
      expect(lastSnapshot(published)?.elapsedMs).toBe(60_000);
      await waitFor(() => leaseReads > 1);

      // The lease does not change; only the local clock moves. A local tick
      // must repaint the duration without another cross-process read.
      nowMs += 5_000;
      await waitFor(() => (lastSnapshot(published)?.elapsedMs ?? 0) >= 65_000);
      expect(lastSnapshot(published)?.runId).toBe("run-1");
    } finally {
      probe.stop();
    }
  });

  test("reuses a liveness answer for the same run instead of rechecking", async () => {
    let leaseReads = 0;
    let livenessChecks = 0;
    const deps: DreamRunStatusDepsOverrides = {
      now: () => STARTED_AT,
      readLease: () => {
        leaseReads += 1;
        return lease();
      },
      isLive: () => {
        livenessChecks += 1;
        return true;
      },
    };
    const published: (DreamStatusSnapshot | null)[] = [];
    const probe = mountProbe(
      { agentId: "agent-a", active: true, deps },
      published,
    );
    try {
      await waitFor(() => lastSnapshot(published) !== undefined);
      await tick(POLL_MS * 3);
      expect(livenessChecks).toBe(1);
      expect(leaseReads).toBeGreaterThan(1);
    } finally {
      probe.stop();
    }
  });

  test("stops polling while inactive and resumes when active", async () => {
    let leaseReads = 0;
    const deps: DreamRunStatusDepsOverrides = {
      now: () => STARTED_AT,
      readLease: () => {
        leaseReads += 1;
        return lease();
      },
      isLive: () => true,
    };
    const published: (DreamStatusSnapshot | null)[] = [];
    const probe = mountProbe(
      { agentId: "agent-a", active: false, deps },
      published,
    );
    try {
      await tick(POLL_MS * 4);
      expect(leaseReads).toBe(0);
      expect(published.every((snapshot) => snapshot === null)).toBe(true);

      probe.rerender({ agentId: "agent-a", active: true, deps });
      await waitFor(() => lastSnapshot(published) !== undefined);
      expect(leaseReads).toBeGreaterThan(0);
    } finally {
      probe.stop();
    }
  });
});

describe("useDreamRunStatus · done linger and cleanup", () => {
  test("a finished run lingers as done, then disappears", async () => {
    let nowMs = STARTED_AT;
    let currentLease: DreamRunLease | null = lease();
    let live = true;
    const deps: DreamRunStatusDepsOverrides = {
      now: () => nowMs,
      readLease: () => currentLease,
      isLive: () => live,
    };
    const published: (DreamStatusSnapshot | null)[] = [];
    const probe = mountProbe(
      { agentId: "agent-a", active: true, deps, doneLingerMs: 40 },
      published,
    );
    try {
      await waitFor(() => lastSnapshot(published)?.phase === "running");
      expect(lastSnapshot(published)?.elapsedMs).toBe(60_000);

      live = false;
      currentLease = null;
      await waitFor(() => lastSnapshot(published)?.phase === "done");
      expect(lastSnapshot(published)).toMatchObject({
        runId: "run-1",
        tier: "tidy",
      });

      // Move past the linger window: the local tick clears the line.
      nowMs += 100;
      await waitFor(() => published.at(-1) === null);
    } finally {
      probe.stop();
    }
  });

  test("an agent switch clears the old agent's run instead of lingering it", async () => {
    const leases = new Map<string, DreamRunLease | null>([
      ["agent-a", lease()],
      ["agent-b", null],
    ]);
    const live = new Map<string, boolean>([["agent-a", true]]);
    const deps: DreamRunStatusDepsOverrides = {
      now: () => STARTED_AT,
      readLease: (agentId) => leases.get(agentId) ?? null,
      isLive: (agentId) => live.get(agentId) === true,
    };
    const published: (DreamStatusSnapshot | null)[] = [];
    const probe = mountProbe(
      { agentId: "agent-a", active: true, deps },
      published,
    );
    try {
      await waitFor(() => lastSnapshot(published)?.agentId === "agent-a");
      const switchAt = published.length;
      probe.rerender({ agentId: "agent-b", active: true, deps });
      await tick(POLL_MS * 2);
      // Nothing published after the switch may carry the previous agent — no
      // done state is inherited, and the render guard never lets it through.
      expect(
        published
          .slice(switchAt)
          .every(
            (snapshot) => snapshot === null || snapshot.agentId !== "agent-a",
          ),
      ).toBe(true);
    } finally {
      probe.stop();
    }
  });

  test("a different run id replaces the previous run, done or not", async () => {
    const nowMs = STARTED_AT;
    let currentLease: DreamRunLease | null = lease();
    let live = true;
    const deps: DreamRunStatusDepsOverrides = {
      now: () => nowMs,
      readLease: () => currentLease,
      isLive: () => live,
    };
    const published: (DreamStatusSnapshot | null)[] = [];
    const probe = mountProbe(
      {
        agentId: "agent-a",
        active: true,
        deps,
        doneLingerMs: 60_000,
        // No cache: this test flips liveness from false back to true within
        // milliseconds, which the production 5 s cache is allowed to delay.
        livenessCacheMs: 0,
      },
      published,
    );
    try {
      await waitFor(() => lastSnapshot(published)?.runId === "run-1");

      // Run 1 ends and run 2's lease exists before its marker is live: the old
      // done must not linger across the switch.
      live = false;
      currentLease = lease({
        runId: "run-2",
        startedAt: STARTED_AT,
        tier: "think",
        spentTokens: null,
        budgetTokens: 2400,
      });
      await waitFor(() => published.at(-1) === null);

      live = true;
      await waitFor(() => lastSnapshot(published)?.runId === "run-2");
      expect(lastSnapshot(published)).toMatchObject({
        runId: "run-2",
        phase: "running",
        tier: "think",
        budgetTokens: 2400,
      });
    } finally {
      probe.stop();
    }
  });
});
