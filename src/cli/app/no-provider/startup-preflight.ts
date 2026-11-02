/**
 * T-07's **pre-render** half of the double guard (47-2 §1.6, R-07.1).
 *
 * The failure this replaces was silent: with no provider and no model, startup
 * walked into `ensureDefaultAgents` → `getDefaultModel()` → throw **after** Ink
 * had already entered the alternate screen, so the error text died with the
 * screen (R-07.2). Here the same condition is decided **before `render()`**:
 * plain stderr text plus a non-zero exit, and the terminal is never taken.
 *
 * The decision is deliberately conservative. It reports only the case it can
 * prove statically — no model catalog, no configured provider anywhere, and a
 * startup that would have to create an agent. Anything that might resume an
 * existing agent is left to the normal path, where the post-mount seam
 * (`failTuiStartup`) now catches whatever still fails.
 *
 * `--no-provider` is the opt-out: it skips the check and opens the empty state,
 * so the same empty `HARUYUKI_HOME` can be used to connect from inside the TUI.
 */

import { models } from "@/agent/model-catalog";
import { getBackend } from "@/backend";
import { listConfiguredPiProviders } from "@/backend/dev/pi-provider-registry";
import { listLocalProviderRecords } from "@/backend/local/local-provider-auth-store";
import {
  reportTuiStartupFailureBeforeRender,
  writeStartupFailureText,
} from "@/cli/app/startup/fail-tui-startup";
import type { CliParsedValues } from "@/cli/args";
import { settingsManager } from "@/settings-manager";

/**
 * What the decision needs to know. Facts are gathered by
 * `runTuiStartupPreflight`; the decision itself is pure so the branches are a
 * unit test instead of a rendered assertion.
 */
export interface StartupPreflightFacts {
  isHeadless: boolean;
  noProvider: boolean;
  /** Flags that contradict `--no-provider` and are therefore ignored. */
  ignoredNoProviderFlags: readonly string[];
  forceNewAgent: boolean;
  /** `--agent`, `--conversation`, `--name` or `--resume`: resume, never create. */
  hasExplicitTarget: boolean;
  hasModels: boolean;
  hasConfiguredProvider: boolean;
  hasResumableAgent: boolean;
}

export type StartupPreflightDecision =
  | { kind: "allow" }
  | { kind: "warn-and-continue"; warning: string }
  | { kind: "report-error"; message: string };

/** The error for a startup that cannot create an agent (R-07.1, R-07.6). */
export function formatMissingProviderStartupError(): string {
  return [
    "Error: No model provider is connected, so Haruyuki cannot create an agent.",
    "",
    "Connect a provider first:",
    "  • In the TUI:  /config connect   (choose a provider and paste its API key)",
    "  • In a shell:  haruyuki connect <provider>   (for example: haruyuki connect deepseek)",
    "",
    "Then start Haruyuki again. To open the TUI without a provider and connect",
    "from inside it, run: haruyuki --no-provider",
  ].join("\n");
}

/** `--no-provider` means "no agent and no model"; the others cannot apply. */
export function ignoredNoProviderFlags(values: CliParsedValues): string[] {
  const ignored: string[] = [];
  if (values.agent !== undefined) ignored.push("--agent");
  if (values.conversation !== undefined) ignored.push("--conversation");
  if (values.name !== undefined) ignored.push("--name");
  if (values.resume === true) ignored.push("--resume");
  if (values["new-agent"] === true) ignored.push("--new-agent");
  if (values.new === true) ignored.push("--new");
  if (values.model !== undefined) ignored.push("--model");
  return ignored;
}

/** R-07.7: say so instead of silently starting in a contradictory shape. */
export function formatNoProviderIgnoredFlagsWarning(
  flags: readonly string[],
): string {
  return [
    `Warning: --no-provider starts with no agent and no model, so ${flags.join(", ")} ${flags.length === 1 ? "is" : "are"} ignored.`,
    "Remove the flag(s), or drop --no-provider to use them.",
  ].join("\n");
}

export function formatNoProviderHeadlessError(): string {
  return [
    "Error: --no-provider is only supported in interactive mode.",
    "Headless startup needs an agent, so the flag cannot apply. Remove --no-provider.",
  ].join("\n");
}

export function decideStartupPreflight(
  facts: StartupPreflightFacts,
): StartupPreflightDecision {
  if (facts.noProvider) {
    if (facts.isHeadless) {
      return { kind: "report-error", message: formatNoProviderHeadlessError() };
    }
    if (facts.ignoredNoProviderFlags.length > 0) {
      return {
        kind: "warn-and-continue",
        warning: formatNoProviderIgnoredFlagsWarning(
          facts.ignoredNoProviderFlags,
        ),
      };
    }
    return { kind: "allow" };
  }

  // Headless keeps its existing error semantics: it reports its own failure
  // after loading, and R-07.1 is a TUI contract.
  if (facts.isHeadless) return { kind: "allow" };

  // A provider is configured (store or environment), even if model discovery
  // came back empty: that is a discovery problem, not "no provider", and the
  // post-mount seam reports it with the screen restored.
  if (facts.hasModels || facts.hasConfiguredProvider) return { kind: "allow" };

  // Explicit targets never auto-create an agent at startup.
  if (facts.hasExplicitTarget) return { kind: "allow" };

  // `--new-agent` always creates, so a resumable agent does not help it.
  if (facts.forceNewAgent) {
    return {
      kind: "report-error",
      message: formatMissingProviderStartupError(),
    };
  }

  if (facts.hasResumableAgent) return { kind: "allow" };

  return { kind: "report-error", message: formatMissingProviderStartupError() };
}

/** A configured provider, from the BYOK store or the environment. */
function hasConfiguredProvider(): boolean {
  try {
    if (listLocalProviderRecords().length > 0) return true;
  } catch {
    // An unreadable provider store is not proof of absence; env still counts.
  }
  try {
    return listConfiguredPiProviders(new Set()).length > 0;
  } catch {
    return false;
  }
}

function pageItems(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  if (page && typeof page === "object") {
    const candidate = page as {
      getPaginatedItems?: () => unknown[];
      items?: unknown[];
    };
    if (typeof candidate.getPaginatedItems === "function") {
      return candidate.getPaginatedItems();
    }
    if (Array.isArray(candidate.items)) return candidate.items;
  }
  return [];
}

/**
 * Whether the normal startup path could resume something instead of creating a
 * fresh agent. Any hint is enough to stay out of the way; the check exists to
 * avoid a false positive, not to resolve the target.
 */
async function hasResumableAgent(): Promise<boolean> {
  try {
    await settingsManager.loadLocalProjectSettings();
  } catch {
    // Fall through to the hints that do not need project settings.
  }

  try {
    if (settingsManager.getPinnedAgents().length > 0) return true;
  } catch {
    // No pinned list available; keep checking.
  }

  try {
    if (settingsManager.getLocalLastAgentId(process.cwd())) return true;
  } catch {
    // Local settings not loaded; the store check below still applies.
  }

  try {
    if (settingsManager.getLocalLastSession(process.cwd())?.agentId)
      return true;
  } catch {
    // Same.
  }

  try {
    const agents = pageItems(
      await getBackend().listAgents({ limit: 1 } as never),
    );
    return agents.length > 0;
  } catch {
    return false;
  }
}

/**
 * Run the pre-render guard. Called once from the entry point after flag parsing
 * and **before** `render()`: a `report-error` decision never returns.
 */
export async function runTuiStartupPreflight(options: {
  values: CliParsedValues;
  isHeadless: boolean;
}): Promise<void> {
  const { values, isHeadless } = options;
  const noProvider = values["no-provider"] === true;
  const ignoredFlags = noProvider ? ignoredNoProviderFlags(values) : [];
  const forceNewAgent = values["new-agent"] === true;
  const hasExplicitTarget =
    values.agent !== undefined ||
    values.conversation !== undefined ||
    values.name !== undefined ||
    values.resume === true;

  const hasModels = models.length > 0;
  const providerConfigured = hasConfiguredProvider();
  // The backend/settings probe is the only expensive fact, and only a startup
  // with nothing configured and nothing explicit depends on it.
  const needsResumeProbe =
    !noProvider &&
    !isHeadless &&
    !hasModels &&
    !providerConfigured &&
    !forceNewAgent &&
    !hasExplicitTarget;

  const decision = decideStartupPreflight({
    isHeadless,
    noProvider,
    ignoredNoProviderFlags: ignoredFlags,
    forceNewAgent,
    hasExplicitTarget,
    hasModels,
    hasConfiguredProvider: providerConfigured,
    hasResumableAgent: needsResumeProbe ? await hasResumableAgent() : true,
  });

  switch (decision.kind) {
    case "warn-and-continue":
      writeStartupFailureText(decision.warning);
      return;
    case "report-error":
      reportTuiStartupFailureBeforeRender(decision.message);
      return;
    case "allow":
      return;
  }
}
