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
import type { UsageCost } from "@/utils/usage-cost";

/** The cost fields the local backend puts on a `usage_statistics` chunk. */
type ReportedCostChunk = {
  cost_usd?: number;
  cost_input_usd?: number;
  cost_output_usd?: number;
  cost_cache_read_usd?: number;
  cost_cache_write_usd?: number;
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
