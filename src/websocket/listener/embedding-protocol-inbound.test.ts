/**
 * Inbound validation for the R-26 embedding command family (D1).
 *
 * Table-driven per command: a minimal valid frame, the optional-field matrix,
 * and the shared envelope failures (discriminant, request id, agent scope).
 */
import { describe, expect, test } from "bun:test";
import {
  isEmbeddingBuildCommand,
  isEmbeddingCalibrateCommand,
  isEmbeddingCancelCommand,
  isEmbeddingConfigureCommand,
  isEmbeddingDisableCommand,
  isEmbeddingEnableCommand,
  isEmbeddingResetCommand,
  isEmbeddingStatusCommand,
} from "./embedding-protocol-inbound";
import { parseServerMessage } from "./protocol-inbound";

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };

type CommandCase = {
  name: string;
  type: string;
  guard: (value: unknown) => boolean;
};

const COMMANDS: CommandCase[] = [
  {
    name: "embedding_status",
    type: "embedding_status",
    guard: isEmbeddingStatusCommand,
  },
  {
    name: "embedding_configure",
    type: "embedding_configure",
    guard: isEmbeddingConfigureCommand,
  },
  {
    name: "embedding_enable",
    type: "embedding_enable",
    guard: isEmbeddingEnableCommand,
  },
  {
    name: "embedding_disable",
    type: "embedding_disable",
    guard: isEmbeddingDisableCommand,
  },
  {
    name: "embedding_build",
    type: "embedding_build",
    guard: isEmbeddingBuildCommand,
  },
  {
    name: "embedding_cancel",
    type: "embedding_cancel",
    guard: isEmbeddingCancelCommand,
  },
  {
    name: "embedding_reset",
    type: "embedding_reset",
    guard: isEmbeddingResetCommand,
  },
  {
    name: "embedding_calibrate",
    type: "embedding_calibrate",
    guard: isEmbeddingCalibrateCommand,
  },
];

function frame(type: string, extra: Record<string, unknown> = {}) {
  return { type, request_id: "req-1", runtime, ...extra };
}

describe("embedding command guards: envelope", () => {
  test("each guard accepts its minimal command", () => {
    for (const command of COMMANDS) {
      const extra = command.type === "embedding_configure" ? { patch: {} } : {};
      expect(command.guard(frame(command.type, extra)), command.name).toBe(
        true,
      );
    }
  });

  test("each guard rejects every other family discriminant", () => {
    for (const command of COMMANDS) {
      for (const other of COMMANDS) {
        if (other.type === command.type) continue;
        expect(
          command.guard(frame(other.type, { patch: {} })),
          `${command.name} accepted ${other.type}`,
        ).toBe(false);
      }
    }
  });

  test("rejects a missing or malformed agent runtime scope", () => {
    for (const command of COMMANDS) {
      const extra = command.type === "embedding_configure" ? { patch: {} } : {};
      expect(
        command.guard(frame(command.type, { ...extra, runtime: undefined })),
      ).toBe(false);
      expect(
        command.guard(
          frame(command.type, {
            ...extra,
            runtime: { agent_id: null, conversation_id: "conv-1" },
          }),
        ),
      ).toBe(false);
      expect(
        command.guard(
          frame(command.type, {
            ...extra,
            runtime: { agent_id: "agent-1", conversation_id: 7 },
          }),
        ),
      ).toBe(false);
    }
  });

  test("rejects an empty or non-string request id", () => {
    for (const command of COMMANDS) {
      const extra = command.type === "embedding_configure" ? { patch: {} } : {};
      expect(
        command.guard({
          type: command.type,
          request_id: "",
          runtime,
          ...extra,
        }),
      ).toBe(false);
      expect(
        command.guard({ type: command.type, request_id: 1, runtime, ...extra }),
      ).toBe(false);
    }
  });
});

describe("embedding_configure patch validation", () => {
  test("accepts an empty patch", () => {
    expect(
      isEmbeddingConfigureCommand(frame("embedding_configure", { patch: {} })),
    ).toBe(true);
  });

  test("requires a patch object", () => {
    expect(isEmbeddingConfigureCommand(frame("embedding_configure"))).toBe(
      false,
    );
    expect(
      isEmbeddingConfigureCommand(
        frame("embedding_configure", { patch: null }),
      ),
    ).toBe(false);
  });

  test("validates enums and ranges", () => {
    const invalidPatches: unknown[] = [
      { backend: "remote" },
      { gpu: "always" },
      { quantization: "int4" },
      { model: "" },
      { weight: -0.1 },
      { weight: 1.1 },
      { weight: "0.5" },
      { candidate_depth: 0 },
      { candidate_depth: 1.5 },
      { chunk_target: -1 },
      { chunk_overlap: -1 },
      { max_chunks_per_message: 0 },
      { keep_spaces: 0 },
      { threads: -1 },
      { api_key: "" },
      { api_key: 42 },
      {
        endpoint: {
          kind: "openai",
          base_url: "",
          model: "text-embedding-3-small",
          dimensions: 1536,
        },
      },
      {
        endpoint: {
          kind: "openai",
          base_url: "https://api.example.com/v1",
          model: "text-embedding-3-small",
          dimensions: 0,
        },
      },
      { endpoint: { kind: "cohere" } },
      { enabled: "yes" },
    ];
    for (const patch of invalidPatches) {
      expect(
        isEmbeddingConfigureCommand(frame("embedding_configure", { patch })),
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  test("accepts a fully populated endpoint patch, api_key included", () => {
    const patch = {
      enabled: true,
      backend: "endpoint",
      model: "text-embedding-3-small",
      endpoint: {
        kind: "ollama",
        base_url: "http://127.0.0.1:11434",
        model: "nomic-embed-text",
        dimensions: 768,
        timeout_ms: 10_000,
      },
      api_key: "sk-test",
      weight: 0.5,
      candidate_depth: 50,
      chunk_target: 200,
      chunk_max: 256,
      chunk_overlap: 32,
      max_chunks_per_message: 1024,
      threads: 2,
      gpu: "index-only",
      quantization: "int8",
      keep_spaces: 2,
    };
    expect(
      isEmbeddingConfigureCommand(frame("embedding_configure", { patch })),
    ).toBe(true);
  });
});

describe("embedding optional fields", () => {
  test("embedding_build accepts its mode and keep_after_exit flags", () => {
    expect(isEmbeddingBuildCommand(frame("embedding_build"))).toBe(true);
    expect(
      isEmbeddingBuildCommand(
        frame("embedding_build", { mode: "incremental" }),
      ),
    ).toBe(true);
    expect(
      isEmbeddingBuildCommand(
        frame("embedding_build", { mode: "full", keep_after_exit: true }),
      ),
    ).toBe(true);
    expect(
      isEmbeddingBuildCommand(frame("embedding_build", { mode: "partial" })),
    ).toBe(false);
    expect(
      isEmbeddingBuildCommand(frame("embedding_build", { keep_after_exit: 1 })),
    ).toBe(false);
  });

  test("embedding_cancel accepts an optional build id", () => {
    expect(isEmbeddingCancelCommand(frame("embedding_cancel"))).toBe(true);
    expect(
      isEmbeddingCancelCommand(
        frame("embedding_cancel", { build_id: "build-1" }),
      ),
    ).toBe(true);
    // The status snapshot's "no id assigned" sentinel round-trips as the
    // omitted form instead of being dropped (and timing out) on the client.
    expect(
      isEmbeddingCancelCommand(frame("embedding_cancel", { build_id: "" })),
    ).toBe(true);
    expect(
      isEmbeddingCancelCommand(frame("embedding_cancel", { build_id: 3 })),
    ).toBe(false);
  });

  test("embedding_reset accepts index/all scopes only", () => {
    expect(isEmbeddingResetCommand(frame("embedding_reset"))).toBe(true);
    expect(
      isEmbeddingResetCommand(frame("embedding_reset", { scope: "index" })),
    ).toBe(true);
    expect(
      isEmbeddingResetCommand(frame("embedding_reset", { scope: "all" })),
    ).toBe(true);
    expect(
      isEmbeddingResetCommand(frame("embedding_reset", { scope: "vectors" })),
    ).toBe(false);
  });

  test("embedding_calibrate accepts an optional persist flag", () => {
    expect(isEmbeddingCalibrateCommand(frame("embedding_calibrate"))).toBe(
      true,
    );
    expect(
      isEmbeddingCalibrateCommand(
        frame("embedding_calibrate", { persist: false }),
      ),
    ).toBe(true);
    expect(
      isEmbeddingCalibrateCommand(
        frame("embedding_calibrate", { persist: "no" }),
      ),
    ).toBe(false);
  });

  test("rejects non-object frames", () => {
    for (const command of COMMANDS) {
      expect(command.guard(null), command.name).toBe(false);
      expect(command.guard("embedding_status"), command.name).toBe(false);
      expect(command.guard([]), command.name).toBe(false);
    }
  });
});

/**
 * The guards above can all pass while `parseServerMessage` still drops the
 * frame (a family that is not in its OR-chain is invisible to every client),
 * so this block exercises the real inbound entry point, not the guards.
 */
describe("embedding commands reach parseServerMessage", () => {
  function frameFor(command: CommandCase): Record<string, unknown> {
    const extra = command.type === "embedding_configure" ? { patch: {} } : {};
    return {
      type: command.type,
      request_id: "req-parse",
      runtime,
      ...extra,
    };
  }

  function parsedType(value: unknown): string | null {
    if (value === null || typeof value !== "object") return null;
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? type : null;
  }

  test("each of the eight commands survives the inbound OR-chain unchanged", () => {
    for (const command of COMMANDS) {
      expect(
        parsedType(
          parseServerMessage(Buffer.from(JSON.stringify(frameFor(command)))),
        ),
        command.name,
      ).toBe(command.type);
    }
  });

  test("a frame the family guard rejects is not routed as an embedding command", () => {
    const malformed: Record<string, unknown>[] = [
      {
        type: "embedding_configure",
        request_id: "req-bad",
        runtime,
        patch: { weight: 2 },
      },
      {
        type: "embedding_build",
        request_id: "req-bad",
        runtime,
        mode: "bogus",
      },
      { type: "embedding_status", request_id: "req-bad", runtime: {} },
      { type: "embedding_nope", request_id: "req-bad", runtime },
    ];
    for (const frame of malformed) {
      const type = parsedType(
        parseServerMessage(Buffer.from(JSON.stringify(frame))),
      );
      expect(type, JSON.stringify(frame)).not.toBe("embedding_status");
      expect(type, JSON.stringify(frame)).not.toBe("embedding_configure");
      expect(type, JSON.stringify(frame)).not.toBe("embedding_build");
    }
  });
});
