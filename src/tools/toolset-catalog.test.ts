import { afterEach, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import { sessionPermissions } from "@/permissions/session";
import {
  clearCapturedToolExecutionContexts,
  getServerToolName,
} from "./manager";
import { TOOL_DEFINITIONS } from "./tool-definitions";
import { prepareToolExecutionContextForResolvedTarget } from "./toolset";
import { TOOLSET_CATALOG, TOOLSET_OPTIONS } from "./toolset-catalog";

afterEach(() => {
  clearCapturedToolExecutionContexts();
  permissionMode.reset();
  sessionPermissions.clear();
});

test("advertises the supported toolset choices", () => {
  expect(TOOLSET_OPTIONS.map(({ id }) => id)).toEqual([
    "auto",
    "letta",
    "none",
    "default",
    "codex",
  ]);
});

test("client options contain only toolset protocol metadata", () => {
  for (const option of TOOLSET_OPTIONS) {
    expect(Object.keys(option).sort()).toEqual([
      "description",
      "display_name",
      "id",
      "is_featured",
      "label",
    ]);
  }
});

test.each(Object.entries(TOOLSET_CATALOG))(
  "%s contains registered tools with unique model-facing names",
  (_id, { tools }) => {
    for (const tool of tools) {
      expect(Object.hasOwn(TOOL_DEFINITIONS, tool)).toBe(true);
    }
    expect(new Set(tools.map(getServerToolName)).size).toBe(tools.length);
  },
);

test("does not register removed background output pollers", () => {
  expect(Object.hasOwn(TOOL_DEFINITIONS, "TaskOutput")).toBe(false);
  expect(Object.hasOwn(TOOL_DEFINITIONS, "BashOutput")).toBe(false);
  for (const { tools } of Object.values(TOOLSET_CATALOG)) {
    expect(tools).not.toContain("TaskOutput");
    expect(tools).not.toContain("BashOutput");
  }
});

test("TopicMark ships in every non-empty preset", () => {
  expect(Object.hasOwn(TOOL_DEFINITIONS, "TopicMark")).toBe(true);
  // The prompt chapter and the nudge both name the tool, so every preset that
  // carries built-in tools has to declare it; the declaration gate is what keeps
  // it out of cloud payloads and off when the switch says so.
  expect(TOOLSET_CATALOG.letta.tools).toContain("TopicMark");
  expect(TOOLSET_CATALOG.default.tools).toContain("TopicMark");
  expect(TOOLSET_CATALOG.codex.tools).toContain("TopicMark");
  // `none` is the explicit "no built-in tools" preset.
  expect(TOOLSET_CATALOG.none.tools).not.toContain("TopicMark");
});

test("DreamNote ships in every non-empty preset", () => {
  // W15: the main agent's note entry point. A preset that does not advertise it
  // makes the normal-session auto-allow pointless, and the slash/app-server
  // entrances would be the only way to leave a note for the next dream run.
  expect(Object.hasOwn(TOOL_DEFINITIONS, "DreamNote")).toBe(true);
  expect(TOOLSET_CATALOG.letta.tools).toContain("DreamNote");
  expect(TOOLSET_CATALOG.default.tools).toContain("DreamNote");
  expect(TOOLSET_CATALOG.codex.tools).toContain("DreamNote");
  // `none` is the explicit "no built-in tools" preset.
  expect(TOOLSET_CATALOG.none.tools).not.toContain("DreamNote");
});

// The cross-agent send tool used to be asserted here. It required a Cloud
// backend to send to another agent, so it was removed rather than shipped as a
// tool that always returned an error. The presets are covered by the assertions
// below and in the "exposes Agent" cases.
test("none and explicit client allowlists still exclude the tool", async () => {
  const none = await prepareToolExecutionContextForResolvedTarget({
    toolsetPreference: "none",
  });
  expect(none.preparedToolContext.loadedToolNames).not.toContain("Task");
  const limited = await prepareToolExecutionContextForResolvedTarget({
    toolsetPreference: "letta",
    clientToolAllowlist: ["Read"],
  });
  expect(limited.preparedToolContext.loadedToolNames).toEqual(["Read"]);
});

test("standard and strict modes ask; explicit denial remains effective", () => {
  const args = { conversation_id: "conv-target", message: "hello" };
  for (const mode of ["standard", "strict"] as const) {
    permissionMode.setMode(mode);
    expect(
      checkPermission(
        "Task",
        args,
        { allow: [], deny: [], ask: [] },
        process.cwd(),
      ).decision,
    ).toBe("ask");
  }
  permissionMode.setMode("standard");
  expect(
    checkPermission(
      "Task",
      args,
      { allow: [], deny: ["Task"], ask: [] },
      process.cwd(),
    ).decision,
  ).toBe("deny");
});

test.each(["letta", "default", "codex"] as const)(
  "%s exposes Agent without dedicated memory tools",
  async (toolsetPreference) => {
    const prepared = await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference,
    });
    const names = prepared.preparedToolContext.clientTools.map(
      (tool) => tool.name,
    );
    expect(names).toContain("Agent");
    expect(names).not.toContain("memory");
    expect(names).not.toContain("memory_apply_patch");
  },
);
