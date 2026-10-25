/**
 * Export scope: the one table that decides what goes into a package, plus the
 * traversal that turns it into entries.
 *
 * M0 holds the shape only; M2 fills `SCOPE_RULES` (21 include rules, 20 exclude
 * rules, aligned line by line with the requirement doc's appendix B) and the
 * walk. Explicit manifestations only — never iterate `APP_SUBDIRS`, because a
 * new app directory must not start being exported by accident.
 */

import type { SnapshotCliDeps, SnapshotScope } from "./types";

/** One include/exclude rule. `include: false` wins over any include. */
export interface ScopeRule {
  /** Package-relative glob, `/`-separated. */
  pattern: string;
  scope: SnapshotScope;
  include: boolean;
  /** Why this rule exists — printed in `--verbose` and kept next to the list. */
  reason: string;
}

/**
 * The scope table. Filled at M2 with the 21 include and 20 exclude rules.
 * Excluded paths are neither stat-ed nor read.
 */
export const SCOPE_RULES: ScopeRule[] = [];

/**
 * The two families of source root. `channels/`, `transcripts/` and the WhatsApp
 * auth files resolve from the literal home directory and do NOT honour
 * `HARUYUKI_HOME`; everything else resolves from the app home root. A test that
 * relocates only `HARUYUKI_HOME` must expect that split.
 */
export interface ScopeRoots {
  /** `appHomeRoot()` — honours `HARUYUKI_HOME`. */
  appHome: string;
  /** Local backend storage root (`LETTA_LOCAL_BACKEND_DIR`). */
  storageDir: string;
  /** Literal `homedir()` root for the paths that ignore `HARUYUKI_HOME`. */
  homedirRoot: string;
}

/** One collected source path, before it becomes a `SnapshotEntry`. */
export interface ScopeEntry {
  /** Package-relative path. */
  path: string;
  /** Absolute source path on this machine. */
  absolutePath: string;
  scope: SnapshotScope;
  kind: "file" | "dir";
  bytes: number;
}

export interface CollectEntriesOptions {
  /** Absolute project directory to include, when the caller passed one. */
  project?: string;
  /** Non-fatal observations (symlink followed, case collision…) for the manifest. */
  onWarning?: (message: string) => void;
}

/** Resolve the roots for this invocation, honouring the injected deps. */
export function resolveHomeRoots(deps?: SnapshotCliDeps): ScopeRoots {
  void deps;
  throw new Error("snapshot/scope.resolveHomeRoots: implemented at M2");
}

/**
 * Walk the explicit scope in package order:
 * `home/**` -> `local-backend/**` -> `project/**`, each sorted by UTF-8 byte
 * order so two exports of the same data produce the same entry list.
 *
 * `backups/` is always excluded, including from the pre-import backup itself,
 * so a backup can never nest inside the next one.
 */
export function collectEntries(
  roots: ScopeRoots,
  opts?: CollectEntriesOptions,
): AsyncGenerator<ScopeEntry> {
  void roots;
  void opts;
  throw new Error("snapshot/scope.collectEntries: implemented at M2");
}
