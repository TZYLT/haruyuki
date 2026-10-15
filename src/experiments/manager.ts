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
      "Render the interactive TUI with the new full-screen shell (viewport, key and mouse handling, panels) instead of the append-style shell. Off by default while the new shell is being built.",
    envVar: "HARUYUKI_UI_V2",
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

    const envEnabled = definition.envVar
      ? isEnabledToggle(process.env[definition.envVar])
      : false;

    return {
      ...definition,
      enabled: envEnabled,
      source: envEnabled ? "env" : "default",
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
