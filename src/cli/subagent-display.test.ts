import { describe, expect, test } from "bun:test";
import {
  formatToolArgs,
  getSubagentModelDisplay,
} from "@/cli/helpers/subagent-display";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

setupRuntimeModelCatalogFixture();

describe("getSubagentModelDisplay", () => {
  test("formats known model IDs using short labels", () => {
    const display = getSubagentModelDisplay("haiku");
    expect(display).toEqual({
      label: "Haiku 4.5",
      isByokProvider: false,
      isOpenAICodexProvider: false,
    });
  });

  test("formats non-BYOK handles using short labels", () => {
    const display = getSubagentModelDisplay("anthropic/claude-haiku-4-5");
    expect(display).toEqual({
      label: "Haiku 4.5",
      isByokProvider: false,
      isOpenAICodexProvider: false,
    });
  });

  test("marks lc-* handles as BYOK", () => {
    const display = getSubagentModelDisplay("lc-anthropic/claude-haiku-4-5");
    expect(display).toEqual({
      label: "Haiku 4.5",
      isByokProvider: true,
      isOpenAICodexProvider: false,
    });
  });

  test("marks chatgpt-plus-pro handles as BYOK", () => {
    const display = getSubagentModelDisplay("chatgpt-plus-pro/gpt-5.2-codex");
    expect(display).toEqual({
      label: "gpt-5.2-codex",
      isByokProvider: true,
      isOpenAICodexProvider: true,
    });
  });
});

describe("formatToolArgs", () => {
  test("renders up to two entries as quoted key/value pairs", () => {
    expect(formatToolArgs('{"file_path":"/tmp/a.md","limit":10}')).toBe(
      'file_path: "/tmp/a.md", limit: "10"',
    );
  });

  test("drops entries whose value is null or undefined, and takes only two", () => {
    expect(formatToolArgs('{"a":null,"b":1,"c":2,"d":3}')).toBe(
      'b: "1", c: "2"',
    );
  });

  test("truncates a long value to 47 characters plus an ellipsis", () => {
    const long = "x".repeat(60);
    expect(formatToolArgs(`{"path":"${long}"}`)).toBe(
      `path: "${"x".repeat(47)}..."`,
    );
  });

  test("renders nothing for arguments that cannot be parsed", () => {
    // The args reach this as a string from the stream; a render pass must not throw.
    expect(formatToolArgs("not json at all")).toBe("");
    expect(formatToolArgs("null")).toBe("");
    expect(formatToolArgs("{}")).toBe("");
    expect(formatToolArgs("[]")).toBe("");
  });

  test("a JSON string payload is enumerated by index, as Object.entries does", () => {
    // Odd, and deliberately pinned: it is what the expanded tool row painted
    // before this helper moved out of the component.
    expect(formatToolArgs('"abc"')).toBe('0: "a", 1: "b"');
  });
});
