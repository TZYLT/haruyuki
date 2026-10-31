import type WebSocket from "ws";
import type {
  UsageAggregateCommand,
  UsageAggregateResponseMessage,
  UsageAggregateRun,
  UsageAggregateTotals,
} from "@/types/usage-protocol";
import {
  aggregateUsageByHour,
  readUsageLedger,
  summarizeUsageByRunId,
  type UsageRecord,
  type UsageTotals,
  usageHourKey,
} from "@/usage/ledger";
import { getErrorMessage } from "@/utils/error";
import { addUsageCost, emptyUsageCost } from "@/utils/usage-cost";
import { isUsageAggregateCommand } from "@/websocket/listener/usage-protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

/**
 * Read-only usage aggregation for app-server clients (M5-A stage 2, B2).
 *
 * F-06 §5.2 gives the hidden-session groups a cost column; the TUI reads the
 * ledger directly, a desktop cannot. This module exposes the same numbers and
 * stays on the read side of `usage/ledger`: `readUsageLedger` for the rows, the
 * ledger's own bucketing for the totals, and `summarizeUsageByRunId` for a
 * named run. Nothing here writes, and a missing/unreadable ledger degrades to
 * zero rows exactly like every other ledger reader.
 *
 * Filters: `agent_id` is required (a ledger belongs to one agent), `run_id`
 * wins over `session_id` when both are present, and `from`/`to` are inclusive
 * ISO bounds compared at the ledger's own resolution — a row stores the local
 * hour it ended in (`tsHour`), so a bound covers that whole hour. That is the
 * finest granularity the file has; pretending to second precision would be a
 * lie about the data.
 */
export type UsageProtocolCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

type UsageSend = (payload: unknown) => boolean;

function createUsageSend(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): UsageSend {
  return (payload) =>
    safeSocketSend(
      socket,
      payload,
      "listener_usage_send_failed",
      "listener_usage_protocol",
    );
}

/** The all-zero shape a client renders as `—` (turns = 0 means "no row"). */
export function emptyUsageAggregateTotals(): UsageAggregateTotals {
  return {
    turns: 0,
    prompt: 0,
    cachedInput: 0,
    cacheWrite: 0,
    completion: 0,
    reasoning: 0,
    steps: 0,
    wallMs: 0,
    apiMs: 0,
    cost: emptyUsageCost(),
  };
}

/**
 * Fold the ledger's per-hour buckets into one total.
 *
 * Summing the ledger's own buckets (rather than re-adding record fields here)
 * keeps the aggregation math in one owner: every matched record lands in
 * exactly one hour bucket, so the sum over buckets is the sum over records.
 */
function foldUsageTotals(buckets: Iterable<UsageTotals>): UsageAggregateTotals {
  const totals = emptyUsageAggregateTotals();
  for (const bucket of buckets) {
    totals.turns += bucket.turns;
    totals.prompt += bucket.prompt;
    totals.cachedInput += bucket.cachedInput;
    totals.cacheWrite += bucket.cacheWrite;
    totals.completion += bucket.completion;
    totals.reasoning += bucket.reasoning;
    totals.steps += bucket.steps;
    totals.wallMs += bucket.wallMs;
    totals.apiMs += bucket.apiMs;
    addUsageCost(totals.cost, bucket.cost);
  }
  return totals;
}

/** One run id's slice, shaped for the wire (totals + recorded outcomes). */
function toAggregateRun(
  runId: string,
  records: readonly UsageRecord[],
): UsageAggregateRun {
  const summary = summarizeUsageByRunId(records, [runId]).get(runId);
  return {
    runId,
    totals: {
      turns: summary?.turns ?? 0,
      prompt: summary?.prompt ?? 0,
      cachedInput: summary?.cachedInput ?? 0,
      cacheWrite: summary?.cacheWrite ?? 0,
      completion: summary?.completion ?? 0,
      reasoning: summary?.reasoning ?? 0,
      steps: summary?.steps ?? 0,
      wallMs: summary?.wallMs ?? 0,
      apiMs: summary?.apiMs ?? 0,
      cost: summary?.cost ?? emptyUsageCost(),
    },
    outcomes: [...(summary?.outcomes ?? [])],
  };
}

/**
 * `true` when the row's hour falls inside the inclusive ISO bounds.
 *
 * `tsHour` sorts lexicographically (`YYYY-MM-DDTHH`), which is why the ledger
 * stores it in that shape.
 */
function matchesUsageWindow(
  record: UsageRecord,
  fromHour: string | null,
  toHour: string | null,
): boolean {
  if (fromHour !== null && record.tsHour < fromHour) return false;
  if (toHour !== null && record.tsHour > toHour) return false;
  return true;
}

export async function handleUsageAggregateCommand(
  command: UsageAggregateCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  readLedger: () => Promise<readonly UsageRecord[]> = readUsageLedger,
): Promise<void> {
  const send = createUsageSend(socket, safeSocketSend);
  try {
    const records = await readLedger();
    const fromHour =
      command.from === undefined ? null : usageHourKey(new Date(command.from));
    const toHour =
      command.to === undefined ? null : usageHourKey(new Date(command.to));

    const inScope = records.filter(
      (record) =>
        record.agentId === command.agent_id &&
        matchesUsageWindow(record, fromHour, toHour),
    );
    // `run_id` wins over `session_id`: a run id is the narrower, unambiguous
    // selector, and a row carries both when the run ran in a session.
    let matched = inScope;
    if (command.run_id !== undefined) {
      matched = inScope.filter((record) => record.runId === command.run_id);
    } else if (command.session_id !== undefined) {
      matched = inScope.filter(
        (record) => record.sessionId === command.session_id,
      );
    }

    const totals = foldUsageTotals(aggregateUsageByHour(matched).values());
    // Per-run buckets only when the query names a run; the wire comment makes
    // `runs` empty otherwise so a client is not asked to guess the grouping.
    const runs =
      command.run_id === undefined
        ? []
        : [toAggregateRun(command.run_id, matched)];

    const response: UsageAggregateResponseMessage = {
      type: "usage_aggregate_response",
      request_id: command.request_id,
      success: true,
      totals,
      runs,
    };
    send(response);
  } catch (error) {
    const response: UsageAggregateResponseMessage = {
      type: "usage_aggregate_response",
      request_id: command.request_id,
      success: false,
      totals: emptyUsageAggregateTotals(),
      runs: [],
      error: getErrorMessage(error),
    };
    send(response);
  }
}

export function handleUsageProtocolCommand(
  parsed: unknown,
  context: UsageProtocolCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;
  if (!isUsageAggregateCommand(parsed)) return false;

  const command = parsed;
  runDetachedListenerTask("usage_protocol_command", async () => {
    await handleUsageAggregateCommand(command, socket, safeSocketSend);
  });
  return true;
}
