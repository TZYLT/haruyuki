import { describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStream } from "@/cli/helpers/stream";

/**
 * The provider prices every request it finishes (pi-ai's `Usage.cost`), and the
 * local backend now forwards those four buckets on `usage_statistics`. These
 * tests pin the drain side: the cost is summed on the same side of the
 * accumulate/dedupe decision as the token counters, and a provider that reports
 * no price leaves the field unset instead of reporting a fake zero.
 */

function streamOf(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  return stream as unknown as Stream<LettaStreamingResponse>;
}

describe("drainStream usage cost", () => {
  test("sums the cost buckets across requests", async () => {
    const chunks = [
      {
        message_type: "usage_statistics",
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        cost_usd: 0.5,
        cost_input_usd: 0.2,
        cost_output_usd: 0.1,
        cost_cache_read_usd: 0.15,
        cost_cache_write_usd: 0.05,
      } as LettaStreamingResponse,
      {
        message_type: "usage_statistics",
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6,
        cost_usd: 0.25,
        cost_input_usd: 0.1,
        cost_output_usd: 0.05,
        cost_cache_read_usd: 0.06,
        cost_cache_write_usd: 0.04,
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse,
    ];

    const result = await drainStream(
      streamOf(chunks),
      createBuffers("agent-test"),
      () => {},
    );

    expect(result.usageSteps).toBe(2);
    expect(result.usageCost?.input).toBeCloseTo(0.3);
    expect(result.usageCost?.output).toBeCloseTo(0.15);
    expect(result.usageCost?.cacheRead).toBeCloseTo(0.21);
    expect(result.usageCost?.cacheWrite).toBeCloseTo(0.09);
    expect(result.usageCost?.total).toBeCloseTo(0.75);
  });

  test("a provider with no price leaves the cost unset", async () => {
    const chunks = [
      {
        message_type: "usage_statistics",
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse,
    ];

    const result = await drainStream(
      streamOf(chunks),
      createBuffers("agent-test"),
      () => {},
    );

    expect(result.usageSteps).toBe(1);
    expect(result.usageCost).toBeUndefined();
  });

  test("no usage chunks at all reports no steps", async () => {
    const result = await drainStream(
      streamOf([
        {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse,
      ]),
      createBuffers("agent-test"),
      () => {},
    );
    expect(result.usageSteps).toBe(0);
    expect(result.usageCost).toBeUndefined();
  });
});
