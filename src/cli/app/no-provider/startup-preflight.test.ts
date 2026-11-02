import { describe, expect, test } from "bun:test";
import {
  decideStartupPreflight,
  formatMissingProviderStartupError,
  formatNoProviderHeadlessError,
  formatNoProviderIgnoredFlagsWarning,
  ignoredNoProviderFlags,
  type StartupPreflightFacts,
} from "./startup-preflight";

/**
 * The pre-render guard's decision table (T-07, R-07.1 / R-07.6 / R-07.7).
 *
 * The pure half is tested exhaustively here because the failure it prevents —
 * "no provider, creates an agent anyway, dies into the alternate screen" — is a
 * branch, and the branch is what has to be right. The I/O half only gathers the
 * facts and applies the answer; G-6 exercises it end to end under an empty
 * `HARUYUKI_HOME`.
 */

const base: StartupPreflightFacts = {
  isHeadless: false,
  noProvider: false,
  ignoredNoProviderFlags: [],
  forceNewAgent: false,
  hasExplicitTarget: false,
  hasModels: false,
  hasConfiguredProvider: false,
  hasResumableAgent: false,
};

describe("decideStartupPreflight", () => {
  test("a fresh TUI start with no provider, no model and no agent reports before render", () => {
    const decision = decideStartupPreflight(base);
    expect(decision.kind).toBe("report-error");
  });

  test("the reported message carries both connection routes and the empty-state flag", () => {
    const message = formatMissingProviderStartupError();
    expect(message).toContain("/config connect");
    expect(message).toContain("haruyuki connect <provider>");
    expect(message).toContain("haruyuki --no-provider");
    // R-07.6: the old command name is not the preferred wording.
    expect(message).not.toContain("run /connect");
  });

  test("models present allows startup even without a provider-store entry", () => {
    expect(decideStartupPreflight({ ...base, hasModels: true }).kind).toBe(
      "allow",
    );
  });

  test("a configured provider allows startup even when discovery came back empty", () => {
    expect(
      decideStartupPreflight({ ...base, hasConfiguredProvider: true }).kind,
    ).toBe("allow");
  });

  test("an explicit target resumes instead of creating, so nothing is reported", () => {
    expect(
      decideStartupPreflight({ ...base, hasExplicitTarget: true }).kind,
    ).toBe("allow");
  });

  test("--new-agent still creates, so a resumable agent does not save it", () => {
    expect(
      decideStartupPreflight({
        ...base,
        forceNewAgent: true,
        hasResumableAgent: true,
      }).kind,
    ).toBe("report-error");
  });

  test("a resumable agent allows the normal path to run", () => {
    expect(
      decideStartupPreflight({ ...base, hasResumableAgent: true }).kind,
    ).toBe("allow");
  });

  test("--no-provider opens the empty state instead of reporting", () => {
    expect(decideStartupPreflight({ ...base, noProvider: true }).kind).toBe(
      "allow",
    );
  });

  test("--no-provider warns about flags it makes meaningless and continues", () => {
    const decision = decideStartupPreflight({
      ...base,
      noProvider: true,
      ignoredNoProviderFlags: ["--agent", "--model"],
    });
    expect(decision.kind).toBe("warn-and-continue");
    if (decision.kind !== "warn-and-continue") return;
    expect(decision.warning).toContain("--agent, --model");
    expect(decision.warning).toContain("ignored");
  });

  test("--no-provider is rejected in headless mode, where an agent is required", () => {
    const decision = decideStartupPreflight({
      ...base,
      isHeadless: true,
      noProvider: true,
    });
    expect(decision.kind).toBe("report-error");
    if (decision.kind !== "report-error") return;
    expect(decision.message).toBe(formatNoProviderHeadlessError());
    expect(decision.message).toContain("interactive");
  });

  test("headless startup keeps its own error semantics, never the TUI guard", () => {
    expect(decideStartupPreflight({ ...base, isHeadless: true }).kind).toBe(
      "allow",
    );
  });
});

describe("ignoredNoProviderFlags", () => {
  test("lists every flag --no-provider makes contradictory, and nothing else", () => {
    expect(
      ignoredNoProviderFlags({
        agent: "agent-1",
        conversation: "conv-1",
        name: "memo",
        resume: true,
        "new-agent": true,
        new: true,
        model: "deepseek/deepseek-chat",
      }),
    ).toEqual([
      "--agent",
      "--conversation",
      "--name",
      "--resume",
      "--new-agent",
      "--new",
      "--model",
    ]);

    expect(ignoredNoProviderFlags({ "no-provider": true })).toEqual([]);
  });

  test("the warning names the flags once and stays one plain-text block", () => {
    const singular = formatNoProviderIgnoredFlagsWarning(["--agent"]);
    expect(singular).toContain("--agent is ignored");
    const plural = formatNoProviderIgnoredFlagsWarning(["--agent", "--model"]);
    expect(plural).toContain("--agent, --model are ignored");
    expect(plural.split("\n")).toHaveLength(2);
  });
});
