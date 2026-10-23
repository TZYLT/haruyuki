import {
  getConversationTitleSettings,
  setConversationTitleSettings,
} from "@/cli/helpers/conversation-title";
import { settingsManager } from "@/settings-manager";
import type {
  ExperimentDefinition,
  ExperimentId,
  ExperimentSnapshot,
} from "./types";

/**
 * Environment spellings that mean "on".
 *
 * The set is deliberately narrow, and `memory-palace.test.ts` pins it: `off`,
 * `enabled` and every other word are *off*. Widening it is a decision about every
 * experiment's env var, not about one of them.
 */
const ENABLED_TOGGLE_VALUES = new Set(["1", "true", "yes"]);

/**
 * Spellings that plainly ask for "on" while `ENABLED_TOGGLE_VALUES` rejects them.
 *
 * The accepted set stays narrow (see above), so `on`/`enabled` are still off;
 * this set exists only so callers can say *why* a switch looks inert instead of
 * leaving the user to guess. Values that mean "off" (`0`, `false`, `off`) are
 * deliberately absent: they parse as off, which is what they ask for.
 */
const REJECTED_ON_VALUES = new Set(["on", "enable", "enabled", "y", "t"]);

export interface RejectedEnvToggle {
  id: ExperimentId;
  envVar: string;
  value: string;
  /**
   * What the experiment would be without the env var.
   *
   * The warning says what the value actually did, and on an experiment that is on
   * by default (`ui_v2`, since 2026-10-23) a rejected spelling does not leave it
   * off — it turns it **off**. Saying "stays off" there would be the opposite of
   * the truth.
   */
  defaultEnabled: boolean;
}

/**
 * Experiments whose env var holds a value that looks like "on" but is treated
 * as off. Pure read: no logging and no dedupe — the caller owns the hint and
 * decides how often to show it.
 */
export function findRejectedEnvToggles(): RejectedEnvToggle[] {
  const rejected: RejectedEnvToggle[] = [];

  for (const definition of EXPERIMENT_DEFINITIONS) {
    const envVar = definition.envVar;
    if (!envVar) {
      continue;
    }

    const raw = process.env[envVar];
    if (!raw) {
      continue;
    }

    const value = raw.trim();
    if (REJECTED_ON_VALUES.has(value.toLowerCase())) {
      rejected.push({
        id: definition.id,
        envVar,
        value,
        defaultEnabled: definition.defaultEnabled === true,
      });
    }
  }

  return rejected;
}

const EXPERIMENT_DEFINITIONS: readonly ExperimentDefinition[] = [
  {
    id: "artifacts",
    label: "artifacts",
    description:
      "Expose Haruyuki Desktop artifact creation tools and artifact UI surfaces.",
    envVar: "HARUYUKI_ARTIFACTS",
  },
  {
    id: "conversation_titles",
    label: "conversation titles",
    description: "Generate AI conversation titles automatically when possible.",
  },
  {
    id: "desktop_conversation_bootstrap",
    label: "conversation bootstrap",
    description:
      "Inject lightweight prior-conversation context into the first turn of brand-new Haruyuki conversations.",
  },
  {
    id: "diffs",
    label: "diffs",
    description:
      "Open browser-based worktree diff previews powered by Diffs from Pierre.",
  },
  {
    id: "memory_palace",
    label: "memory palace",
    description:
      "Opt-in memory palace experiment flag for disposable local listener runs. Disabled by default; no behavior changes unless consumers gate on it.",
    envVar: "HARUYUKI_MEMORY_PALACE",
  },
  {
    id: "tui_cron",
    label: "TUI cron scheduler",
    description:
      "Fire scheduled tasks from the CLI when the desktop app isn't running.",
  },
  {
    id: "ui_v2",
    label: "full-screen TUI",
    description:
      "Render the interactive TUI with the full-screen shell (viewport, tabs, rail, pages, mouse) instead of the append-style compatibility shell. On by default since 2026-10-23; turn it off here to get the append shell back.",
    envVar: "HARUYUKI_UI_V2",
    defaultEnabled: true,
  },
] as const;

function isEnabledToggle(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ENABLED_TOGGLE_VALUES.has(value.trim().toLowerCase());
}

/**
 * Every experiment id, in declaration order.
 *
 * Validators must derive from this rather than hand-copy the union: the copy in
 * the app-server inbound validator had already gone stale twice (a listed
 * experiment the client could not switch), which is how `ui_v2` came to be
 * visible over the protocol but rejected on `set_experiment`.
 */
export function experimentIds(): ExperimentId[] {
  return EXPERIMENT_DEFINITIONS.map((definition) => definition.id);
}

function getExperimentDefinition(id: ExperimentId): ExperimentDefinition {
  const definition = EXPERIMENT_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) {
    throw new Error(`Unknown experiment: ${id}`);
  }
  return definition;
}

class ExperimentManager {
  private getStoredOverrides(): Partial<Record<ExperimentId, boolean>> {
    try {
      return settingsManager.getSettings().experiments ?? {};
    } catch {
      return {};
    }
  }

  list(): ExperimentSnapshot[] {
    return EXPERIMENT_DEFINITIONS.map((definition) =>
      this.getSnapshot(definition.id),
    );
  }

  getSnapshot(id: ExperimentId): ExperimentSnapshot {
    const definition = getExperimentDefinition(id);

    if (id === "conversation_titles") {
      return {
        ...definition,
        enabled: getConversationTitleSettings().enabled,
        source: "default",
        override: null,
      };
    }

    const override = this.getStoredOverrides()[id];

    if (typeof override === "boolean") {
      return {
        ...definition,
        enabled: override,
        source: "override",
        override,
      };
    }

    const envVar = definition.envVar;
    const envRaw = envVar ? process.env[envVar] : undefined;
    // "Set at all" is the test, not "set to something we like": on an experiment
    // that is **on** by default (`ui_v2`), `HARUYUKI_UI_V2=0` is the only way a
    // script or a wrapper can ask for the append shell, so a set-but-unrecognised
    // value has to mean off rather than "fall through to the default".
    const envSet = envRaw !== undefined && envRaw.trim() !== "";
    const envEnabled = envSet ? isEnabledToggle(envRaw) : undefined;

    return {
      ...definition,
      enabled: envEnabled ?? definition.defaultEnabled ?? false,
      source: envEnabled === undefined ? "default" : "env",
      override: null,
    };
  }

  isEnabled(id: ExperimentId): boolean {
    return this.getSnapshot(id).enabled;
  }

  set(id: ExperimentId, enabled: boolean): ExperimentSnapshot {
    if (id === "conversation_titles") {
      setConversationTitleSettings(enabled);
      return this.getSnapshot(id);
    }

    const settings = settingsManager.getSettings();
    settingsManager.updateSettings({
      experiments: {
        ...(settings.experiments ?? {}),
        [id]: enabled,
      },
    });
    return this.getSnapshot(id);
  }

  toggle(id: ExperimentId): ExperimentSnapshot {
    const snapshot = this.getSnapshot(id);
    return this.set(id, !snapshot.enabled);
  }
}

export const experimentManager = new ExperimentManager();
