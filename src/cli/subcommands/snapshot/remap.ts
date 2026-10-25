/**
 * Path remapping after an import: rewrite only the known structured fields.
 *
 * Never a global string replace: memory markdown, messages and transcripts keep
 * whatever paths they contain (requirement doc §5.9.5). Unreplaced path-shaped
 * fields are reported, not edited, so the user can see what still points at the
 * old machine.
 *
 * The only writable field is `settings.json`'s `sessionsByServer` bucket key
 * `local:<storage root>`. Everything else — `sessions.jsonl.project`, transcript
 * and memory body text — is listed as "not remapped" instead.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type SnapshotRemap, snapshotError } from "./types";

export interface RemapResult {
  remapped: SnapshotRemap[];
  /** Path-shaped fields this pass deliberately did not touch. */
  notRemapped: string[];
}

/** Prefix of the per-storage-root session bucket, see `getLocalBackendSettingsKey`. */
const LOCAL_BUCKET_PREFIX = "local:";

const SESSIONS_HISTORY_FILE = "sessions.jsonl";

function samePath(left: string, right: string): boolean {
  // Windows default filesystems are case-insensitive; the storage root is
  // compared the way the filesystem would, so `J:\Store` matches `j:\store`.
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** `path.resolve` for a non-empty string, or `null` when there is nothing to resolve. */
function resolveRoot(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return resolve(trimmed);
  } catch {
    return null;
  }
}

/** Resolved path of a `local:<root>` bucket key, or `null` for any other key. */
function bucketRoot(key: string): string | null {
  if (!key.startsWith(LOCAL_BUCKET_PREFIX)) return null;
  return resolveRoot(key.slice(LOCAL_BUCKET_PREFIX.length));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** tmp + fsync + rename: a failed write leaves the previous file intact. */
function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Usually already renamed. Cleanup must not mask a failed write/rename.
    }
  }
}

/**
 * Report session-history project paths that still point at the old root.
 *
 * `sessions.jsonl.project` is deliberately never rewritten (§5.9.2): the project
 * does not travel inside the package, so the recorded path is history, not a
 * live pointer. Unparseable lines are skipped; this is reporting only.
 */
function collectSessionHistoryLeftovers(
  settingsPath: string,
  fromRoot: string,
): string[] {
  const historyPath = join(dirname(settingsPath), SESSIONS_HISTORY_FILE);
  if (!existsSync(historyPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(historyPath, "utf-8");
  } catch {
    return [];
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const project = entry.project;
    if (typeof project !== "string") continue;
    const projectRoot = resolveRoot(project);
    if (projectRoot && samePath(projectRoot, fromRoot)) {
      return [
        `${SESSIONS_HISTORY_FILE}.project (project paths are recorded, never rewritten)`,
      ];
    }
  }

  return [];
}

/**
 * Rewrite `settings.json`'s `sessionsByServer` keys of the form
 * `local:<oldStorageDir>` to `local:<newStorageDir>`.
 *
 * Same root -> nothing to do. An existing target key keeps its current value and
 * is reported as a conflict (the old key is left untouched, so no session
 * reference is discarded). Unparseable JSON is an `io_error`, never a guessed
 * repair. The write is tmp+fsync+rename.
 */
export async function remapSettingsBucket(
  settingsPath: string,
  from: string,
  to: string,
): Promise<RemapResult> {
  const remapped: SnapshotRemap[] = [];
  const notRemapped: string[] = [];
  const fromRoot = resolveRoot(from);
  const toRoot = resolveRoot(to);

  if (!fromRoot) {
    return { remapped, notRemapped };
  }

  // §5.9.4: the storage root did not move, so no bucket key changes. Nothing is
  // reported as "not remapped" either: every path still resolves on this machine.
  if (toRoot && samePath(fromRoot, toRoot)) {
    return { remapped, notRemapped };
  }
  if (!toRoot) {
    throw snapshotError(
      "io_error",
      "Cannot remap sessionsByServer: the target storage root is empty.",
    );
  }

  if (!existsSync(settingsPath)) {
    return { remapped, notRemapped };
  }

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    throw snapshotError("io_error", `Cannot read ${settingsPath}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw snapshotError(
      "io_error",
      `Settings file is not valid JSON; refusing to guess a repair: ${settingsPath}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw snapshotError(
      "io_error",
      `Settings file is not a JSON object; refusing to guess a repair: ${settingsPath}`,
    );
  }

  notRemapped.push(...collectSessionHistoryLeftovers(settingsPath, fromRoot));

  const sessions = parsed.sessionsByServer;
  if (!isPlainObject(sessions)) {
    return { remapped, notRemapped };
  }

  const keys = Object.keys(sessions);
  const candidateKeys = keys.filter((key) => {
    const root = bucketRoot(key);
    return root !== null && samePath(root, fromRoot);
  });
  if (candidateKeys.length === 0) {
    return { remapped, notRemapped };
  }

  const targetKey = `${LOCAL_BUCKET_PREFIX}${toRoot}`;
  const targetExists = keys.some((key) => {
    if (candidateKeys.includes(key)) return false;
    const root = bucketRoot(key);
    return root !== null && samePath(root, toRoot);
  });

  if (targetExists) {
    // §5.9.1: the current root's bucket already exists. Its value wins; the old
    // key stays where it is so nothing is silently discarded.
    for (const key of candidateKeys) {
      notRemapped.push(
        `sessionsByServer.${key} (target bucket ${targetKey} already exists; kept its current value)`,
      );
    }
    return { remapped, notRemapped };
  }

  const preferredKey = candidateKeys[0];
  if (!preferredKey) return { remapped, notRemapped };
  const duplicates = candidateKeys.slice(1);
  for (const key of duplicates) {
    notRemapped.push(
      `sessionsByServer.${key} (same storage root as ${preferredKey}; kept the first value)`,
    );
  }

  const nextSessions: Record<string, unknown> = {};
  for (const key of keys) {
    if (candidateKeys.includes(key)) continue;
    nextSessions[key] = sessions[key];
  }
  nextSessions[targetKey] = sessions[preferredKey];
  parsed.sessionsByServer = nextSessions;

  remapped.push({
    field: `sessionsByServer.${preferredKey}`,
    from: preferredKey,
    to: targetKey,
  });

  try {
    writeJsonAtomic(settingsPath, parsed);
  } catch {
    throw snapshotError("io_error", `Cannot write ${settingsPath}.`);
  }

  return { remapped, notRemapped };
}
