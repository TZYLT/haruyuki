import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { selectDefaultAgentModel } from "@/agent/defaults";
import { getDefaultModel } from "@/agent/model";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";

beforeEach(installRuntimeModelCatalogFixture);
afterEach(clearRuntimeModelCatalogFixture);

describe("selectDefaultAgentModel", () => {
  test("uses the caller's preferred model when it is available on self-hosted", () => {
    const result = selectDefaultAgentModel({
      preferredModel: "haiku",
      isSelfHosted: true,
      availableHandles: ["anthropic/claude-haiku-4-5"],
    });

    expect(result).toBe("anthropic/claude-haiku-4-5");
  });

  test("falls back to the first server-available handle on self-hosted", () => {
    const result = selectDefaultAgentModel({
      isSelfHosted: true,
      availableHandles: ["openai/gpt-5.6-sol", "anthropic/claude-haiku-4-5"],
    });

    expect(result).toBe("openai/gpt-5.6-sol");
  });

  test("prefers the catalog default when the server lists it", () => {
    const result = selectDefaultAgentModel({
      isSelfHosted: true,
      availableHandles: ["openai/gpt-5.6-sol", getDefaultModel()],
    });

    expect(result).toBe(getDefaultModel());
  });

  test("falls back when the preferred self-hosted model is unavailable", () => {
    const result = selectDefaultAgentModel({
      preferredModel: "gpt-5",
      isSelfHosted: true,
      availableHandles: ["openai/gpt-5.6-sol", "anthropic/claude-haiku-4-5"],
    });

    expect(result).toBe("openai/gpt-5.6-sol");
  });

  test("keeps the preferred self-hosted handle when model availability cannot be fetched", () => {
    const result = selectDefaultAgentModel({
      preferredModel: "anthropic/claude-haiku-4-5",
      isSelfHosted: true,
    });

    expect(result).toBe("anthropic/claude-haiku-4-5");
  });

  test("passes through the preferred model on cloud", () => {
    const result = selectDefaultAgentModel({
      preferredModel: "haiku",
      isSelfHosted: false,
      availableHandles: ["openai/gpt-5.6-sol"],
    });

    expect(result).toBe("anthropic/claude-haiku-4-5");
  });
});
