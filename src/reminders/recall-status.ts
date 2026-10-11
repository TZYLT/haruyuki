import { loadRecallCorpus } from "@/backend/local/recall-index";
import {
  type ResolvedRecallSettings,
  readRecallSettings,
} from "@/recall-settings";
import type { RecallStatus } from "./recall-port";
import { readRecallRuntimeStatus } from "./recall-runtime";

/**
 * `/recall status`: what the feature is doing, in one screenful.
 *
 * `status` has to answer six things (《26》§6.8): on or off, whether the breaker
 * has tripped, how many failures are in a row, why the last one happened, which
 * parameters are in effect, and how much of the store is actually indexed. All six
 * already exist — the settings record, the runtime counter, and the corpus
 * maintenance counts — so this module is only the assembly and the copy.
 *
 * The index half runs with `maintain: false`: asking for status must never write a
 * sidecar. That is also what makes the counts meaningful, because the maintenance
 * path would otherwise rebuild exactly what we are trying to count.
 */

export interface RecallIndexCoverage {
  /** Conversations in scope that have a transcript. */
  conversations: number;
  /** Sidecars that match their transcript. */
  ready: number;
  /** Sidecars the loader would rewrite on the next turn. */
  stale: number;
  /** Conversations with no usable sidecar: never built, or unreadable. */
  missing: number;
  /** Conversations exempt from lazy maintenance (the one the turn runs in). */
  exempt: number;
  /** Records across the usable sidecars. */
  records: number;
  /** Conversation keys without a usable sidecar, for the "run build" hint. */
  missingKeys: string[];
}

export interface RecallStatusReport {
  enabled: boolean;
  tripped: boolean;
  consecutiveFailures: number;
  lastFailureReason: string | null;
  lastDecision: {
    status: RecallStatus;
    entries: number;
    timedOut: boolean;
  } | null;
  settings: ResolvedRecallSettings;
  index: RecallIndexCoverage;
}

export function collectRecallStatus(input: {
  storageDir: string;
  /** `undefined` reports the whole store rather than one agent's slice. */
  agentId?: string;
}): RecallStatusReport {
  const settings = readRecallSettings();
  const runtime = readRecallRuntimeStatus();
  const corpus = loadRecallCorpus(input.storageDir, {
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    maintain: false,
  });

  return {
    enabled: settings.enabled,
    tripped: runtime.tripped,
    consecutiveFailures: runtime.consecutiveFailures,
    lastFailureReason: runtime.lastFailureReason,
    lastDecision: runtime.lastDecision
      ? {
          status: runtime.lastDecision.status,
          entries: runtime.lastDecision.entries.length,
          timedOut: runtime.lastDecision.timedOut === true,
        }
      : null,
    settings,
    index: {
      conversations: corpus.conversations,
      ready: corpus.maintenance.ready,
      stale: corpus.maintenance.stale,
      // `unavailable` covers "never built" and "unreadable" alike; the loader
      // cannot tell them apart and neither can a user acting on this line.
      missing: corpus.maintenance.unavailable,
      exempt: corpus.maintenance.exempt,
      records: corpus.records.length,
      missingKeys: corpus.unavailable.map((problem) => problem.conversationKey),
    },
  };
}

function yesNo(value: boolean): string {
  return value ? "on" : "off";
}

/**
 * The report as lines. Pure, so the CLI, the TUI and the tests all print the same
 * thing and the copy can be reviewed without a store.
 */
export function formatRecallStatus(report: RecallStatusReport): string[] {
  const { settings, index } = report;
  const lines = [`Recall: ${yesNo(report.enabled)}`];

  if (report.tripped) {
    lines.push(
      `Breaker: tripped after ${report.consecutiveFailures} consecutive failure${
        report.consecutiveFailures === 1 ? "" : "s"
      }${report.lastFailureReason ? ` (last: ${report.lastFailureReason})` : ""} — /recall on re-enables it`,
    );
  } else {
    lines.push(
      `Breaker: healthy (${report.consecutiveFailures} consecutive failures)`,
    );
  }

  if (report.lastDecision) {
    const { status, entries, timedOut } = report.lastDecision;
    lines.push(
      `Last turn: ${status}${entries > 0 ? ` (${entries} passage${entries === 1 ? "" : "s"})` : ""}${
        timedOut ? ", cut short by the deadline" : ""
      }`,
    );
  }

  lines.push(
    `Settings: limit ${settings.limit} · excerpt ${settings.excerptCharacters}/${settings.totalCharacters} chars · ratio ${settings.minScoreRatio} · diversity ${settings.diversity} · dedup ${settings.dedupTurns} turns · timeout ${
      settings.timeoutMs === 0 ? "none" : `${settings.timeoutMs}ms`
    } · display ${settings.display}`,
  );

  const indexed = index.ready + index.exempt;
  const coverage =
    index.conversations === 0
      ? "no conversations in scope"
      : `${indexed}/${index.conversations} conversations indexed`;
  lines.push(
    `Index: ${coverage} · ${index.records} record${index.records === 1 ? "" : "s"}${
      index.stale > 0 ? ` · ${index.stale} stale` : ""
    }${index.missing > 0 ? ` · ${index.missing} without an index` : ""}`,
  );

  if (index.missing > 0) {
    lines.push(
      `  ${index.missing} conversation${index.missing === 1 ? "" : "s"} cannot be recalled yet. Run /recall build.`,
    );
  }

  return lines;
}
