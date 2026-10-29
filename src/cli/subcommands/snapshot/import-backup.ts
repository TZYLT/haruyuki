/**
 * Pre-import backup writer.
 *
 * A backup is a full `.hryk` package of the CURRENT managed data, written with
 * the same scope walk, archive writer and manifest modules the exporter uses, so
 * `haruyuki import --from backups/pre-import.hryk` restores it (requirement doc
 * sections 5.12.1 and 5.12.2). `backups/` is excluded by the scope walk itself,
 * so a backup can never nest inside the next one.
 *
 * The package copy of `settings.json` is sanitised exactly like an export copy:
 * the plaintext token fallbacks move into `secrets.json.settings`, so a rollback
 * writes them back through the secret store instead of keeping two copies.
 *
 * Every failure is raised as `backup_failed`: the import must stop before the
 * clear step when no usable backup exists (requirement doc section 5.12.5).
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { hostname as systemHostname } from "node:os";
import { dirname, join } from "node:path";
import type { TarEntryInput } from "@/utils/tar-stream";
import { writeTarGz } from "@/utils/tar-stream";
import { getVersion } from "@/version";
import {
  PACKAGE_MANIFEST_PATH,
  PACKAGE_SECRETS_PATH,
  packageScopeOf,
} from "./import-place";
import { LEGACY_CRON_FILE_NAME } from "./legacy-store";
import { buildManifest, serializeManifest } from "./manifest";
import { collectEntries, type ScopeEntry, type ScopeRoots } from "./scope";
import {
  collectSecrets,
  type SecretBundle,
  sanitizeSettingsForPackage,
} from "./secrets";
import type { SnapshotCliDeps, SnapshotEntry } from "./types";
import { snapshotError } from "./types";

/** Fixed backup name; only the newest one is kept (requirement doc section 5.12.1). */
export const PRE_IMPORT_BACKUP_NAME = "pre-import.hryk";

/** Package path of the settings file whose packaged copy is sanitised. */
const PACKAGED_SETTINGS_PATH = "home/settings.json";

/**
 * Package path of the pre-migration schedule store. It is not part of the v2
 * include table, but the placement pass writes it and a legacy-only machine
 * keeps its tasks there, so a backup that omitted it could not be rolled back
 * (M5 #4).
 */
const PACKAGED_LEGACY_CRON_PATH = `home/${LEGACY_CRON_FILE_NAME}`;

export interface PreImportBackupRequest {
  /** Roots of the data that is about to be replaced. */
  roots: ScopeRoots;
  /** Absolute project directory, when the import will restore project data. */
  project?: string;
  deps?: SnapshotCliDeps;
}

export interface PreImportBackupResult {
  /** False when the target held no managed file, so nothing was written. */
  written: boolean;
  /** Absolute path the backup was (or would have been) written to. */
  path: string;
  warnings: string[];
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function backupFailure(path: string, error: unknown): Error {
  const code = errorCode(error);
  return snapshotError(
    "backup_failed",
    `cannot write the pre-import backup ${path}${code ? ` (${code})` : ""}: ${errorMessage(error)}`,
  );
}

async function collectManagedEntries(
  roots: ScopeRoots,
  project: string | undefined,
  warnings: string[],
  entries: ScopeEntry[],
): Promise<void> {
  for await (const entry of collectEntries(roots, {
    project,
    onWarning: (message) => warnings.push(message),
  })) {
    entries.push(entry);
  }
}

/** The live pre-migration store, when this machine has one (M5 #4). */
function collectLegacyCronEntry(appHome: string): ScopeEntry | undefined {
  const absolutePath = join(appHome, LEGACY_CRON_FILE_NAME);
  try {
    const info = statSync(absolutePath);
    if (!info.isFile()) return undefined;
    return {
      path: PACKAGED_LEGACY_CRON_PATH,
      absolutePath,
      scope: "home",
      kind: "file",
      bytes: info.size,
    };
  } catch {
    return undefined;
  }
}

/** Agent ids are needed to read per-agent secrets; the secrets store cannot list them. */
function listAgentIds(storageDir: string): string[] {
  const directory = join(storageDir, "agents");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  const ids = new Set<string>();
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name.startsWith("._")) continue;
    let id: string | undefined;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(directory, name), "utf-8"),
      );
      if (
        isRecord(parsed) &&
        typeof parsed.id === "string" &&
        parsed.id.trim()
      ) {
        id = parsed.id.trim();
      }
    } catch {
      // Fall through to the file-name decode below.
    }
    if (!id) {
      const segment = name.slice(0, -".json".length);
      try {
        const decoded = Buffer.from(segment, "base64url").toString("utf-8");
        if (decoded.length > 0 && !decoded.includes("\uFFFD")) id = decoded;
      } catch {
        // Not a decodable agent file name; skip it.
      }
    }
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

function countSecretValues(bundle: SecretBundle): number {
  let total = Object.keys(bundle.settings).length;
  for (const values of Object.values(bundle.agents)) {
    total += Object.keys(values).length;
  }
  for (const accounts of Object.values(bundle.channels)) {
    for (const fields of Object.values(accounts)) {
      total += Object.keys(fields).length;
    }
  }
  return total;
}

function packagedSettingsContent(absolutePath: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf-8"));
  } catch (error) {
    throw snapshotError(
      "io_error",
      `cannot read ${absolutePath} for the backup copy (${errorMessage(error)})`,
    );
  }
  if (!isRecord(parsed)) {
    throw snapshotError(
      "io_error",
      `${absolutePath} is not a JSON object; the backup copy cannot be sanitised`,
    );
  }
  const sanitised = sanitizeSettingsForPackage(parsed);
  return Buffer.from(`${JSON.stringify(sanitised, null, 2)}\n`, "utf-8");
}

function fsyncFile(path: string): void {
  const handle = openSync(path, "r+");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/**
 * Write the backup package. Returns `written: false` (and a warning) when the
 * target holds no managed file at all, which is the documented empty-target case
 * (requirement doc section 5.8.5).
 */
export async function writePreImportBackup(
  request: PreImportBackupRequest,
): Promise<PreImportBackupResult> {
  const { roots, project, deps } = request;
  const warnings: string[] = [];
  const backupPath = join(roots.appHome, "backups", PRE_IMPORT_BACKUP_NAME);

  const entries: ScopeEntry[] = [];
  try {
    await collectManagedEntries(roots, project, warnings, entries);
    const legacyCron = collectLegacyCronEntry(roots.appHome);
    if (legacyCron !== undefined) entries.push(legacyCron);
  } catch (error) {
    throw backupFailure(backupPath, error);
  }

  if (entries.every((entry) => entry.kind === "dir")) {
    return {
      written: false,
      path: backupPath,
      warnings: [
        ...warnings,
        "the target holds no managed files, so no pre-import backup was written",
      ],
    };
  }

  let bundle: SecretBundle;
  try {
    bundle = await collectSecrets(roots, listAgentIds(roots.storageDir));
  } catch (error) {
    throw backupFailure(backupPath, error);
  }

  const now = deps?.now?.() ?? new Date();
  const digests: SnapshotEntry[] = [];
  const partialPath = `${backupPath}.partial`;

  try {
    mkdirSync(dirname(backupPath), { recursive: true });
    await writeTarGz({
      entries: backupEntries({
        entries,
        bundle,
        roots,
        project,
        warnings,
        digests,
        now,
        deps,
      }),
      outFile: partialPath,
      onEntry: (digest) => {
        if (digest.path === PACKAGE_MANIFEST_PATH) return;
        const scope = packageScopeOf(digest.path);
        if (!scope) {
          throw snapshotError(
            "backup_failed",
            `the backup walk produced an entry outside the package layout: ${digest.path}`,
          );
        }
        digests.push({
          path: digest.path,
          scope,
          bytes: digest.bytes,
          sha256: digest.sha256,
        });
      },
    });
    fsyncFile(partialPath);
    renameSync(partialPath, backupPath);
  } catch (error) {
    try {
      unlinkSync(partialPath);
    } catch {
      // Nothing to clean up, or the failed write already removed it.
    }
    throw backupFailure(backupPath, error);
  }

  return { written: true, path: backupPath, warnings };
}

interface BackupEntriesRequest {
  entries: ScopeEntry[];
  bundle: SecretBundle;
  roots: ScopeRoots;
  project?: string;
  warnings: string[];
  digests: SnapshotEntry[];
  now: Date;
  deps?: SnapshotCliDeps;
}

/**
 * Yield the backup package in its documented order: the walked data entries,
 * then `secrets.json`, then `manifest.json` last.
 *
 * The manifest is built at the end of this generator, after every data entry has
 * been written, so `digests` is complete by then; the writer pulls lazily, which
 * is what makes the single pass (write + hash + manifest) possible.
 */
async function* backupEntries(
  request: BackupEntriesRequest,
): AsyncGenerator<TarEntryInput> {
  const { entries, bundle, roots, project, warnings, digests, now, deps } =
    request;

  for (const entry of entries) {
    if (entry.kind === "dir") {
      yield { path: entry.path, type: "dir" };
      continue;
    }
    if (entry.path === PACKAGED_SETTINGS_PATH) {
      yield {
        path: entry.path,
        type: "file",
        content: packagedSettingsContent(entry.absolutePath),
      };
      continue;
    }
    yield { path: entry.path, type: "file", absolutePath: entry.absolutePath };
  }

  yield {
    path: PACKAGE_SECRETS_PATH,
    type: "file",
    content: Buffer.from(`${JSON.stringify(bundle)}\n`, "utf-8"),
  };

  const manifest = buildManifest(
    digests,
    {
      home: roots.appHome,
      localBackend: roots.storageDir,
      ...(project === undefined ? {} : { project }),
    },
    {
      appVersion: deps?.appVersion ?? getVersion(),
      createdAt: now.toISOString(),
      platform: `${process.platform}-${process.arch}`,
      hostname: deps?.hostname?.() ?? systemHostname(),
      warnings,
      secrets: countSecretValues(bundle),
    },
  );

  yield {
    path: PACKAGE_MANIFEST_PATH,
    type: "file",
    content: Buffer.from(serializeManifest(manifest), "utf-8"),
  };
}
