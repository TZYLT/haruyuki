/**
 * The two TUI seams that raise a recall face rather than printing (48-4 D-05,
 * D-16).
 *
 * Both live outside the pinned submit hook for exactly this reason: the rules
 * they encode — which spelling gets a face, and what the command row says — are
 * assertions about a seam, not about a 2.9k-line callback. A shell that omits
 * them keeps the printed answer, which is what headless and the CLI rely on.
 */
import { describe, expect, test } from "bun:test";
import {
  embeddingConfigFaceOpener,
  isRecallOverlayCommand,
  openRecallEmbeddingConfig,
  RECALL_EMBEDDING_CONFIG_COMMAND,
  RECALL_EMBEDDING_CONFIG_OVERLAY,
} from "@/cli/app/recall-config-overlay";

describe("isRecallOverlayCommand", () => {
  test("the two bare entrances raise the picker", () => {
    expect(isRecallOverlayCommand("/recall")).toBe(true);
    expect(isRecallOverlayCommand("/recall config")).toBe(true);
    // The registry splits on any run of spaces, so these are the same commands.
    expect(isRecallOverlayCommand("  /recall config  ")).toBe(true);
    expect(isRecallOverlayCommand("/recall    config")).toBe(true);
  });

  test("every value spelling keeps its printed answer", () => {
    for (const input of [
      "/recall config timeout",
      "/recall config timeout 500",
      "/recall config weight 0.4",
      "/recall status",
      "/recall now ledger",
      "/recall embedding config",
      "recall config",
    ]) {
      expect({ input, face: isRecallOverlayCommand(input) }).toEqual({
        input,
        face: false,
      });
    }
  });
});

describe("the embedding config face", () => {
  test("opens under its own id with the row's opening and dismiss copy", () => {
    const calls: unknown[][] = [];
    const opened = openRecallEmbeddingConfig((...args) => {
      calls.push(args);
    });
    expect(opened).toBe(true);
    expect(calls).toEqual([
      [
        RECALL_EMBEDDING_CONFIG_OVERLAY,
        RECALL_EMBEDDING_CONFIG_COMMAND,
        "Opening vector recall build settings...",
        "Vector recall build settings dismissed",
      ],
    ]);
  });

  test("the submit seam's opener reports that this shell has the face", () => {
    let raised = 0;
    const openConfig = embeddingConfigFaceOpener(() => {
      raised += 1;
    });
    expect(openConfig()).toBe(true);
    expect(openConfig()).toBe(true);
    expect(raised).toBe(2);
  });
});
