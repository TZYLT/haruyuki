/**
 * Inbound validation for the R-26 embedding command family (D1).
 *
 * Table-driven per command: a minimal valid frame, the optional-field matrix,
 * and the shared envelope failures (discriminant, request id, agent scope).
 */
import { describe, expect, test } from "bun:test";
import {
  isEmbeddingBuildCommand,
  isEmbeddingCancelCommand,
  isEmbeddingConfigGetCommand,
  isEmbeddingConfigSetCommand,
  isEmbeddingConnectCommand,
  isEmbeddingDeviceCommand,
  isEmbeddingDeviceTestCommand,
  isEmbeddingDisableCommand,
  isEmbeddingEnableCommand,
  isEmbeddingProfileDeleteCommand,
  isEmbeddingProfilePinCommand,
  isEmbeddingProfileSelectCommand,
  isEmbeddingProfilesListCommand,
  isEmbeddingStatusCommand,
} from "./embedding-protocol-inbound";
import { parseServerMessage } from "./protocol-inbound";

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };

type CommandCase = {
  name: string;
  type: string;
  guard: (value: unknown) => boolean;
};

/** Fields a minimal valid frame of the same type carries. */
function minimalExtra(type: string): Record<string, unknown> {
  switch (type) {
    case "embedding_connect":
      return { patch: {} };
    case "embedding_profile_select":
      return { index: 1 };
    case "embedding_profile_pin":
      return { index: 1, pinned: true };
    case "embedding_config_set":
      return { key: "threads", value: 2 };
    default:
      return {};
  }
}

const COMMANDS: CommandCase[] = [
  {
    name: "embedding_status",
    type: "embedding_status",
    guard: isEmbeddingStatusCommand,
  },
  {
    name: "embedding_connect",
    type: "embedding_connect",
    guard: isEmbeddingConnectCommand,
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
    name: "embedding_profiles_list",
    type: "embedding_profiles_list",
    guard: isEmbeddingProfilesListCommand,
  },
  {
    name: "embedding_profile_select",
    type: "embedding_profile_select",
    guard: isEmbeddingProfileSelectCommand,
  },
  {
    name: "embedding_profile_delete",
    type: "embedding_profile_delete",
    guard: isEmbeddingProfileDeleteCommand,
  },
  {
    name: "embedding_profile_pin",
    type: "embedding_profile_pin",
    guard: isEmbeddingProfilePinCommand,
  },
  {
    name: "embedding_config_get",
    type: "embedding_config_get",
    guard: isEmbeddingConfigGetCommand,
  },
  {
    name: "embedding_config_set",
    type: "embedding_config_set",
    guard: isEmbeddingConfigSetCommand,
  },
  {
    name: "embedding_device",
    type: "embedding_device",
    guard: isEmbeddingDeviceCommand,
  },
  {
    name: "embedding_device_test",
    type: "embedding_device_test",
    guard: isEmbeddingDeviceTestCommand,
  },
];

function frame(type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    request_id: "req-1",
    runtime,
    ...minimalExtra(type),
    ...extra,
  };
}

describe("embedding command guards: envelope", () => {
  test("each guard accepts its minimal command", () => {
    for (const command of COMMANDS) {
      expect(command.guard(frame(command.type)), command.name).toBe(true);
    }
  });

  test("each guard rejects every other family discriminant", () => {
    for (const command of COMMANDS) {
      for (const other of COMMANDS) {
        if (other.type === command.type) continue;
        expect(
          command.guard(frame(other.type)),
          `${command.name} accepted ${other.type}`,
        ).toBe(false);
      }
    }
  });

  test("rejects a missing or malformed agent runtime scope", () => {
    for (const command of COMMANDS) {
      expect(command.guard(frame(command.type, { runtime: undefined }))).toBe(
        false,
      );
      expect(
        command.guard(
          frame(command.type, {
            runtime: { agent_id: null, conversation_id: "conv-1" },
          }),
        ),
      ).toBe(false);
      expect(
        command.guard(
          frame(command.type, {
            runtime: { agent_id: "agent-1", conversation_id: 7 },
          }),
        ),
      ).toBe(false);
    }
  });

  test("rejects an empty or non-string request id", () => {
    for (const command of COMMANDS) {
      expect(
        command.guard(frame(command.type, { request_id: "" })),
        command.name,
      ).toBe(false);
      expect(
        command.guard(frame(command.type, { request_id: 1 })),
        command.name,
      ).toBe(false);
    }
  });
});

describe("embedding_connect patch validation", () => {
  test("accepts an empty patch", () => {
    expect(
      isEmbeddingConnectCommand(frame("embedding_connect", { patch: {} })),
    ).toBe(true);
  });

  test("requires a patch object", () => {
    const missing = { type: "embedding_connect", request_id: "req-1", runtime };
    expect(isEmbeddingConnectCommand(missing)).toBe(false);
    expect(
      isEmbeddingConnectCommand(frame("embedding_connect", { patch: null })),
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
        isEmbeddingConnectCommand(frame("embedding_connect", { patch })),
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
      isEmbeddingConnectCommand(frame("embedding_connect", { patch })),
    ).toBe(true);
  });
});

describe("embedding optional fields", () => {
  test("embedding_build accepts its mode and keep_after_exit flags", () => {
    expect(isEmbeddingBuildCommand(frame("embedding_build"))).toBe(true);
    expect(
      isEmbeddingBuildCommand(frame("embedding_build", { mode: "full" })),
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
      isEmbeddingCancelCommand(frame("embedding_cancel", { build_id: "" })),
    ).toBe(true);
    expect(
      isEmbeddingCancelCommand(frame("embedding_cancel", { build_id: 3 })),
    ).toBe(false);
  });

  test("embedding_profile_delete accepts its scopes and confirm flag", () => {
    expect(
      isEmbeddingProfileDeleteCommand(frame("embedding_profile_delete")),
    ).toBe(true);
    for (const scope of ["current", "all", "model"]) {
      expect(
        isEmbeddingProfileDeleteCommand(
          frame("embedding_profile_delete", { scope }),
        ),
      ).toBe(true);
    }
    expect(
      isEmbeddingProfileDeleteCommand(
        frame("embedding_profile_delete", { scope: "vectors" }),
      ),
    ).toBe(false);
    expect(
      isEmbeddingProfileDeleteCommand(
        frame("embedding_profile_delete", { confirm: "yes" }),
      ),
    ).toBe(false);
  });

  test("profile select and pin need a selector", () => {
    const selectorless = {
      type: "embedding_profile_select",
      request_id: "req-1",
      runtime,
    };
    expect(isEmbeddingProfileSelectCommand(selectorless)).toBe(false);
    expect(
      isEmbeddingProfileSelectCommand(
        frame("embedding_profile_select", { space_id: "space-1" }),
      ),
    ).toBe(true);
    expect(
      isEmbeddingProfilePinCommand(
        frame("embedding_profile_pin", { pinned: "yes" }),
      ),
    ).toBe(false);
  });

  test("config commands validate key and value types", () => {
    expect(isEmbeddingConfigGetCommand(frame("embedding_config_get"))).toBe(
      true,
    );
    expect(
      isEmbeddingConfigGetCommand(frame("embedding_config_get", { key: "" })),
    ).toBe(false);
    expect(isEmbeddingConfigSetCommand(frame("embedding_config_set"))).toBe(
      true,
    );
    expect(
      isEmbeddingConfigSetCommand(
        frame("embedding_config_set", { value: { n: 1 } }),
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
  function parsedType(value: unknown): string | null {
    if (value === null || typeof value !== "object") return null;
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? type : null;
  }

  test("each of the fourteen commands survives the inbound OR-chain unchanged", () => {
    for (const command of COMMANDS) {
      expect(
        parsedType(
          parseServerMessage(
            Buffer.from(
              JSON.stringify({
                type: command.type,
                request_id: "req-parse",
                runtime,
                ...minimalExtra(command.type),
              }),
            ),
          ),
        ),
        command.name,
      ).toBe(command.type);
    }
  });

  test("a frame the family guard rejects is not routed as an embedding command", () => {
    const malformed: Record<string, unknown>[] = [
      {
        type: "embedding_connect",
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
    for (const malformedFrame of malformed) {
      const type = parsedType(
        parseServerMessage(Buffer.from(JSON.stringify(malformedFrame))),
      );
      expect(type, JSON.stringify(malformedFrame)).not.toBe("embedding_status");
      expect(type, JSON.stringify(malformedFrame)).not.toBe(
        "embedding_connect",
      );
      expect(type, JSON.stringify(malformedFrame)).not.toBe("embedding_build");
    }
  });
});
