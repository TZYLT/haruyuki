/**
 * Export pipeline: resolve roots -> collect -> write `.partial` -> append the
 * manifest -> fsync + rename.
 *
 * The archive is written through `writeTarGz` from `@/utils/tar-stream`, which
 * yields bytes and hashes in the same pass, so the manifest describes the write
 * that is being verified instead of costing a second read of the source tree.
 * Three consequences shape this file:
 *
 *   - `manifest.json` has to carry the byte count and SHA-256 of every other
 *     entry, so it is built INSIDE the entry generator: the generator resumes
 *     only after `secrets.json` has been yielded and its digest reported, which
 *     is the one moment where "everything else is already written" is true.
 *   - Nothing is written before the whole scope has been collected and the
 *     secret bundle read, so a scope or secret failure never creates a
 *     `.partial` to clean up.
 *   - The digest callback is the manifest's only source of truth. A directory
 *     entry arrives as `bytes: 0` with the empty SHA-256 and a path without a
 *     trailing slash, exactly the shape `collectEntries` reported, so the two
 *     lists line up one-to-one (docs/46-2 §1.7 rule 2).
 *   - `settings.json` and `schedules.json` ship as rewritten copies (no plaintext
 *     tokens, no scheduler or task lease); their source files are only ever read.
 *
 * `--dry-run` stops after collection and the secret read: no hashing, no file.
 * It reports the same entry count as a real run because it uses the same entry
 * list and the same packaged `settings.json` copy, and the same byte total
 * because those sizes are the very ones the real run writes. Only the hashes
 * are absent — a preview entry carries `sha256: ""`, since §5.7.1 forbids
 * hashing a preview.
 *
 * Failure policy (docs/44-2 §5.5.5, §5.11.3, §5.11.4): an export is all or
 * nothing. The first unreadable entry aborts, the `.partial` package is
 * deleted, and the thrown `SnapshotError` names that entry. A
 * `TarStreamError.code` maps 1:1 onto `SnapshotErrorCode`, so a codec failure
 * keeps its class instead of surfacing as a bare `Error`.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { resolve } from "node:path";
import { LOCAL_BACKEND_DIR_ENV } from "@/utils/local-backend-paths";
import {
  isTarStreamError,
  type TarEntryInput,
  type TarStreamErrorCode,
  writeTarGz,
} from "@/utils/tar-stream";
import { getVersion } from "@/version";
import {
  type BuildManifestOptions,
  buildManifest,
  parseManifest,
  serializeManifest,
  verifyManifest,
} from "./manifest";
import { formatBytes } from "./report";
import {
  collectEntries,
  resolveHomeRoots,
  type ScopeEntry,
  type ScopeRoots,
} from "./scope";
import {
  collectSecrets,
  type SecretBundle,
  sanitizeSettingsForPackage,
} from "./secrets";
import type {
  SnapshotCliDeps,
  SnapshotCounts,
  SnapshotEntry,
  SnapshotErrorCode,
  SnapshotExclusion,
  SnapshotManifest,
  SnapshotPhase,
  SnapshotProgress,
  SnapshotProgressHandler,
  SnapshotReport,
  SnapshotRoots,
  SnapshotScope,
  SnapshotScopeCount,
} from "./types";
import { SnapshotError, snapshotError } from "./types";

export interface ExportOptions {
  /** Absolute target package path; an existing file is overwritten. */
  out: string;
  /** Absolute project directory to include as the optional `project/` tree. */
  withProject?: string;
  /** Estimate only: no hashing, nothing written, same entry count as a real run. */
  dryRun?: boolean;
  verbose?: boolean;
  deps?: SnapshotCliDeps;
}

/** Suffix of the in-progress package, renamed onto the target on success. */
const PARTIAL_SUFFIX = ".partial";

/**
 * Package-relative path of the global settings file. It ships as the sanitised
 * copy (`sanitizeSettingsForPackage`); the tokens it carries move to
 * `secrets.json.settings` and the source file is never touched.
 */
const PACKAGED_SETTINGS_PATH = "home/settings.json";

/**
 * Path of the schedule store. It ships as a copy with the scheduler and task
 * leases cleared (§5.3 A, §5.10.1, R-5.13.5), so the target never adopts ours.
 */
const PACKAGED_SCHEDULES_PATH = "home/schedules.json";

/** Package-relative path of the generated secret partition. */
const SECRETS_PATH = "secrets.json";

/** Package-relative path of the manifest: always the last entry in the tar. */
const MANIFEST_PATH = "manifest.json";

/**
 * One progress line per this many packed entries. §5.13.4 allows a stage line
 * and "one line every N entries"; there is no percentage and no timer.
 */
const PACK_PROGRESS_EVERY = 500;

/**
 * The codec's failure classes are a subset of the snapshot taxonomy, so the
 * mapping is the identity — spelled out as a table so a codec code that gains a
 * different snapshot meaning has one place to change, and so TypeScript proves
 * every codec code was considered.
 */
const TAR_CODE_TO_SNAPSHOT: Record<TarStreamErrorCode, SnapshotErrorCode> = {
  path_conflict: "path_conflict",
  verify_failed: "verify_failed",
  io_error: "io_error",
};

/** State the entry generator hands back to the pipeline after the write. */
interface PackedManifest {
  manifest?: SnapshotManifest;
  /** The exact bytes written as `manifest.json`, for the round-trip check. */
  text?: string;
}

/**
 * Run an export and return its report. Failures delete the `.partial` package
 * and report the FIRST unreadable entry plus the total failure count; a partial
 * package is never left behind looking complete.
 */
export async function runExport(
  opts: ExportOptions,
  onProgress?: SnapshotProgressHandler,
): Promise<SnapshotReport> {
  const startedAtMs = performance.now();
  const deps: SnapshotCliDeps = opts.deps ?? {};
  const dryRun = opts.dryRun === true;
  const verbose = opts.verbose === true;

  const requestedOut = opts.out.trim();
  if (requestedOut.length === 0) {
    throw snapshotError("io_error", "The output path is empty.");
  }
  const out = resolve(requestedOut);
  const partial = `${out}${PARTIAL_SUFFIX}`;
  const project =
    opts.withProject === undefined ? undefined : resolve(opts.withProject);

  const warnings: string[] = [];
  const excluded: SnapshotExclusion[] = [];
  let plannedEntries = 0;
  let partialStarted = false;

  try {
    reportProgress(
      onProgress,
      "prepare",
      dryRun
        ? `resolving the data roots (preview for ${out})`
        : `resolving the data roots for ${out}`,
    );
    const roots = resolveHomeRoots(deps);
    warnIfProjectMissing(project, warnings);
    // Fail fast on an unusable target, before the walk and the secret reads.
    if (!dryRun) assertTargetIsNotDirectory(out);

    reportProgress(onProgress, "scan", "collecting the export scope");
    const collected = await collectScope(roots, project, warnings, excluded);
    plannedEntries = collected.length + 1;
    // The "exists but contributes nothing" case can only be judged after the
    // walk; the "does not exist" case was already decided before it.
    warnIfProjectEmpty(project, collected, warnings);
    reportProgress(
      onProgress,
      "scan",
      `collected ${collected.length} entries plus secrets.json`,
    );

    // Both of the next two steps read sources only: no target file exists yet,
    // so a failure here needs no `.partial` cleanup.
    const copies = preparePackageCopies(collected);
    const bundle = await collectPackageSecrets(
      roots,
      deps.storageDir,
      deriveAgentIds(collected),
    );
    const secretsBytes = Buffer.from(
      `${JSON.stringify(bundle, null, 2)}\n`,
      "utf-8",
    );
    const secretValues = countSecretValues(bundle);
    const manifestRoots = manifestRootsFor(roots, collected, project);

    if (dryRun) {
      const entries = previewEntries(collected, copies, secretsBytes);
      const counts = summarizeEntries(entries, secretValues);
      reportProgress(
        onProgress,
        "done",
        `preview complete: ${counts.files} entries, nothing was written`,
      );
      return successReport({
        out,
        dryRun: true,
        entries,
        counts,
        excluded,
        warnings,
        verbose,
        startedAtMs,
        message: `${counts.files} entries (${formatBytes(counts.bytes)}, ${counts.secrets} secrets) would be written to ${out}; nothing was written.`,
      });
    }

    reportProgress(
      onProgress,
      "pack",
      `writing ${plannedEntries} entries to the partial package`,
      0,
      plannedEntries,
    );

    const digests: SnapshotEntry[] = [];
    const scopeByPath = new Map<string, SnapshotScope>(
      collected.map((entry) => [entry.path, entry.scope]),
    );
    scopeByPath.set(SECRETS_PATH, "secrets");
    const packed: PackedManifest = {};
    let packedCount = 0;

    partialStarted = true;
    await writeTarGz({
      entries: packEntrySequence({
        collected,
        copies,
        secretsBytes,
        digests,
        roots: manifestRoots,
        manifestOptions: {
          appVersion: deps.appVersion ?? getVersion(),
          createdAt: (deps.now?.() ?? new Date()).toISOString(),
          platform: `${process.platform}-${process.arch}`,
          hostname: deps.hostname?.() ?? osHostname(),
          warnings,
          secrets: secretValues,
        },
        packed,
      }),
      outFile: partial,
      onEntry: (digest) => {
        // The manifest is the one entry that cannot describe itself.
        if (digest.path === MANIFEST_PATH) return;
        const scope = scopeByPath.get(digest.path);
        if (scope === undefined) {
          throw snapshotError(
            "verify_failed",
            `the archive reported an entry that was not collected: ${digest.path}`,
          );
        }
        digests.push({
          path: digest.path,
          scope,
          bytes: digest.bytes,
          sha256: digest.sha256,
        });
        packedCount += 1;
        if (packedCount % PACK_PROGRESS_EVERY === 0) {
          reportProgress(
            onProgress,
            "pack",
            "packing entries",
            packedCount,
            plannedEntries,
          );
        }
      },
    });

    const manifest = packed.manifest;
    const manifestText = packed.text;
    if (manifest === undefined || manifestText === undefined) {
      throw snapshotError(
        "verify_failed",
        "the manifest was not produced by the write pass",
      );
    }

    fsyncFile(partial);

    reportProgress(
      onProgress,
      "verify",
      "verifying manifest.json against the written entries",
    );
    verifyWrittenPackage(collected, digests, manifestText);

    publishPartialPackage(partial, out);

    const counts = summarizeEntries(digests, secretValues);
    reportProgress(
      onProgress,
      "done",
      `wrote ${counts.files} entries (${formatBytes(counts.bytes)})`,
    );
    return successReport({
      out,
      dryRun: false,
      entries: digests,
      counts,
      excluded,
      warnings,
      verbose,
      startedAtMs,
      message: `Wrote ${counts.files} entries (${formatBytes(counts.bytes)}, ${counts.secrets} secrets) to ${out}.`,
    });
  } catch (error) {
    if (partialStarted) await removePartialPackage(partial);
    throw describeExportFailure(error, plannedEntries, partialStarted);
  }
}

/* ------------------------------------------------------------------ */
/* Scope                                                                */
/* ------------------------------------------------------------------ */

/**
 * Walk the explicit scope into one materialised list.
 *
 * Materialising is deliberate: `--dry-run` needs the same list a real run
 * writes, `manifest.entries` is built from what was collected, and the agent-id
 * derivation reads the collected tree rather than the filesystem.
 *
 * The walk's evidence callbacks are the only sources for the report:
 * `onWarning` collects symlink/case observations and `onExcluded` the paths the
 * walk really skipped on this machine. The latter is NOT the manifest's
 * `excluded`, which is the 22-rule table (docs/46-2 §1.7 rule 4).
 */
async function collectScope(
  roots: ScopeRoots,
  project: string | undefined,
  warnings: string[],
  excluded: SnapshotExclusion[],
): Promise<ScopeEntry[]> {
  const walk = collectEntries(roots, {
    project,
    onWarning: (message) => {
      warnings.push(message);
    },
    onExcluded: (exclusion) => {
      excluded.push(exclusion);
    },
  });
  const collected: ScopeEntry[] = [];
  for await (const entry of walk) collected.push(entry);
  return collected;
}

/**
 * A `--with-project` directory that does not exist is a warning, not a failure:
 * the flag names an optional tree, and an empty `project/` must not sink an
 * otherwise complete package. The warning is what keeps a typo visible.
 */
function warnIfProjectMissing(
  project: string | undefined,
  warnings: string[],
): void {
  if (project === undefined) return;
  if (statOrUndefined(project)?.isDirectory() === true) return;
  warnings.push(
    `project directory not found: ${project}; nothing was added under project/`,
  );
}

/**
 * The mirror of `warnIfProjectMissing` for the other way a project tree comes
 * back empty: the directory IS there, but the narrow project scope (§5.3 C)
 * matched nothing inside it. That is a legitimate package, but a silent one is
 * indistinguishable from a path typo, so it gets one line. Fires only after the
 * walk and only for an existing directory, so the "not found" cause never also
 * claims this one.
 */
function warnIfProjectEmpty(
  project: string | undefined,
  collected: readonly ScopeEntry[],
  warnings: string[],
): void {
  if (project === undefined) return;
  if (collected.some((entry) => entry.scope === "project")) return;
  if (statOrUndefined(project)?.isDirectory() !== true) return;
  warnings.push(
    `project directory ${project} holds no managed paths; nothing was added under project/`,
  );
}

/**
 * The roots recorded in the manifest. `project` appears only when the package
 * actually carries a `project/` tree: a root whose every rule matched nothing
 * describes no data.
 */
function manifestRootsFor(
  roots: ScopeRoots,
  collected: readonly ScopeEntry[],
  project: string | undefined,
): SnapshotRoots {
  const manifestRoots: SnapshotRoots = {
    home: roots.appHome,
    localBackend: roots.storageDir,
  };
  const carriesProject = collected.some((entry) => entry.scope === "project");
  if (carriesProject && project !== undefined) {
    manifestRoots.project = project;
  }
  return manifestRoots;
}

/* ------------------------------------------------------------------ */
/* Agent ids (derived from the exported tree only)                      */
/* ------------------------------------------------------------------ */

const HOME_AGENTS_PREFIX = "home/agents/";
const AGENT_RECORDS_PREFIX = "local-backend/agents/";
const MEMFS_PREFIX = "local-backend/memfs/";

/**
 * Which agents this package carries, derived strictly from the collected tree:
 * `<appHome>/agents/<id>/`, `<storageDir>/agents/<id>.json` and
 * `<storageDir>/memfs/<id>/`. The live backend is never asked — the point of
 * deriving from the walk is that an agent whose tree is not in the package does
 * not get its secret store read, and that an excluded path cannot smuggle an
 * agent in.
 *
 * `kind` separates an agent directory from a stray file directly under
 * `home/agents/`: only a directory entry (or a path with a segment below it)
 * contributes an id there.
 */
function deriveAgentIds(collected: readonly ScopeEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of collected) {
    if (entry.path.startsWith(MEMFS_PREFIX)) {
      const id = entry.path.slice(MEMFS_PREFIX.length).split("/")[0] ?? "";
      if (id.length > 0) ids.add(id);
      continue;
    }
    if (entry.path.startsWith(AGENT_RECORDS_PREFIX)) {
      const name = entry.path.slice(AGENT_RECORDS_PREFIX.length);
      if (!name.includes("/") && name.endsWith(".json")) {
        ids.add(name.slice(0, -".json".length));
      }
      continue;
    }
    if (entry.path.startsWith(HOME_AGENTS_PREFIX)) {
      const rest = entry.path.slice(HOME_AGENTS_PREFIX.length);
      const [id = ""] = rest.split("/");
      const isDirectory = rest.length > id.length || entry.kind === "dir";
      if (id.length > 0 && isDirectory) ids.add(id);
    }
  }
  return [...ids].sort();
}

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Read the three secret partitions for the agents the package carries.
 *
 * Agent and channel secret stores resolve their root from
 * `LETTA_LOCAL_BACKEND_DIR`, not from the injected `storageDir` (docs/46-2
 * §1.8.3 rule 4). When a caller pins `deps.storageDir` — every test does — the
 * environment is pointed at the same directory for the duration of the read and
 * restored afterwards, so the package cannot mix two storage roots.
 */
async function collectPackageSecrets(
  roots: ScopeRoots,
  storageDir: string | undefined,
  agentIds: readonly string[],
): Promise<SecretBundle> {
  if (storageDir === undefined) return collectSecrets(roots, agentIds);

  const previous = process.env[LOCAL_BACKEND_DIR_ENV];
  process.env[LOCAL_BACKEND_DIR_ENV] = storageDir;
  try {
    return await collectSecrets(roots, agentIds);
  } finally {
    if (previous === undefined) delete process.env[LOCAL_BACKEND_DIR_ENV];
    else process.env[LOCAL_BACKEND_DIR_ENV] = previous;
  }
}

/** Values carried by `secrets.json`; names and values never reach the report. */
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

/* ------------------------------------------------------------------ */
/* Packaged copies                                                     */
/* ------------------------------------------------------------------ */

/**
 * Two managed files must not ship verbatim: `home/settings.json` carries
 * plaintext token fallbacks, `home/schedules.json` the exporting machine's
 * leases. Both ship as rewritten copies (the source is only read) and the same
 * buffers feed the dry-run totals, so a preview and a real run agree on every
 * size. A rewrite failure is an `io_error` raised before the `.partial` exists;
 * a passed-through schedule store would let the target adopt a foreign lease.
 */
function preparePackageCopies(
  collected: readonly ScopeEntry[],
): Map<string, Buffer> {
  const copies = new Map<string, Buffer>();
  const settings = preparePackagedSettings(collected);
  if (settings !== undefined) copies.set(PACKAGED_SETTINGS_PATH, settings);
  const schedules = preparePackagedSchedules(collected);
  if (schedules !== undefined) copies.set(PACKAGED_SCHEDULES_PATH, schedules);
  return copies;
}

/**
 * Read one managed JSON file as an object, with the shared failure rule: an
 * unreadable file, invalid JSON or a non-object body aborts the export. The
 * message names the package path only — never content, which for
 * `settings.json` may hold plaintext tokens.
 */
function readManagedJsonObject(entry: ScopeEntry): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(entry.absolutePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw snapshotError(
      "io_error",
      `Cannot read ${entry.path} (${code ?? "read failed"}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw snapshotError(
      "io_error",
      `${entry.path} is not valid JSON; the package would be incomplete.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw snapshotError(
      "io_error",
      `${entry.path} is not a JSON object; the package would be incomplete.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * The `home/settings.json` body that goes into the package: a sanitised copy
 * with `env.LETTA_API_KEY` and the top-level `refreshToken` removed, because
 * their values travel in `secrets.json.settings` (docs/44-2 §5.4.3).
 */
function preparePackagedSettings(
  collected: readonly ScopeEntry[],
): Buffer | undefined {
  const entry = findPackagedFile(collected, PACKAGED_SETTINGS_PATH);
  if (entry === undefined) return undefined;
  const sanitized = sanitizeSettingsForPackage(readManagedJsonObject(entry));
  return Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, "utf-8");
}

/**
 * The `home/schedules.json` body that goes into the package: a copy with the
 * scheduler lease and every task lease cleared, the shape the import side
 * writes. §5.3 A ships the file "after clearing the lease" and §5.10.1 clears
 * it again on the target, but that second clear degrades to a warning when
 * `crons.lock` is busy, so the package must not name the exporting machine.
 * `signal_state`, tasks and every other field stay verbatim.
 */
function preparePackagedSchedules(
  collected: readonly ScopeEntry[],
): Buffer | undefined {
  const entry = findPackagedFile(collected, PACKAGED_SCHEDULES_PATH);
  if (entry === undefined) return undefined;
  const source = readManagedJsonObject(entry);
  const tasks = Array.isArray(source.tasks)
    ? source.tasks.map((task) =>
        typeof task === "object" && task !== null && !Array.isArray(task)
          ? { ...(task as Record<string, unknown>), lease: null }
          : task,
      )
    : source.tasks;
  const cleared: Record<string, unknown> = {
    ...source,
    scheduler_owner: null,
    scheduler_owners: {},
    tasks,
  };
  return Buffer.from(`${JSON.stringify(cleared, null, 2)}\n`, "utf-8");
}

/** The collected file entry for a package-relative path, when it is a file. */
function findPackagedFile(
  collected: readonly ScopeEntry[],
  path: string,
): ScopeEntry | undefined {
  return collected.find(
    (entry) => entry.path === path && entry.kind === "file",
  );
}

/* ------------------------------------------------------------------ */
/* Packing                                                             */
/* ------------------------------------------------------------------ */

interface PackSequenceInput {
  collected: readonly ScopeEntry[];
  /** Rewritten bodies by package path (`settings.json`, `schedules.json`). */
  copies: ReadonlyMap<string, Buffer>;
  secretsBytes: Buffer;
  /** Live digest ledger; filled by the writer's `onEntry` as entries land. */
  digests: readonly SnapshotEntry[];
  roots: SnapshotRoots;
  manifestOptions: BuildManifestOptions;
  /** Filled after the secret partition lands, before the manifest is yielded. */
  packed: PackedManifest;
}

/**
 * Yield the package entries in the fixed archive order:
 * `home/...`, `local-backend/...`, `project/...`, `secrets.json`,
 * `manifest.json`.
 *
 * The manifest is assembled on the resume after `secrets.json`: the writer
 * reports a digest only once the entry's body is fully written, so by then the
 * ledger holds every entry the manifest has to cover.
 */
async function* packEntrySequence(
  input: PackSequenceInput,
): AsyncGenerator<TarEntryInput> {
  for (const entry of input.collected) {
    const copy = input.copies.get(entry.path);
    if (copy !== undefined) {
      yield { path: entry.path, type: "file", content: copy };
      continue;
    }
    if (entry.kind === "dir") {
      yield { path: entry.path, type: "dir" };
      continue;
    }
    yield {
      path: entry.path,
      type: "file",
      absolutePath: entry.absolutePath,
    };
  }

  yield { path: SECRETS_PATH, type: "file", content: input.secretsBytes };

  const manifest = buildManifest(
    [...input.digests],
    input.roots,
    input.manifestOptions,
  );
  const text = serializeManifest(manifest);
  input.packed.manifest = manifest;
  input.packed.text = text;
  yield {
    path: MANIFEST_PATH,
    type: "file",
    content: Buffer.from(text, "utf-8"),
  };
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

/**
 * The entry list a dry run reports. Same paths and same byte counts as the real
 * run — a directory keeps `bytes: 0`, and a rewritten copy (`settings.json`,
 * `schedules.json`) reports the copy's size — but no hash is computed (§5.7.1), so
 * every entry carries `sha256: ""`. A preview answers "what and how much",
 * never "which digest".
 */
function previewEntries(
  collected: readonly ScopeEntry[],
  copies: ReadonlyMap<string, Buffer>,
  secretsBytes: Buffer,
): SnapshotEntry[] {
  const entries: SnapshotEntry[] = collected.map((entry) => ({
    path: entry.path,
    scope: entry.scope,
    bytes: copies.get(entry.path)?.length ?? entry.bytes,
    sha256: "",
  }));
  entries.push({
    path: SECRETS_PATH,
    scope: "secrets",
    bytes: secretsBytes.length,
    sha256: "",
  });
  return entries;
}

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

/**
 * `counts` over an entry list. The manifest computes its own totals the same
 * way over the same list, so `report.counts` and `manifest.counts` agree by
 * construction (docs/46-2 §1.7 rule 2: `files` counts ENTRIES, directories
 * included).
 */
function summarizeEntries(
  entries: readonly SnapshotEntry[],
  secretValues: number,
): SnapshotCounts {
  return {
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    secrets: secretValues,
  };
}

/**
 * Per-tree totals for the human summary. Insertion order follows the first
 * appearance in `entries`, which is package order, so `--json`'s `by_scope`
 * reads in the same order the archive does. The buckets always add up to
 * `counts`.
 */
function accumulateByScope(
  entries: readonly SnapshotEntry[],
): Partial<Record<SnapshotScope, SnapshotScopeCount>> {
  const byScope: Partial<Record<SnapshotScope, SnapshotScopeCount>> = {};
  for (const entry of entries) {
    const bucket = byScope[entry.scope] ?? { files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += entry.bytes;
    byScope[entry.scope] = bucket;
  }
  return byScope;
}

function successReport(input: {
  out: string;
  dryRun: boolean;
  entries: readonly SnapshotEntry[];
  counts: SnapshotCounts;
  excluded: SnapshotExclusion[];
  warnings: string[];
  verbose: boolean;
  startedAtMs: number;
  message: string;
}): SnapshotReport {
  const report: SnapshotReport = {
    ok: true,
    code: "ok",
    command: "export",
    message: input.message,
    out: input.out,
    dryRun: input.dryRun,
    counts: input.counts,
    byScope: accumulateByScope(input.entries),
    excluded: input.excluded,
    remapped: [],
    notRemapped: [],
    failedSecrets: [],
    warnings: input.warnings,
    durationMs: Math.round(performance.now() - input.startedAtMs),
  };
  if (input.verbose) report.entries = [...input.entries];
  return report;
}

/* ------------------------------------------------------------------ */
/* Self-verification                                                   */
/* ------------------------------------------------------------------ */

/**
 * Check the write against the plan, without re-reading the archive.
 *
 * Two independent claims are tested:
 *
 *   1. every collected entry (plus `secrets.json`, minus `manifest.json`)
 *      really produced a digest — a silently skipped entry would otherwise
 *      vanish from both the package and its manifest;
 *   2. the exact `manifest.json` bytes that were written parse back and satisfy
 *      `verifyManifest` against the digest ledger — a serialisation that drifts
 *      from the reader shows up here instead of on the import side.
 *
 * A failure names the first offending entry plus the failure total
 * (docs/44-2 §5.7.4 style) and leaves the `.partial` to the caller's cleanup.
 */
function verifyWrittenPackage(
  collected: readonly ScopeEntry[],
  digests: readonly SnapshotEntry[],
  manifestText: string,
): void {
  const expected = new Set<string>(collected.map((entry) => entry.path));
  expected.add(SECRETS_PATH);
  const written = new Set<string>(digests.map((entry) => entry.path));

  const missing = [...expected].filter((path) => !written.has(path)).sort();
  const unexpected = [...written].filter((path) => !expected.has(path)).sort();
  const verification = verifyManifest(parseManifest(manifestText), digests);

  if (missing.length === 0 && unexpected.length === 0 && verification.ok) {
    return;
  }

  const firstMissing = missing[0];
  const firstUnexpected = unexpected[0];
  const first =
    firstMissing ??
    firstUnexpected ??
    verification.firstFailure?.path ??
    MANIFEST_PATH;
  const detail =
    firstMissing !== undefined
      ? "is missing from the archive"
      : firstUnexpected !== undefined
        ? "was written but never collected"
        : `failed manifest verification: expected ${verification.firstFailure?.expected ?? "?"}, actual ${verification.firstFailure?.actual ?? "?"}`;
  throw snapshotError(
    "verify_failed",
    `verify: entry ${first} ${detail}; ${missing.length + unexpected.length + verification.failures} failure(s). The partial package was removed.`,
  );
}

/* ------------------------------------------------------------------ */
/* Target handling                                                     */
/* ------------------------------------------------------------------ */

/** A target that is a directory is refused outright (§5.2.10): no renaming around it. */
function assertTargetIsNotDirectory(out: string): void {
  if (statOrUndefined(out)?.isDirectory() === true) {
    throw snapshotError(
      "io_error",
      `Cannot write the package: ${out} is a directory.`,
    );
  }
}

/**
 * Flush the finished archive before the rename, so the name only ever appears
 * on disk with all of its bytes committed. Re-opened for write because Windows
 * refuses `FlushFileBuffers` on a read-only handle.
 */
function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Give the package its final name. `renameSync` replaces an existing file
 * atomically on both POSIX and Windows (the latter uses
 * `MOVEFILE_REPLACE_EXISTING`), which is what §5.2.10 asks for: overwrite, no
 * auto-rename, no extra flag.
 *
 * The POSIX mode is best effort: `0600` on POSIX, and on Windows there is no
 * POSIX mode to set (documented as "no ACL guarantee").
 */
function publishPartialPackage(partial: string, out: string): void {
  try {
    chmodSync(partial, 0o600);
  } catch {
    // Windows: nothing to chmod. The package is still written and flushed.
  }
  try {
    renameSync(partial, out);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw snapshotError(
      "io_error",
      `Cannot replace the package at ${out}: ${message}. The partial package was removed.`,
    );
  }
}

/**
 * Delete the half-written package. Best effort by design: on Windows a closing
 * write handle can still hold the file for a moment, so a few short retries are
 * what makes "the partial is gone" true in practice. A file that is already
 * absent is success.
 */
async function removePartialPackage(partial: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      unlinkSync(partial);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return;
      if (attempt === 4) return;
      await new Promise<void>((reached) => {
        setTimeout(reached, 20 * (attempt + 1));
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Failure classification                                              */
/* ------------------------------------------------------------------ */

/**
 * Turn anything thrown by the pipeline into the `SnapshotError` the CLI maps to
 * a `--json` code and an exit code.
 *
 * A `SnapshotError` is already classified and already names the failing entry
 * (the scope walk, the secret read and the settings read all report that way),
 * so it passes through untouched. A codec error keeps its own class through
 * `TAR_CODE_TO_SNAPSHOT`. Anything else is an unexpected I/O-shaped failure.
 *
 * The message always carries the first failing entry plus the failure total
 * (§5.11.3) — for an all-or-nothing export one abort is one failure.
 */
function describeExportFailure(
  error: unknown,
  plannedEntries: number,
  partialStarted: boolean,
): SnapshotError {
  if (error instanceof SnapshotError) return error;

  const detail = error instanceof Error ? error.message : String(error);
  const code = isTarStreamError(error)
    ? TAR_CODE_TO_SNAPSHOT[error.code]
    : "io_error";
  const summary = partialStarted
    ? ` 1 entry failed of ${plannedEntries} planned; the partial package was removed.`
    : " 1 failure; nothing was written.";
  return snapshotError(code, `Export failed: ${detail}.${summary}`);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function reportProgress(
  onProgress: SnapshotProgressHandler | undefined,
  phase: SnapshotPhase,
  message: string,
  current?: number,
  total?: number,
): void {
  if (onProgress === undefined) return;
  const progress: SnapshotProgress = { phase, message };
  if (current !== undefined) progress.current = current;
  if (total !== undefined) progress.total = total;
  onProgress(progress);
}

function statOrUndefined(target: string) {
  try {
    return statSync(target);
  } catch {
    return undefined;
  }
}
