import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_SETTINGS_GROUP_ID,
  embeddingSetCommand,
  embeddingSettingsDeepLink,
  formatSettingsDeepLink,
  parseSettingsDeepLinkPath,
  resolveSettingsDeepLink,
} from "@/cli/helpers/settings-deep-link";

/**
 * The shell-independent half of O-05: which page target a settings deep link
 * means, and the command a host without pages gets instead.
 */

describe("embedding deep-link targets", () => {
  test("the group target names the embedding settings group", () => {
    expect(embeddingSettingsDeepLink()).toEqual({
      page: "settings",
      group: "embedding",
    });
    expect(EMBEDDING_SETTINGS_GROUP_ID).toBe("embedding");
  });

  test("an item target names the row", () => {
    expect(embeddingSettingsDeepLink("recallEmbeddingWeight")).toEqual({
      page: "settings",
      group: "embedding",
      item: "recallEmbeddingWeight",
    });
  });
});

describe("deep-link paths", () => {
  test("round-trip group and item links", () => {
    for (const target of [
      embeddingSettingsDeepLink(),
      embeddingSettingsDeepLink("recallEmbeddingApiKey"),
    ]) {
      expect(parseSettingsDeepLinkPath(formatSettingsDeepLink(target))).toEqual(
        target,
      );
    }
  });

  test("formats as settings/<group>[/<item>]", () => {
    expect(formatSettingsDeepLink(embeddingSettingsDeepLink())).toBe(
      "settings/embedding",
    );
    expect(
      formatSettingsDeepLink(embeddingSettingsDeepLink("recallEmbeddingGpu")),
    ).toBe("settings/embedding/recallEmbeddingGpu");
  });

  test("refuses a link it cannot honour instead of guessing", () => {
    for (const path of [
      "",
      "embedding",
      "other/embedding",
      "settings",
      "settings/embedding/recallEmbeddingWeight/extra",
    ]) {
      expect(parseSettingsDeepLinkPath(path)).toBeNull();
    }
  });

  test("tolerates surrounding and doubled separators", () => {
    expect(parseSettingsDeepLinkPath("  /settings//embedding/  ")).toEqual({
      page: "settings",
      group: "embedding",
    });
  });
});

describe("host resolution", () => {
  const target = embeddingSettingsDeepLink("recallEmbeddingEnabled");

  test("the full-screen TUI raises the page target", () => {
    expect(resolveSettingsDeepLink({ target, host: "tui" })).toEqual({
      target,
      fallback: null,
    });
  });

  test("legacy and headless fall back to the set command", () => {
    expect(resolveSettingsDeepLink({ target, host: "legacy" })).toEqual({
      target: null,
      fallback: "/recall embedding on|off",
    });
    expect(resolveSettingsDeepLink({ target, host: "headless" })).toEqual({
      target: null,
      fallback: "haruyuki recall embedding on|off",
    });
  });

  test("a group link falls back to the embedding command face", () => {
    expect(
      resolveSettingsDeepLink({
        target: embeddingSettingsDeepLink(),
        host: "legacy",
      }),
    ).toEqual({ target: null, fallback: "/recall embedding" });
    expect(
      resolveSettingsDeepLink({
        target: embeddingSettingsDeepLink(),
        host: "headless",
      }),
    ).toEqual({ target: null, fallback: "haruyuki recall embedding status" });
  });

  test("a group with no known command stays unresolved", () => {
    expect(
      resolveSettingsDeepLink({
        target: { page: "settings", group: "unknown" },
        host: "legacy",
      }),
    ).toEqual({ target: null, fallback: null });
  });
});

describe("the set command table", () => {
  test("every editing row the schema owns has a fallback", () => {
    const items: ReadonlyArray<readonly [string, string]> = [
      ["recallEmbeddingEnabled", "/recall embedding on|off"],
      ["recallEmbeddingBackend", "/recall embedding connect"],
      ["recallEmbeddingModel", "/recall embedding connect"],
      ["recallEmbeddingEndpoint", "/recall embedding connect"],
      ["recallEmbeddingApiKey", "/recall embedding connect"],
      ["recallEmbeddingWeight", "/recall config weight <0..1>"],
      ["recallEmbeddingCandidateDepth", "/recall config depth <n>"],
      [
        "recallEmbeddingChunkTarget",
        "/recall embedding config chunk-target <tokens>",
      ],
      [
        "recallEmbeddingChunkMax",
        "/recall embedding config chunk-max <tokens>",
      ],
      [
        "recallEmbeddingChunkOverlap",
        "/recall embedding config chunk-overlap <tokens>",
      ],
      [
        "recallEmbeddingMaxChunksPerMessage",
        "/recall embedding config max-chunks <n>",
      ],
      ["recallEmbeddingThreads", "/recall embedding config threads <n>"],
      ["recallEmbeddingGpu", "/recall embedding config gpu auto|off"],
      ["recallEmbeddingQuantization", "/recall embedding connect"],
      ["recallEmbeddingKeepSpaces", "/recall embedding model"],
    ];
    for (const [item, expected] of items) {
      expect(embeddingSetCommand(item, "legacy")).toBe(expected);
      expect(
        embeddingSetCommand(item, "headless").startsWith("haruyuki recall"),
      ).toBe(true);
    }
  });

  test("an unknown row falls back to the group command", () => {
    expect(embeddingSetCommand("recallEmbeddingNope", "legacy")).toBe(
      "/recall embedding",
    );
    expect(embeddingSetCommand(undefined, "headless")).toBe(
      "haruyuki recall embedding status",
    );
  });
});
