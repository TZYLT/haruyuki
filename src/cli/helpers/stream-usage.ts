/**
 * Reading the provider's price off a `usage_statistics` chunk.
 *
 * The local backend forwards the four cost buckets pi-ai computed for the
 * request (see `backend/dev/provider-turn-executor.ts`). This module reads them
 * back and hands `drainStream` one accumulator, so the stream loop keeps the
 * same shape as the token counters it already sums and stays under its size
 * limit.
 */

import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { UsageContextBreakdown } from "@/utils/usage-context";
import {
  addUsageCost,
  emptyUsageCost,
  type UsageCost,
} from "@/utils/usage-cost";

/** The cost fields the local backend puts on a `usage_statistics` chunk. */
type ReportedCostChunk = {
  cost_usd?: number;
  cost_input_usd?: number;
  cost_output_usd?: number;
  cost_cache_read_usd?: number;
  cost_cache_write_usd?: number;
};

/** The composition fields the local backend puts on the same chunk. */
type ReportedCompositionChunk = {
  context_system_tokens?: number;
  context_messages_tokens?: number;
  context_tools_tokens?: number;
};

/** Cost carried by one chunk, or `undefined` when the provider had no price. */
export function readReportedCost(
  chunk: LettaStreamingResponse,
): UsageCost | undefined {
  const reported = chunk as unknown as ReportedCostChunk;
  if (typeof reported.cost_usd !== "number") return undefined;
  return {
    input: reported.cost_input_usd ?? 0,
    output: reported.cost_output_usd ?? 0,
    cacheRead: reported.cost_cache_read_usd ?? 0,
    cacheWrite: reported.cost_cache_write_usd ?? 0,
    total: reported.cost_usd,
  };
}

/**
 * What the request was made of, when the backend reported it.
 *
 * This is a **snapshot**, not a counter: the last report of a drain wins, and a
 * resume that reports nothing keeps the earlier value.
 */
export function readReportedContextComposition(
  chunk: LettaStreamingResponse,
): UsageContextBreakdown | undefined {
  const reported = chunk as unknown as ReportedCompositionChunk;
  if (
    typeof reported.context_system_tokens !== "number" &&
    typeof reported.context_messages_tokens !== "number" &&
    typeof reported.context_tools_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    system: reported.context_system_tokens ?? 0,
    messages: reported.context_messages_tokens ?? 0,
    tools: reported.context_tools_tokens ?? 0,
  };
}

/** The usage numbers one drain collects, as they cross the resume boundary. */
export interface StreamUsageState {
  cost: UsageCost;
  steps: number;
  composition?: UsageContextBreakdown;
}

export function createStreamUsageState(): StreamUsageState {
  return { cost: emptyUsageCost(), steps: 0 };
}

/** Fold one chunk into the drain's totals. Non-usage chunks are ignored. */
export function addChunkUsage(
  state: StreamUsageState,
  chunk: LettaStreamingResponse,
): void {
  if (chunk.message_type !== "usage_statistics") return;
  state.steps += 1;
  addUsageCost(state.cost, readReportedCost(chunk));
  const composition = readReportedContextComposition(chunk);
  if (composition) state.composition = composition;
}

/** The usage fields a drain result carries; named as they are there. */
export interface DrainUsageFields {
  usageCost?: UsageCost;
  usageSteps?: number;
  contextComposition?: UsageContextBreakdown;
}

/**
 * Carry the totals across a resume.
 *
 * Cost and request count are sums, so they add; the composition is a snapshot,
 * so the resumed report wins and the earlier one is only a fallback.
 */
export function mergeDrainUsage(
  target: DrainUsageFields,
  before: DrainUsageFields,
): void {
  target.usageCost ??= emptyUsageCost();
  addUsageCost(target.usageCost, before.usageCost);
  target.usageSteps = (target.usageSteps ?? 0) + (before.usageSteps ?? 0);
  target.contextComposition ??= before.contextComposition;
}
