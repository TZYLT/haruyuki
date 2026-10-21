// src/permissions/loader.ts
// Load and merge permission settings from hierarchical sources

import { createHash } from "node:crypto";
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  APP_SUBDIRS,
  appHomeDirName,
  appHomePath,
  projectAppHomePath,
} from "@/utils/app-paths";
import { exists, readFile, writeFile } from "@/utils/fs.js";
import { migratePermissionMode } from "./mode";
import {
  normalizePermissionRule,
  permissionRulesEquivalent,
} from "./rule-normalization";
import type { PermissionRules, PermissionRuleType } from "./types";

type SettingsPermissions = Omit<PermissionRules, "mode"> & {
  mode?: string;
};

type SettingsFile = {
  permissions?: SettingsPermissions;
  [key: string]: unknown;
};

type UserSettingsPathsOptions = {
  homeDir?: string;
  xdgConfigHome?: string;
};

type FileSignature =
  | {
      exists: true;
      mtimeMs: number;
      size: number;
      hash: string;
    }
  | { exists: false };

type PermissionCacheEntry = {
  permissions: PermissionRules;
  sources: string[];
  signatures: Map<string, FileSignature>;
};

const permissionCache = new Map<string, PermissionCacheEntry>();
const watchers = new Map<string, FSWatcher>();

export function getUserSettingsPaths(options: UserSettingsPathsOptions = {}): {
  canonical: string;
  legacy: string;
} {
  const homeDir = options.homeDir || homedir();
  const xdgConfigHome =
    options.xdgConfigHome ||
    process.env.XDG_CONFIG_HOME ||
    join(homeDir, ".config");

  return {
    canonical: appHomePath([APP_SUBDIRS.settingsFile], { homeDir: homeDir }),
    legacy: join(xdgConfigHome, "letta", "settings.json"),
  };
}

function getPermissionSourcePaths(workingDirectory: string): string[] {
  const { canonical: userSettingsPath, legacy: legacyUserSettingsPath } =
    getUserSettingsPaths();
  return [
    legacyUserSettingsPath, // User legacy
    userSettingsPath, // User (canonical)
    projectAppHomePath(workingDirectory, APP_SUBDIRS.settingsFile), // Project
    projectAppHomePath(workingDirectory, APP_SUBDIRS.localSettingsFile), // Local
  ];
}

function getFileSignature(path: string): FileSignature {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return { exists: false };
    }
    return {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  } catch {
    return { exists: false };
  }
}

function getFileSignatures(paths: string[]): Map<string, FileSignature> {
  const signatures = new Map<string, FileSignature>();
  for (const path of paths) {
    signatures.set(path, getFileSignature(path));
  }
  return signatures;
}

function signaturesEqual(
  a: FileSignature | undefined,
  b: FileSignature | undefined,
): boolean {
  if (!a || !b) return false;
  if (!a.exists || !b.exists) return a.exists === b.exists;
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.hash === b.hash;
}

function cachedEntryMatchesSources(
  entry: PermissionCacheEntry,
  sources: string[],
  signatures: Map<string, FileSignature>,
): boolean {
  if (entry.sources.length !== sources.length) {
    return false;
  }
  for (let i = 0; i < sources.length; i += 1) {
    if (entry.sources[i] !== sources[i]) {
      return false;
    }
  }
  for (const source of sources) {
    if (
      !signaturesEqual(entry.signatures.get(source), signatures.get(source))
    ) {
      return false;
    }
  }
  return true;
}

function clonePermissions(permissions: PermissionRules): PermissionRules {
  const cloned: PermissionRules = {
    allow: [...(permissions.allow || [])],
    deny: [...(permissions.deny || [])],
    ask: [...(permissions.ask || [])],
    alwaysAsk: [...(permissions.alwaysAsk || [])],
    additionalDirectories: [...(permissions.additionalDirectories || [])],
  };
  if (permissions.mode) {
    cloned.mode = permissions.mode;
  }
  return cloned;
}

function invalidatePermissionSource(sourcePath: string): void {
  for (const [cacheKey, entry] of permissionCache) {
    if (entry.sources.includes(sourcePath)) {
      permissionCache.delete(cacheKey);
    }
  }
}

function invalidatePermissionSourcesInDirectory(directoryPath: string): void {
  for (const [cacheKey, entry] of permissionCache) {
    if (entry.sources.some((source) => dirname(source) === directoryPath)) {
      permissionCache.delete(cacheKey);
    }
  }
}

function shouldStartPermissionWatchers(): boolean {
  // Unit tests still validate signatures on every load. Avoid long-lived
  // fs.watch handles there, because Bun/macOS runners can hang the worker even
  // with non-persistent watchers.
  return (
    process.env.NODE_ENV !== "test" &&
    process.env.HARUYUKI_DISABLE_PERMISSION_WATCHERS !== "1"
  );
}

function watchPath(path: string, onChange: () => void): void {
  if (watchers.has(path) || !exists(path)) {
    return;
  }

  try {
    const watcher = watch(path, { persistent: false }, onChange);
    watcher.unref?.();
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(path);
      onChange();
    });
    watchers.set(path, watcher);
  } catch {
    // fs.watch can fail on some filesystems; loadPermissions still validates
    // file signatures on every call, so missed watchers only cost one stat.
  }
}

function ensurePermissionWatchers(sources: string[]): void {
  if (!shouldStartPermissionWatchers()) {
    return;
  }

  for (const source of sources) {
    watchPath(source, () => invalidatePermissionSource(source));

    const directoryPath = dirname(source);
    watchPath(directoryPath, () =>
      invalidatePermissionSourcesInDirectory(directoryPath),
    );
  }
}

export function resetPermissionLoaderCacheForTests(): void {
  permissionCache.clear();
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
}

/**
 * Load permissions from all settings files and merge them hierarchically.
 *
 * Precedence (highest to lowest):
 * 1. Local project settings (.haruyuki/settings.local.json)
 * 2. Project settings (.haruyuki/settings.json)
 * 3. User settings (~/.haruyuki/settings.json)
 * 4. Legacy user settings (~/.config/haruyuki/settings.json)
 *
 * Rules are merged by concatenating arrays (more specific settings add to broader ones)
 */
export async function loadPermissions(
  workingDirectory: string = process.cwd(),
): Promise<PermissionRules> {
  const normalizedWorkingDirectory = resolve(workingDirectory);
  const sources = getPermissionSourcePaths(normalizedWorkingDirectory);
  const signatures = getFileSignatures(sources);
  const cacheKey = normalizedWorkingDirectory;
  const cached = permissionCache.get(cacheKey);

  if (cached && cachedEntryMatchesSources(cached, sources, signatures)) {
    ensurePermissionWatchers(sources);
    return clonePermissions(cached.permissions);
  }

  const merged: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    alwaysAsk: [],
    additionalDirectories: [],
  };

  for (const settingsPath of sources) {
    try {
      if (exists(settingsPath)) {
        const content = await readFile(settingsPath);
        const settings = JSON.parse(content) as SettingsFile;
        if (settings.permissions) {
          mergePermissions(merged, settings.permissions);
        }
      }
    } catch (_error) {
      // Silently skip files that can't be parsed
      // (user might have invalid JSON)
    }
  }

  permissionCache.set(cacheKey, {
    permissions: clonePermissions(merged),
    sources,
    signatures,
  });
  ensurePermissionWatchers(sources);

  return clonePermissions(merged);
}

export async function loadPermissionMode(
  workingDirectory: string = process.cwd(),
): Promise<PermissionRules["mode"] | null> {
  const permissions = await loadPermissions(workingDirectory);
  return permissions.mode ?? null;
}

/**
 * Merge permission rules by concatenating arrays
 */
function mergePermissions(
  target: PermissionRules,
  source: SettingsPermissions,
): void {
  if (typeof source.mode === "string") {
    const mode = migratePermissionMode(source.mode);
    if (mode) {
      target.mode = mode;
    }
  }
  if (source.allow) {
    target.allow = mergeRuleList(target.allow, source.allow);
  }
  if (source.deny) {
    target.deny = mergeRuleList(target.deny, source.deny);
  }
  if (source.ask) {
    target.ask = mergeRuleList(target.ask, source.ask);
  }
  if (source.alwaysAsk) {
    target.alwaysAsk = mergeRuleList(target.alwaysAsk, source.alwaysAsk);
  }
  if (source.additionalDirectories) {
    target.additionalDirectories = [
      ...(target.additionalDirectories || []),
      ...source.additionalDirectories,
    ];
  }
}

function mergeRuleList(
  existing: string[] | undefined,
  incoming: string[],
): string[] {
  const merged = [...(existing || [])];
  for (const rule of incoming) {
    if (!merged.some((current) => permissionRulesEquivalent(current, rule))) {
      merged.push(rule);
    }
  }
  return merged;
}

/**
 * Save a permission rule to a specific scope
 */
export async function savePermissionRule(
  rule: string,
  ruleType: PermissionRuleType,
  scope: "project" | "local" | "user",
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const normalizedWorkingDirectory = resolve(workingDirectory);

  // Determine settings file path based on scope
  let settingsPath: string;
  switch (scope) {
    case "user":
      settingsPath = getUserSettingsPaths().canonical;
      break;
    case "project":
      settingsPath = projectAppHomePath(
        normalizedWorkingDirectory,
        APP_SUBDIRS.settingsFile,
      );
      break;
    case "local":
      settingsPath = projectAppHomePath(
        normalizedWorkingDirectory,
        APP_SUBDIRS.localSettingsFile,
      );
      break;
  }

  // Load existing settings
  let settings: SettingsFile = {};
  try {
    if (exists(settingsPath)) {
      const content = await readFile(settingsPath);
      settings = JSON.parse(content) as SettingsFile;
    }
  } catch (_error) {
    // Start with empty settings if file doesn't exist or is invalid
  }

  // Initialize permissions if needed
  if (!settings.permissions) {
    settings.permissions = {};
  }
  if (!settings.permissions[ruleType]) {
    settings.permissions[ruleType] = [];
  }

  const normalizedRule = normalizePermissionRule(rule);

  // Add rule if not already present (canonicalized comparison for alias/path variants)
  if (
    !settings.permissions[ruleType].some((existingRule) =>
      permissionRulesEquivalent(existingRule, normalizedRule),
    )
  ) {
    settings.permissions[ruleType].push(normalizedRule);
  }

  // Save settings
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  invalidatePermissionSource(settingsPath);

  // If saving to .haruyuki/settings.local.json, ensure it's gitignored
  if (scope === "local") {
    await ensureLocalSettingsIgnored(normalizedWorkingDirectory);
  }
}

/**
 * Remove a permission rule from a specific scope.
 *
 * The counterpart of `savePermissionRule`, and it exists for the same reason: the
 * settings page can add and drop rules in place (《38》§12.6), and hand-editing
 * JSON from a UI would need every structural rule this file already holds — which
 * key, which scope file, invalidating the cache, and keeping
 * `.haruyuki/settings.local.json` out of git for the local scope.
 *
 * Returns `true` only when a rule was actually removed: a merged list shows rules
 * from other scopes too, so the caller has to be able to tell "deleted here" from
 * "this scope never had it" and say which scope it searched. Canonicalized
 * comparison means a rule that was typed differently when saved still matches.
 */
export async function removePermissionRule(
  rule: string,
  ruleType: PermissionRuleType,
  scope: "project" | "local" | "user",
  workingDirectory: string = process.cwd(),
): Promise<boolean> {
  const normalizedWorkingDirectory = resolve(workingDirectory);
  let settingsPath: string;
  switch (scope) {
    case "user":
      settingsPath = getUserSettingsPaths().canonical;
      break;
    case "project":
      settingsPath = projectAppHomePath(
        normalizedWorkingDirectory,
        APP_SUBDIRS.settingsFile,
      );
      break;
    case "local":
      settingsPath = projectAppHomePath(
        normalizedWorkingDirectory,
        APP_SUBDIRS.localSettingsFile,
      );
      break;
  }

  let settings: SettingsFile = {};
  try {
    if (exists(settingsPath)) {
      const content = await readFile(settingsPath);
      settings = JSON.parse(content) as SettingsFile;
    }
  } catch (_error) {
    return false;
  }

  const rules = settings.permissions?.[ruleType];
  if (!Array.isArray(rules) || rules.length === 0) return false;

  const target = normalizePermissionRule(rule);
  const remaining = rules.filter(
    (existing) => !permissionRulesEquivalent(existing, target),
  );
  if (remaining.length === rules.length) return false;

  if (remaining.length === 0) {
    delete settings.permissions?.[ruleType];
  } else if (settings.permissions) {
    settings.permissions[ruleType] = remaining;
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  invalidatePermissionSource(settingsPath);

  if (scope === "local") {
    await ensureLocalSettingsIgnored(normalizedWorkingDirectory);
  }
  return true;
}

/**
 * Ensure .haruyuki/settings.local.json is in .gitignore
 */
async function ensureLocalSettingsIgnored(
  workingDirectory: string,
): Promise<void> {
  const gitignorePath = join(workingDirectory, ".gitignore");
  const pattern = `${appHomeDirName()}/${APP_SUBDIRS.localSettingsFile}`;

  try {
    let content = "";
    if (exists(gitignorePath)) {
      content = await readFile(gitignorePath);
    }

    // Check if pattern already exists
    if (!content.includes(pattern)) {
      // Add pattern to gitignore
      const newContent = `${
        content + (content.endsWith("\n") ? "" : "\n") + pattern
      }\n`;
      await writeFile(gitignorePath, newContent);
    }
  } catch (_error) {
    // Silently fail if we can't update .gitignore
    // (might not be a git repo)
  }
}
