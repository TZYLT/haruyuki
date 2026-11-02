// src/hooks/loader.ts
// Loads and matches hooks from settings-manager

import { homedir } from "node:os";
import { resolve } from "node:path";
import { settingsManager } from "@/settings-manager";
import { APP_DIR_NAME, APP_SUBDIRS, appHomePath } from "@/utils/app-paths";
import { debugLog } from "@/utils/debug";
import {
  type HookCommand,
  type HookEvent,
  type HookMatcher,
  type HooksConfig,
  isPromptHook,
  isToolEvent,
  type SimpleHookEvent,
  type SimpleHookMatcher,
  supportsPromptHooks,
  type ToolHookEvent,
} from "./types";

/**
 * Clear hooks cache - kept for API compatibility with existing callers.
 */
export function clearHooksCache(): void {
  // Settings-manager handles caching
}

/**
 * Check whether project settings path collides with global settings path.
 *
 * When cwd is HOME, both resolve to ~/.haruyuki/settings.json. In that case,
 * treat project hooks as empty so global hooks don't get merged twice.
 */
function isProjectSettingsPathCollidingWithGlobal(
  workingDirectory: string,
): boolean {
  const home = process.env.HOME || homedir();
  const globalSettingsPath = appHomePath([APP_SUBDIRS.settingsFile], {
    homeDir: home,
  });
  const projectSettingsPath = resolve(
    workingDirectory,
    APP_DIR_NAME,
    APP_SUBDIRS.settingsFile,
  );
  return globalSettingsPath === projectSettingsPath;
}

/**
 * Load global hooks configuration from ~/.haruyuki/settings.json
 * Uses settings-manager cache (loaded at app startup)
 */
export function loadGlobalHooks(): HooksConfig {
  try {
    return settingsManager.getSettings().hooks || {};
  } catch (error) {
    // Settings not initialized yet
    debugLog("hooks", "loadGlobalHooks: Settings not initialized yet", error);
    return {};
  }
}

/**
 * Load project hooks configuration from .haruyuki/settings.json
 * Uses settings-manager cache
 */
export async function loadProjectHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  // Avoid reading global settings as project settings when cwd is HOME.
  if (isProjectSettingsPathCollidingWithGlobal(workingDirectory)) {
    return {};
  }

  try {
    // Ensure project settings are loaded
    try {
      settingsManager.getProjectSettings(workingDirectory);
    } catch {
      await settingsManager.loadProjectSettings(workingDirectory);
    }
    return settingsManager.getProjectSettings(workingDirectory)?.hooks || {};
  } catch (error) {
    // Settings not available
    debugLog("hooks", "loadProjectHooks: Settings not available", error);
    return {};
  }
}

/**
 * Load project-local hooks configuration from .haruyuki/settings.local.json
 * Uses settings-manager cache
 */
export async function loadProjectLocalHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  try {
    // Ensure local project settings are loaded
    try {
      settingsManager.getLocalProjectSettings(workingDirectory);
    } catch {
      await settingsManager.loadLocalProjectSettings(workingDirectory);
    }
    return (
      settingsManager.getLocalProjectSettings(workingDirectory)?.hooks || {}
    );
  } catch (error) {
    // Settings not available
    debugLog("hooks", "loadProjectLocalHooks: Settings not available", error);
    return {};
  }
}

/**
 * Merge hooks configurations
 * Priority order: project-local > project > global
 * For each event, hooks are ordered by priority (local first, global last)
 */
export function mergeHooksConfigs(
  global: HooksConfig,
  project: HooksConfig,
  projectLocal: HooksConfig = {},
): HooksConfig {
  const merged: HooksConfig = {};
  const allEvents = new Set([
    ...Object.keys(global),
    ...Object.keys(project),
    ...Object.keys(projectLocal),
  ]) as Set<HookEvent>;

  for (const event of allEvents) {
    if (isToolEvent(event)) {
      // Tool events use HookMatcher[]
      const toolEvent = event as ToolHookEvent;
      const globalMatchers = (global[toolEvent] || []) as HookMatcher[];
      const projectMatchers = (project[toolEvent] || []) as HookMatcher[];
      const projectLocalMatchers = (projectLocal[toolEvent] ||
        []) as HookMatcher[];
      // Project-local runs first, then project, then global
      (merged as Record<ToolHookEvent, HookMatcher[]>)[toolEvent] = [
        ...projectLocalMatchers,
        ...projectMatchers,
        ...globalMatchers,
      ];
    } else {
      // Simple events use SimpleHookMatcher[] (same as HookMatcher but without matcher field)
      const simpleEvent = event as SimpleHookEvent;
      const globalMatchers = (global[simpleEvent] || []) as SimpleHookMatcher[];
      const projectMatchers = (project[simpleEvent] ||
        []) as SimpleHookMatcher[];
      const projectLocalMatchers = (projectLocal[simpleEvent] ||
        []) as SimpleHookMatcher[];
      // Project-local runs first, then project, then global
      (merged as Record<SimpleHookEvent, SimpleHookMatcher[]>)[simpleEvent] = [
        ...projectLocalMatchers,
        ...projectMatchers,
        ...globalMatchers,
      ];
    }
  }

  return merged;
}

/**
 * Load merged hooks configuration (global + project + project-local)
 */
export async function loadHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  const [global, project, projectLocal] = await Promise.all([
    Promise.resolve(loadGlobalHooks()),
    loadProjectHooks(workingDirectory),
    loadProjectLocalHooks(workingDirectory),
  ]);

  return mergeHooksConfigs(global, project, projectLocal);
}

/**
 * Check if a tool name matches a matcher pattern
 * Patterns:
 * - "*" or "": matches all tools
 * - "ToolName": exact match (simple alphanumeric strings)
 * - "Edit|Write": regex alternation, matches Edit or Write
 * - "Notebook.*": regex pattern, matches Notebook, NotebookEdit, etc.
 * - Any valid regex pattern is supported (case-sensitive)
 */
export function matchesTool(pattern: string, toolName: string): boolean {
  // Empty or "*" matches everything
  if (!pattern || pattern === "*") {
    return true;
  }

  // Treat pattern as regex (anchored to match full tool name)
  try {
    const regex = new RegExp(`^(?:${pattern})$`);
    return regex.test(toolName);
  } catch (error) {
    // Invalid regex, fall back to exact match
    debugLog(
      "hooks",
      `matchesTool: Invalid regex pattern "${pattern}", falling back to exact match`,
      error,
    );
    return pattern === toolName;
  }
}

/**
 * Filter hooks, removing prompt hooks from unsupported events with a warning
 */
function filterHooksForEvent(
  hooks: HookCommand[],
  event: HookEvent,
): HookCommand[] {
  const filtered: HookCommand[] = [];
  const promptHooksSupported = supportsPromptHooks(event);

  for (const hook of hooks) {
    if (isPromptHook(hook)) {
      if (!promptHooksSupported) {
        // Warn about unsupported prompt hook
        console.warn(
          `\x1b[33m[hooks] Warning: Prompt hooks are not supported for the ${event} event. ` +
            `Ignoring prompt hook.\x1b[0m`,
        );
        continue;
      }
    }
    filtered.push(hook);
  }

  return filtered;
}

/**
 * Get all hooks that match a specific event and tool name
 */
export function getMatchingHooks(
  config: HooksConfig,
  event: HookEvent,
  toolName?: string,
): HookCommand[] {
  if (isToolEvent(event)) {
    // Tool events use HookMatcher[] - need to match against tool name
    const matchers = config[event as ToolHookEvent] as
      | HookMatcher[]
      | undefined;
    if (!matchers || matchers.length === 0) {
      return [];
    }

    const hooks: HookCommand[] = [];
    for (const matcher of matchers) {
      if (!toolName || matchesTool(matcher.matcher, toolName)) {
        hooks.push(...matcher.hooks);
      }
    }
    return filterHooksForEvent(hooks, event);
  } else {
    // Simple events use SimpleHookMatcher[] - extract hooks from each matcher
    const matchers = config[event as SimpleHookEvent] as
      | SimpleHookMatcher[]
      | undefined;
    if (!matchers || matchers.length === 0) {
      return [];
    }

    const hooks: HookCommand[] = [];
    for (const matcher of matchers) {
      hooks.push(...matcher.hooks);
    }
    return filterHooksForEvent(hooks, event);
  }
}

/**
 * Check if there are any hooks configured for a specific event
 */
export function hasHooksForEvent(
  config: HooksConfig,
  event: HookEvent,
): boolean {
  if (isToolEvent(event)) {
    // Tool events use HookMatcher[]
    const matchers = config[event as ToolHookEvent] as
      | HookMatcher[]
      | undefined;
    if (!matchers || matchers.length === 0) {
      return false;
    }
    // Check if any matcher has hooks
    return matchers.some((m) => m.hooks && m.hooks.length > 0);
  } else {
    // Simple events use SimpleHookMatcher[]
    const matchers = config[event as SimpleHookEvent] as
      | SimpleHookMatcher[]
      | undefined;
    if (!matchers || matchers.length === 0) {
      return false;
    }
    // Check if any matcher has hooks
    return matchers.some((m) => m.hooks && m.hooks.length > 0);
  }
}

/**
 * Check if all hooks are disabled via hooks.disabled across settings levels.
 *
 * Precedence:
 * 1. If user has disabled: false → ENABLED (explicit user override)
 * 2. If user has disabled: true → DISABLED
 * 3. If project OR project-local has disabled: true → DISABLED
 * 4. Default → ENABLED
 */
export function areHooksDisabled(
  workingDirectory: string = process.cwd(),
): boolean {
  try {
    // Check user-level settings first (highest precedence)
    const userDisabled = settingsManager.getSettings().hooks?.disabled;
    if (userDisabled === false) {
      // User explicitly enabled - overrides project settings
      return false;
    }
    if (userDisabled === true) {
      // User explicitly disabled
      return true;
    }

    // User setting is undefined, check project-level settings
    try {
      const projectDisabled =
        settingsManager.getProjectSettings(workingDirectory)?.hooks?.disabled;
      if (projectDisabled === true) {
        return true;
      }
    } catch {
      // Project settings not loaded, skip
      debugLog(
        "hooks",
        "areHooksDisabled: Project settings not loaded, skipping",
      );
    }

    // Check project-local settings
    try {
      const localDisabled =
        settingsManager.getLocalProjectSettings(workingDirectory)?.hooks
          ?.disabled;
      if (localDisabled === true) {
        return true;
      }
    } catch {
      // Local project settings not loaded, skip
      debugLog(
        "hooks",
        "areHooksDisabled: Local project settings not loaded, skipping",
      );
    }

    return false;
  } catch {
    debugLog(
      "hooks",
      "areHooksDisabled: Failed to check hooks disabled status",
    );
    return false;
  }
}

/**
 * Hooks configured per settings layer, for a settings row (T-04 R-04.1).
 *
 * A count is all the panel shows: `/config hooks` owns the list, the matchers
 * and the editors, and reading it from here would duplicate them.
 */
export type HooksLayerSummary = {
  global: number;
  project: number;
  local: number;
  /** Any layer's `disabled` wins, with the user layer's explicit `false` first. */
  disabled: boolean;
};

/** Count the hook commands in one layer's config, across every event. */
function countHookCommands(config: HooksConfig): number {
  let count = 0;
  for (const [event, matchers] of Object.entries(config)) {
    // `disabled` is the one non-event key in the config.
    if (event === "disabled" || !Array.isArray(matchers)) continue;
    for (const matcher of matchers as Array<{ hooks?: readonly unknown[] }>) {
      count += matcher.hooks?.length ?? 0;
    }
  }
  return count;
}

/**
 * The three-layer hooks summary, from the settings manager's in-memory cache.
 *
 * Synchronous on purpose: the settings page calls this on every snapshot, so it
 * must not read a file or ask the backend (T-04's read contract). A layer that
 * is not loaded yet counts as empty rather than throwing — the row then says
 * what is in force this instant, and `/config hooks` is where the full answer
 * lives.
 */
export function summarizeHooks(
  workingDirectory: string = process.cwd(),
): HooksLayerSummary {
  let project: HooksConfig = {};
  let local: HooksConfig = {};
  try {
    project = settingsManager.getProjectSettings(workingDirectory)?.hooks ?? {};
  } catch (error) {
    debugLog("hooks", "summarizeHooks: Project settings not loaded", error);
  }
  try {
    local =
      settingsManager.getLocalProjectSettings(workingDirectory)?.hooks ?? {};
  } catch (error) {
    debugLog(
      "hooks",
      "summarizeHooks: Local project settings not loaded",
      error,
    );
  }
  return {
    global: countHookCommands(loadGlobalHooks()),
    project: countHookCommands(project),
    local: countHookCommands(local),
    disabled: areHooksDisabled(workingDirectory),
  };
}

/**
 * Convenience function to load hooks and get matching ones for an event
 */
export async function getHooksForEvent(
  event: HookEvent,
  toolName?: string,
  workingDirectory: string = process.cwd(),
): Promise<HookCommand[]> {
  // Check if all hooks are disabled
  if (areHooksDisabled(workingDirectory)) {
    return [];
  }

  const config = await loadHooks(workingDirectory);
  return getMatchingHooks(config, event, toolName);
}
