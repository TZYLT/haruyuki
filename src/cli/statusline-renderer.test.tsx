import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import { shouldRenderDefaultStatuslineRenderer } from "@/cli/display/statusline/default-renderer-activation";
import {
  buildDefaultStatuslineParts,
  getDefaultStatuslineRightColumnWidth,
} from "@/cli/display/statusline/renderers/Default";
import type { StatuslineUiContext } from "@/cli/display/statusline/types";
import { buildCliModContext } from "@/cli/helpers/cli-mod-context";
import type { ModContext } from "@/mods/types";

const DEFAULT_STATUSLINE_ACTIVATION = {
  hideFooterContent: false,
  isBashMode: false,
  modeActive: false,
  preemptionActive: false,
  transientHintActive: false,
};

function createStatuslineFixture({
  agentName = "Haruyuki",
  modelDisplayName = "GPT-5.5 (ChatGPT)",
  reasoningEffort = "high",
  rightColumnWidth = 80,
  terminalWidth = 120,
  toolset = "letta-code",
  usedContextTokens,
  contextWindowSize,
}: {
  agentName?: string;
  modelDisplayName?: string;
  reasoningEffort?: string;
  rightColumnWidth?: number;
  terminalWidth?: number;
  toolset?: string;
  usedContextTokens?: number;
  contextWindowSize?: number;
} = {}): { context: ModContext; ui: StatuslineUiContext } {
  return {
    context: buildCliModContext({
      agentName,
      currentDirectory: "/tmp/project",
      modelDisplayName,
      modelProvider: "chatgpt-plus-pro",
      projectDirectory: "/tmp/project",
      reasoningEffort,
      terminalWidth,
      toolset,
      usedContextTokens,
      contextWindowSize,
    }),
    ui: {
      isByokProvider: false,
      isOpenAICodexProvider: false,
      rightColumnWidth,
    },
  };
}

describe("statusline renderers", () => {
  test("CLI mod context exposes broad app state", () => {
    const { context } = createStatuslineFixture({ toolset: "computer" });

    expect(context.toolset).toBe("computer");
    expect(context.workspace.currentDir).toBe("/tmp/project");
    expect(context.workspace.projectDir).toBe("/tmp/project");
    expect(context.agent.name).toBe("Haruyuki");
    expect(context.model.displayName).toBe("GPT-5.5 (ChatGPT)");
    expect(context.model.provider).toBe("chatgpt-plus-pro");
    expect(context.model.reasoningEffort).toBe("high");
  });

  test("default renderer shows compact agent and model label", () => {
    const { context, ui } = createStatuslineFixture();
    const output = buildDefaultStatuslineParts(context, ui);

    expect(stripAnsi(String(output.right)).trim()).toBe(
      "Haruyuki · GPT-5.5 (ChatGPT)",
    );
  });

  test("default renderer does not render BYOK triangle indicator", () => {
    const { context, ui } = createStatuslineFixture({
      modelDisplayName: "kimi-k3",
    });
    ui.isByokProvider = true;
    const output = buildDefaultStatuslineParts(context, ui);

    expect(stripAnsi(String(output.right)).trim()).toBe("Haruyuki · kimi-k3");
  });

  test("default renderer omits reasoning and backend labels", () => {
    const { context, ui } = createStatuslineFixture({
      modelDisplayName: "No model selected",
    });
    const output = buildDefaultStatuslineParts(context, ui);

    expect(stripAnsi(String(output.right)).trim()).toBe(
      "Haruyuki · No model selected",
    );
  });

  test("the right column is a budget, not the row", () => {
    // It used to be `terminalWidth - 4` and the row drew a box that wide, which
    // left the left-hand slot four columns — no context chip, no `>> bash mode`,
    // no permission hint (the machine hit it on 2026-10-23). The budget the
    // composer already computes from the terminal is what the right column gets.
    const { context, ui } = createStatuslineFixture({
      agentName: "A Very Long Agent Name",
      modelDisplayName: "Claude",
      rightColumnWidth: 36,
      terminalWidth: 80,
    });

    expect(getDefaultStatuslineRightColumnWidth(context, ui)).toBe(36);
    const parts = buildDefaultStatuslineParts(context, ui);
    // It fits the budget, and the budget is what the row gives it — so a name that
    // does not fit is truncated (`A Very Lon…`) instead of squeezing the left slot
    // to four columns. The model keeps its share.
    expect(stripAnsi(parts.right)).toContain("A Very Lon");
    expect(stripAnsi(parts.right)).toContain("Claude");
    expect(stripAnsi(parts.right).trim().length).toBeLessThanOrEqual(36);
  });

  test("default renderer does not override safety preemptions", () => {
    expect(
      shouldRenderDefaultStatuslineRenderer({
        ...DEFAULT_STATUSLINE_ACTIVATION,
        preemptionActive: true,
      }),
    ).toBe(false);
  });

  test("default renderer does not override transient host hints", () => {
    expect(
      shouldRenderDefaultStatuslineRenderer({
        ...DEFAULT_STATUSLINE_ACTIVATION,
        transientHintActive: true,
      }),
    ).toBe(false);
  });

  test("the context chip is the row's default left content", () => {
    // The machine asked for this on 2026-10-23: the pair at the bottom by default,
    // with the permission switch taking that slot while it is shown and handing it
    // back afterwards. The slot is the one `>> bash mode` already uses.
    //
    // No `ctx` prefix either, by the same ruling — the sentence above keeps the
    // word for readability, the row does not (§4.32 修订).
    const { context, ui } = createStatuslineFixture({
      usedContextTokens: 84_000,
      contextWindowSize: 128_000,
    });
    expect(buildDefaultStatuslineParts(context, ui).leftLabel).toBe(
      "84k/128k(66%)",
    );
    // The right column is still `agent · model`, and does not carry the chip.
    expect(
      stripAnsi(String(buildDefaultStatuslineParts(context, ui).right)),
    ).not.toContain("84k");
  });

  test("the chip is blank when it has nothing to measure", () => {
    const unknown = createStatuslineFixture({ contextWindowSize: 128_000 });
    // No occupancy reported: an absent number must not become `0/128k(0%)`.
    expect(
      buildDefaultStatuslineParts(unknown.context, unknown.ui).leftLabel,
    ).toBeNull();
    // Zero is "nothing measured yet", the reading the rail itself gives it.
    const fresh = createStatuslineFixture({
      usedContextTokens: 0,
      contextWindowSize: 128_000,
    });
    expect(
      buildDefaultStatuslineParts(fresh.context, fresh.ui).leftLabel,
    ).toBeNull();
    // A count without a window is still a fact worth printing.
    const noWindow = createStatuslineFixture({ usedContextTokens: 84_000 });
    expect(
      buildDefaultStatuslineParts(noWindow.context, noWindow.ui).leftLabel,
    ).toBe("84k");
  });
});
