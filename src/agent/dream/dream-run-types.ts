/**
 * Shared shapes for the dream run controller (F-06 M2).
 *
 * These types are used by both `dream-run.ts` (the state machine) and
 * `dream-run-wiring.ts` (the production side effects). They live in their own
 * module so the two do not have to import each other — the wiring depends on the
 * controller's contract, never the other way round (no module cycle;
 * `check:cycles` is a hard gate).
 */

import type { RunOutcome, ScheduleTaskV2 } from "@/cron/cron-types";
import type { DreamUsageParts } from "@/dream-budget-math";
import type { ResolvedDreamSettings } from "@/dream-settings";
import type { DreamRunMetadata, DreamTier } from "@/types/dream-run-metadata";

export interface DreamRunTaskInput {
  /** The persisted task, already resolved from `--task <id>`. */
  task: ScheduleTaskV2;
  runId: string;
  /** Claimed scheduled occurrence; empty string for a manual run. */
  occurrence: string;
  /**
   * `/dream run` (user asked for it now) vs the idle signal. A manual run is
   * allowed to run on a conservative pressure floor instead of the measured
   * pressure, which is zero on a fresh ledger — otherwise the manual entry
   * resolves a zero budget and can do nothing (R-5.9.3 / Q-16).
   */
  manual?: boolean;
  signal: AbortSignal;
}

export interface DreamRunTaskResult {
  outcome: RunOutcome;
  error?: string;
  /** The hidden conversation the run created, when it got that far. */
  conversationId?: string;
}

/** One tier turn, as the parent asks for it. */
export interface DreamTurnInput {
  agentId: string;
  conversationId: string;
  memoryDir: string;
  runId: string;
  tier: DreamTier;
  tierIndex: number;
  tierCount: number;
  prompt: string;
  permissionMode: ResolvedDreamSettings["permissionMode"];
  signal: AbortSignal;
}

export interface DreamTurnResult {
  success: boolean;
  error?: string;
  /** The child's final assistant text — the report body candidate. */
  report?: string;
  /** True when the parent's abort signal ended the turn. */
  aborted: boolean;
  /** Weighted usage of this turn, from stream events and/or the result envelope. */
  usage: DreamUsageParts;
  /** Model handle the child reported, when it reported one. */
  model?: string;
}

/**
 * Everything the controller touches, injectable so the state machine is
 * testable without a backend, git or a child process. Production supplies the
 * defaults from `dream-run-wiring.ts`.
 */
export interface DreamRunDeps {
  now(): Date;
  resolveSettings(agentId: string): ResolvedDreamSettings;
  memoryDir(agentId: string): string;
  tryAcquireDreamLock(agentId: string): Promise<(() => Promise<void>) | null>;
  acquireMemoryLock(memoryDir: string): Promise<(() => Promise<void>) | null>;
  createBaseline(input: {
    memoryDir: string;
    runId: string;
    agentId: string;
  }): Promise<{ sha: string }>;
  rollbackBaseline(input: {
    memoryDir: string;
    baselineSha: string;
  }): Promise<{ changed: boolean }>;
  createSession(input: {
    agentId: string;
    runId: string;
  }): Promise<{ conversationId: string }>;
  writeMetadata(input: {
    conversationId: string;
    metadata: DreamRunMetadata;
  }): Promise<void>;
  readMetadata(conversationId: string): Promise<DreamRunMetadata | undefined>;
  createLease(input: { agentId: string; runId: string; taskId: string }): void;
  updateLease(input: {
    agentId: string;
    patch: {
      conversationId?: string;
      baselineSha?: string;
      status?: "running" | "finishing";
    };
  }): void;
  startLeaseHeartbeat(agentId: string): () => void;
  deleteLease(agentId: string): void;
  markRunActive(agentId: string, runId: string, at: Date): void;
  markRunFinished(agentId: string, outcome: string, at: Date): void;
  readActivity(agentId: string): number | null;
  readPressure(agentId: string): number;
  recordPressureBaseline(agentId: string, endedAt: number): void;
  spawnTurn(input: DreamTurnInput): Promise<DreamTurnResult>;
  writeReport(input: {
    agentId: string;
    conversationId: string;
    metadata: DreamRunMetadata;
    body: string;
  }): Promise<{ reportPath: string | null; committed: boolean }>;
  recordLedgerMarker(input: {
    outcome: "failed" | "timeout" | "cancelled" | "budget_exhausted";
    runId: string;
    agentId: string;
    sessionId: string;
    model: string;
    wallMs: number;
  }): Promise<void>;
  retrieveAgentName(agentId: string): Promise<string | null>;
}
