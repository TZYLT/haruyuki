import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Single source of truth for the harness state directory (`~/.haruyuki`) and the
 * names of everything inside it.
 *
 * Why this module exists: the directory name used to be a bare `".letta"`
 * literal in ~46 non-test files, so the rename had no single point of control.
 * `HARUYUKI_HOME` did override the root, but only two call sites read it. Resolve
 * every harness path through the helpers here so the name (and the override)
 * really is global.
 *
 * Layer: `utils/` (bottom). `backend/` owns the stores and `permissions/` builds
 * the sandbox policy, but `permissions/` sits below `backend/` and cannot import
 * it, so the shared path vocabulary has to live underneath both.
 */

/** Directory name of the harness root, as created under the user's home dir. */
export const APP_DIR_NAME = ".haruyuki";

/** Env override for the harness root. When set, it replaces `~/.haruyuki` outright. */
export const APP_HOME_ENV = "HARUYUKI_HOME";

/** Name of the repo-local ignore file, e.g. `<repo>/.haruyuki/.haruyukiignore`. */
export const APP_IGNORE_FILE_NAME = ".haruyukiignore";

/** Directory name of the legacy project-level skills dir (`.skills`). */
export const LEGACY_SKILLS_DIR_NAME = ".skills";

/**
 * Home directory used by path resolution: `HOME`, then `USERPROFILE`, then
 * `os.homedir()`.
 *
 * The env vars come first because several call sites already resolved home that
 * way and tests override `HOME` per case; `os.homedir()` is the fallback for
 * processes that only have the OS-level value.
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

/** `".haruyuki"` — for the few places that need the name as a path segment. */
export function appHomeDirName(): string {
  return APP_DIR_NAME;
}

/** Directory names inside the harness root. */
export const APP_SUBDIRS = {
  agents: "agents",
  artifacts: "artifacts",
  bin: "bin",
  cache: "cache",
  channels: "channels",
  commands: "commands",
  extensions: "extensions",
  logs: "logs",
  modCache: "mod-cache",
  mods: "mods",
  plans: "plans",
  skills: "skills",
  transcripts: "transcripts",
  /** Per-turn usage ledger (`usage/ledger.jsonl`). Numbers only, no content. */
  usage: "usage",
  /**
   * The message history the toast band writes (`notifications/message-history.jsonl`).
   *
   * Its own directory rather than the usage ledger's, which `docs/38` §15.2 asks
   * for by saying "与用量台账同目录": what that ruling is about is the *mechanism*
   * (one JSONL file under the harness root, pruned lazily on read), and the two
   * files answer different questions — numbers about model usage, and a short
   * record of what the shell told the user. A reader of either should not have to
   * filter the other's lines out.
   */
  notifications: "notifications",
  viewers: "viewers",
  workflows: "workflows",
  worktrees: "worktrees",
  localBackend: "lc-local-backend",
  settingsFile: "settings.json",
  localSettingsFile: "settings.local.json",
  desktopPreferencesFile: "desktop_preferences.json",
} as const;

/**
 * Explicit harness root: the `HARUYUKI_HOME` override, or `undefined` to mean
 * "under the home directory". Callers that must distinguish an explicit root
 * (for example settings precedence) use this; most code wants
 * {@link appHomeRoot}.
 */
export function getAppHomeOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[APP_HOME_ENV]?.trim() || undefined;
}

/**
 * Absolute harness root. Resolved on every call because both `HOME` and
 * `HARUYUKI_HOME` may change at runtime (the test preload redirects home).
 */
export function appHomeRoot(
  homeDir: string = resolveHomeDir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return getAppHomeOverride(env) ?? join(homeDir, APP_DIR_NAME);
}

export interface AppHomePathOptions {
  /** Home directory to resolve `~/.haruyuki` against. Defaults to {@link resolveHomeDir}. */
  homeDir?: string;
  /** Environment used for the harness-root override. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Absolute path of a named directory inside the harness root. */
export function appHomePath(
  segments: readonly string[],
  options: AppHomePathOptions = {},
): string {
  return join(
    appHomeRoot(
      options.homeDir ?? resolveHomeDir(),
      options.env ?? process.env,
    ),
    ...segments,
  );
}

/**
 * Absolute path of a named directory inside the *project*-level harness dir,
 * e.g. `<repo>/.haruyuki/settings.local.json`.
 */
export function projectAppHomePath(
  workingDirectory: string,
  ...segments: string[]
): string {
  return join(workingDirectory, APP_DIR_NAME, ...segments);
}
