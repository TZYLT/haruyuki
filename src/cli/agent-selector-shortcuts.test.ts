import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENT_SELECTOR_TABS,
  getVisibleAgentSelectorTabs,
} from "@/cli/components/agent-selector-utils";
import { getPinnedAgentBackendMode } from "@/cli/helpers/pinned-agent-listing";

describe("agent selector shortcuts", () => {
  test("delete sits behind Shift+D, so a plain d is not destructive", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const footerPath = fileURLToPath(
      new URL("../cli/components/AgentSelectorFooter.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");
    const footerSource = readFileSync(footerPath, "utf-8");

    // The chord matcher lowercases both sides, so a `d` chord also matches a
    // bare `d`; the binding therefore has to check the letter itself. That guard
    // is the whole reason this is a source assertion and not a key one.
    expect(source).toContain('if (input !== "D") return "declined";');
    expect(source).toContain(
      'chords: [{ key: "d" }, { key: "d", shift: true }]',
    );
    expect(source).not.toContain('chords: [{ key: "d" }]');
    expect(footerSource).toContain("Shift+D delete");
  });

  test("pinned agent backend comes from agent id, not pin scope", () => {
    expect(
      getPinnedAgentBackendMode(
        "agent-local-c47c57d5-72c5-4f23-baea-3fb1d441273e",
      ),
    ).toBe("local");
    expect(
      getPinnedAgentBackendMode("agent-6b383e6f-f2df-43ed-ad88-8c832f1129d0"),
    ).toBe("api");
  });

  // The Cloud and Shared tabs are gone outright: both listed agents that live in
  // Letta Cloud, which this build has no backend for, so their branches in the
  // selector were unreachable. The tab ids are out of the union, which keeps the
  // compiler from letting them back in.
  test("offers only tabs this build can list", () => {
    const visible = getVisibleAgentSelectorTabs({
      showNewTab: true,
      hasLocalAgents: true,
    }).map((tab) => tab.id);

    expect(visible).toEqual(["pinned", "local", "new"]);
    expect(AGENT_SELECTOR_TABS.map((tab) => tab.id)).toEqual([
      "pinned",
      "local",
      "new",
    ]);
  });

  test("keeps one spacer after tab descriptions", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");

    expect(source).toContain("<Box height={1} />");
    expect(source).not.toContain("<Box height={2} />");
  });
});
