/**
 * Landing half of the import pipeline: the package path preflight, the
 * managed-tree clear (snapshot semantics) and the atomic placement of entries.
 *
 * Placement streams an entry straight from the archive into a temporary file in
 * the target directory, fsyncs it and renames it over the target, so a crash
 * never leaves a half-written file. Bytes and SHA-256 are re-checked while each
 * entry is written: the archive is read twice (verify, then place), and a
 * package swapped between the two passes must not land.
 *
 * Clearing is deliberately selective. Only paths that match one of the include
 * rows in `SCOPE_RULES` are removed, and exclude rows win: a package-outside file
 * under `logs/`, `backups/` or `mods/diagnostics/` survives an import unchanged
 * (requirement doc sections 5.3 and 5.8.1).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { readTarGz } from "@/utils/tar-stream";
import { formatBytes } from "./report";
import {
  assertNoCaseCollision,
  matchesScopePattern,
  SCOPE_RULES,
  usesLiteralHomeRoot,
} from "./scope";
import type {
  SnapshotEntry,
  SnapshotManifest,
  SnapshotProgressHandler,
  SnapshotScope,
} from "./types";
import { SnapshotError, snapshotError } from "./types";

/**
 * Target roots this import would write to.
 *
 * `home` is the app home root (honours `HARUYUKI_HOME`). `homeLiteral` is the
 * literal `homedir()` base that `channels/` and `transcripts/` actually read and
 * write, so those two package trees must land there even when the two bases
 * differ (docs/45-2 section 1 "path mismatch"). `project` is optional.
 */
export interface ImportTargetRoots {
  home: string;
  /** Literal-home base for `channels/` and `transcripts/`; see `literalHomeBase`. */
  homeLiteral: string;
  localBackend: string;
  project?: string;
}

/** One verified package entry plus the archive kind the manifest cannot carry. */
export interface PackageEntry {
  path: string;
  scope: SnapshotScope;
  kind: "file" | "dir";
  bytes: number;
  sha256: string;
}

/** The manifest-shaped view of a package entry. */
export function toSnapshotEntry(entry: PackageEntry): SnapshotEntry {
  return {
    path: entry.path,
    scope: entry.scope,
    bytes: entry.bytes,
    sha256: entry.sha256,
  };
}

/** Root-level entries that are not part of the mirror layout. */
export const PACKAGE_MANIFEST_PATH = "manifest.json";
export const PACKAGE_SECRETS_PATH = "secrets.json";

const TREE_SCOPES: ReadonlyArray<SnapshotScope> = [
  "home",
  "local-backend",
  "project",
];

const EXCLUDE_RULES = SCOPE_RULES.filter((rule) => !rule.include);
const INCLUDE_RULES = SCOPE_RULES.filter((rule) => rule.include);

/**
 * Top-level `home/` segments whose real directory is the literal home base, not
 * the app home root. Derived from the same rule table and helper the export walk
 * uses (`home/channels/**`, `home/transcripts/**`), so the two sides can never
 * disagree about which directories move.
 */
const LITERAL_HOME_SEGMENTS: ReadonlySet<string> = new Set(
  INCLUDE_RULES.filter(
    (rule) => rule.scope === "home" && usesLiteralHomeRoot(rule.pattern),
  )
    .map((rule) => rule.pattern.split("/")[1] ?? "")
    .filter((segment) => segment.length > 0),
);

const PROGRESS_EVERY = 500;

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

/**
 * The scope a package path belongs to, or `undefined` when the path is outside
 * the fixed layout. A bare `home`, `local-backend` or `project` entry names the
 * tree root itself (some packers emit those directory entries).
 */
export function packageScopeOf(path: string): SnapshotScope | undefined {
  if (path === PACKAGE_SECRETS_PATH) return "secrets";
  for (const scope of TREE_SCOPES) {
    if (path === scope || path.startsWith(`${scope}/`)) return scope;
  }
  return undefined;
}

/**
 * Which root a package entry lands in. `channels/` and `transcripts/` follow the
 * literal home base (that is where the app reads them); everything else under
 * `home/` follows the app home root.
 */
function baseForEntry(
  path: string,
  scope: SnapshotScope,
  roots: ImportTargetRoots,
): string | undefined {
  if (scope === "home") {
    return usesLiteralHomeRoot(path) ? roots.homeLiteral : roots.home;
  }
  if (scope === "local-backend") return roots.localBackend;
  if (scope === "project") return roots.project;
  return undefined;
}

/**
 * The archive-shaped path of a package that lives inside one of the target
 * roots, or `undefined` when it lives elsewhere.
 *
 * A package stored inside the data it restores would otherwise be deleted by the
 * clear between the verify pass and the placement pass, so the caller adds this
 * path to the "must survive" set. Both home bases are checked: the package may
 * live under the app home root or under the literal one.
 */
export function packagePathInRoots(
  packagePath: string,
  roots: ImportTargetRoots,
): string | undefined {
  const resolvedPackage = resolve(packagePath);
  const candidates: ReadonlyArray<{ root: string; prefix: string }> = [
    { root: roots.home, prefix: "home" },
    { root: roots.homeLiteral, prefix: "home" },
    { root: roots.localBackend, prefix: "local-backend" },
    ...(roots.project === undefined
      ? []
      : [{ root: roots.project, prefix: "project" }]),
  ];
  for (const candidate of candidates) {
    const relativePath = relative(resolve(candidate.root), resolvedPackage);
    if (relativePath.length === 0) continue;
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
    return `${candidate.prefix}/${relativePath.split(sep).join("/")}`;
  }
  return undefined;
}

/**
 * Absolute target of a package path, or `undefined` for the generated
 * `secrets.json` entry (it is written back through the secret stores, not as a
 * file). Throws `path_conflict` for a path outside the layout or for project
 * data with no resolved project target.
 */
export function entryTarget(
  path: string,
  roots: ImportTargetRoots,
): { root: string; rel: string } | undefined {
  const scope = packageScopeOf(path);
  if (!scope) {
    throw snapshotError(
      "path_conflict",
      `package entry ${path} is outside the fixed package layout`,
    );
  }
  if (scope === "secrets") return undefined;
  const root = baseForEntry(path, scope, roots);
  if (!root) {
    throw snapshotError(
      "path_conflict",
      `package entry ${path} needs a project target, but none was resolved; pass --with-project=<dir>`,
    );
  }
  const rel = path === scope ? "" : path.slice(scope.length + 1);
  return { root, rel };
}

function absoluteTarget(root: string, rel: string): string {
  return rel.length === 0 ? resolve(root) : join(resolve(root), rel);
}

/**
 * True for project entries when no project target was resolved: the import
 * deliberately leaves the project tree alone (the pipeline reports a warning).
 */
function skipsProjectEntry(path: string, roots: ImportTargetRoots): boolean {
  if (roots.project !== undefined) return false;
  return path === "project" || path.startsWith("project/");
}

/**
 * Package-internal path preflight: names that differ only in case cannot both be
 * restored on a case-insensitive filesystem, and an entry that needs a file as
 * its parent directory can never be written (requirement doc sections 5.14.3 and
 * 5.11.4).
 */
export function assertPackagePathsSafe(
  entries: ReadonlyArray<PackageEntry>,
): void {
  const namesByDirectory = new Map<string, string[]>();
  const filePaths = new Set<string>();

  for (const entry of entries) {
    const cut = entry.path.lastIndexOf("/");
    const directory = cut === -1 ? "" : entry.path.slice(0, cut);
    const name = cut === -1 ? entry.path : entry.path.slice(cut + 1);
    const names = namesByDirectory.get(directory);
    if (names) {
      names.push(name);
    } else {
      namesByDirectory.set(directory, [name]);
    }
    if (entry.kind === "file") filePaths.add(entry.path);
  }

  for (const [directory, names] of namesByDirectory) {
    assertNoCaseCollision(
      directory.length === 0 ? "the package root" : directory,
      names,
    );
  }

  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (filePaths.has(ancestor)) {
        throw snapshotError(
          "path_conflict",
          `package entry ${entry.path} needs ${ancestor} to be a directory, but the package makes it a file`,
        );
      }
    }
  }
}

/**
 * Target-shape preflight: a directory entry over an existing file (or the other
 * way round) can never be placed, and a symbolic link at the target could
 * redirect the write outside the root. Both are refused before the confirmation
 * word, so the user is never asked to approve an import that must fail.
 */
export function assertTargetShapes(
  entries: ReadonlyArray<PackageEntry>,
  roots: ImportTargetRoots,
): void {
  for (const entry of entries) {
    if (skipsProjectEntry(entry.path, roots)) continue;
    const target = entryTarget(entry.path, roots);
    if (!target) continue;
    const absolute = absoluteTarget(target.root, target.rel);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(absolute);
    } catch {
      continue;
    }
    // The root itself is the path the user configured (a symlinked storage root
    // is legitimate); a link BELOW it could redirect a write outside the root.
    if (target.rel.length > 0 && info.isSymbolicLink()) {
      throw snapshotError(
        "path_conflict",
        `cannot restore ${entry.path}: the target is a symbolic link (${absolute})`,
      );
    }
    if (target.rel.length > 0 && entry.kind === "dir" && !info.isDirectory()) {
      throw snapshotError(
        "path_conflict",
        `cannot restore directory ${entry.path}: the target is a file (${absolute})`,
      );
    }
    if (target.rel.length > 0 && entry.kind === "file" && info.isDirectory()) {
      throw snapshotError(
        "path_conflict",
        `cannot restore file ${entry.path}: the target is a directory (${absolute})`,
      );
    }
  }
}

function isExcludedPath(path: string): boolean {
  for (const rule of EXCLUDE_RULES) {
    if (matchesScopePattern(rule.pattern, path)) return true;
  }
  for (const rule of INCLUDE_RULES) {
    const nested = rule.nestedExcludes;
    if (!nested) continue;
    const directory = rule.pattern.split("/").slice(0, -1).join("/");
    for (const name of nested) {
      const prefix = `${directory}/${name}`;
      if (path === prefix || path.startsWith(`${prefix}/`)) return true;
    }
  }
  return false;
}

function isManagedPath(path: string): boolean {
  for (const rule of INCLUDE_RULES) {
    if (rule.scope === "secrets") continue;
    if (matchesScopePattern(rule.pattern, path)) return true;
  }
  return false;
}

function isEmptyDirectory(directory: string): boolean {
  try {
    return readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

interface ClearTopLevelOptions {
  /** Top-level names this pass must leave to another base (the literal home). */
  skipNames?: ReadonlySet<string>;
}

function clearDirectory(
  directory: string,
  prefix: string,
  packagePaths: ReadonlySet<string>,
  topLevel?: ClearTopLevelOptions,
): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    throw snapshotError(
      "io_error",
      `cannot read ${directory} (${errorCode(error)}); the managed tree was only partly cleared`,
    );
  }

  for (const name of names) {
    if (topLevel?.skipNames?.has(name) === true) continue;
    const relativePath = `${prefix}/${name}`;
    if (isExcludedPath(relativePath)) continue;
    const absolute = join(directory, name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(absolute);
    } catch {
      // Vanished between the listing and the stat: nothing to do.
      continue;
    }

    if (info.isDirectory()) {
      // Nested directories are never filtered: the skip list is about the top
      // level of one base, where the two home families meet.
      const childRemoved = clearDirectory(absolute, relativePath, packagePaths);
      removed += childRemoved;
      // An emptied directory that is either managed itself or held managed
      // content goes away too: the restore leaves no stale empty shell behind.
      if (
        (childRemoved > 0 || isManagedPath(relativePath)) &&
        isEmptyDirectory(absolute)
      ) {
        try {
          rmdirSync(absolute);
          removed += 1;
        } catch {
          // Not empty after all (another process wrote into it): keep it.
        }
      }
      continue;
    }

    if (!isManagedPath(relativePath)) continue;
    if (packagePaths.has(relativePath)) continue;
    try {
      unlinkSync(absolute);
      removed += 1;
    } catch (error) {
      throw snapshotError(
        "io_error",
        `cannot remove ${absolute} (${errorCode(error)}); the managed tree was only partly cleared`,
      );
    }
  }

  return removed;
}

/**
 * Remove every managed path that the package does not carry (snapshot semantics,
 * requirement doc section 5.8.1). Excluded paths and unknown paths are never
 * touched. Returns how many files and directories were removed.
 *
 * The home tree is cleared in one or two passes depending on where `channels/`
 * and `transcripts/` really live: when `HARUYUKI_HOME` differs from the literal
 * home base, the app-home pass must not touch those two top-level names, and the
 * literal base is cleared separately under the same `home/...` prefixes.
 */
export function clearManagedTrees(
  roots: ImportTargetRoots,
  packagePaths: ReadonlySet<string>,
  onProgress?: SnapshotProgressHandler,
): number {
  const splitHome = resolve(roots.home) !== resolve(roots.homeLiteral);
  let removed = 0;

  if (isDirectory(roots.home)) {
    removed += clearDirectory(
      roots.home,
      "home",
      packagePaths,
      splitHome ? { skipNames: LITERAL_HOME_SEGMENTS } : undefined,
    );
    onProgress?.({
      phase: "clear",
      message: "cleared the home tree",
      current: removed,
    });
  }

  removed += clearOneTree(roots.localBackend, "local-backend", packagePaths);
  onProgress?.({
    phase: "clear",
    message: "cleared the local-backend tree",
    current: removed,
  });
  if (roots.project !== undefined) {
    removed += clearOneTree(roots.project, "project", packagePaths);
    onProgress?.({
      phase: "clear",
      message: "cleared the project tree",
      current: removed,
    });
  }

  if (splitHome) {
    for (const segment of LITERAL_HOME_SEGMENTS) {
      const directory = join(roots.homeLiteral, segment);
      if (!isDirectory(directory)) continue;
      const prefix = `home/${segment}`;
      removed += clearDirectory(directory, prefix, packagePaths);
      // The subtree root is itself covered by `home/<segment>/**`, so an empty
      // one is pruned too — but only when it is genuinely empty.
      if (isEmptyDirectory(directory) && isManagedPath(prefix)) {
        try {
          rmdirSync(directory);
          removed += 1;
        } catch {
          // Not empty after all: keep it.
        }
      }
      onProgress?.({
        phase: "clear",
        message: `cleared the literal-home ${segment} tree`,
        current: removed,
      });
    }
  }

  return removed;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function clearOneTree(
  root: string,
  prefix: string,
  packagePaths: ReadonlySet<string>,
): number {
  if (!isDirectory(root)) return 0;
  return clearDirectory(root, prefix, packagePaths);
}

/**
 * Refuse to write through a symbolic link inside a managed tree: a package path
 * must never be able to escape the target root. Directories already inspected
 * are cached, so the check costs one lstat per directory rather than per entry.
 */
function assertSafeDirectory(
  root: string,
  relDirectory: string,
  checked: Set<string>,
): void {
  if (relDirectory.length === 0) return;
  if (checked.has(relDirectory)) return;
  let current = resolve(root);
  for (const segment of relDirectory.split("/")) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw snapshotError(
          "path_conflict",
          `refusing to write through a symbolic link: ${current}`,
        );
      }
    } catch (error) {
      if (error instanceof SnapshotError) throw error;
      // Missing directory: placement creates it, nothing to follow.
    }
  }
  checked.add(relDirectory);
}

/**
 * Stream one archive entry into its target: temporary file in the same
 * directory, fsync, then rename over the target. Returns the digest that was
 * actually written so the caller can compare it with the manifest.
 */
async function writeBodyAtomically(
  absolute: string,
  stream: Readable,
): Promise<{ bytes: number; sha256: string }> {
  mkdirSync(dirname(absolute), { recursive: true });
  const temporaryPath = `${absolute}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(temporaryPath, "wx", 0o644);
  } catch (error) {
    throw snapshotError(
      "io_error",
      `cannot create ${temporaryPath} (${errorCode(error)})`,
    );
  }

  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      hash.update(chunk);
      bytes += chunk.length;
      writeSync(handle, chunk);
    }
    fsyncSync(handle);
  } catch (error) {
    try {
      closeSync(handle);
    } catch {
      // The descriptor is already gone; cleanup below is what matters.
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A failed cleanup must not mask the write error.
    }
    throw error;
  }

  try {
    closeSync(handle);
  } catch {
    // Windows can raise here after a successful write; the rename below decides.
  }
  try {
    renameSync(temporaryPath, absolute);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Same policy as above.
    }
    throw snapshotError(
      "io_error",
      `cannot restore ${absolute} (${errorCode(error)})`,
    );
  }

  return { bytes, sha256: hash.digest("hex") };
}

export interface PlacePackageRequest {
  file: string;
  roots: ImportTargetRoots;
  /** Every verified entry, keyed by package path (never `manifest.json`). */
  expected: ReadonlyMap<string, PackageEntry>;
  onProgress?: SnapshotProgressHandler;
}

/**
 * Second pass over the archive: write every entry to its target root.
 *
 * Each entry is re-hashed as it is written and compared with the verified
 * manifest claim, so a package replaced between the verification pass and this
 * one fails loudly instead of landing different bytes.
 */
export async function placePackage(
  request: PlacePackageRequest,
): Promise<number> {
  const { file, roots, expected, onProgress } = request;
  const total = expected.size;
  const checkedDirectories = new Set<string>();
  let placed = 0;
  let seen = 0;

  await readTarGz({
    file,
    onEntry: async (readEntry) => {
      seen += 1;
      if (readEntry.path === PACKAGE_MANIFEST_PATH) {
        // Manifest itself is metadata-only; it is never written to a target.
        return;
      }
      const claim = expected.get(readEntry.path);
      if (!claim) {
        throw snapshotError(
          "verify_failed",
          `the package changed while it was being imported: ${readEntry.path} is not covered by the manifest`,
        );
      }
      if (claim.kind !== readEntry.type) {
        throw snapshotError(
          "verify_failed",
          `the package changed while it was being imported: ${readEntry.path} is no longer a ${claim.kind}`,
        );
      }
      if (skipsProjectEntry(readEntry.path, roots)) {
        // No project target was resolved: the entry stays in the package, and
        // the pipeline warned that project files were not restored.
        return;
      }

      const target = entryTarget(readEntry.path, roots);
      if (target) {
        const absolute = absoluteTarget(target.root, target.rel);
        if (claim.kind === "dir") {
          assertSafeDirectory(target.root, target.rel, checkedDirectories);
          mkdirSync(absolute, { recursive: true });
        } else {
          assertSafeDirectory(
            target.root,
            dirname(target.rel) === "." ? "" : dirname(target.rel),
            checkedDirectories,
          );
          const written = await writeBodyAtomically(absolute, readEntry.open());
          if (
            written.bytes !== claim.bytes ||
            written.sha256 !== claim.sha256
          ) {
            throw snapshotError(
              "verify_failed",
              `the package changed while it was being imported: ${readEntry.path} was written with bytes=${written.bytes} sha256=${written.sha256}, expected bytes=${claim.bytes} sha256=${claim.sha256}`,
            );
          }
        }
      }

      placed += 1;
      if (placed % PROGRESS_EVERY === 0) {
        onProgress?.({
          phase: "place",
          message: "restoring package entries",
          current: placed,
          total,
        });
      }
    },
  });

  if (seen !== total + 1) {
    throw snapshotError(
      "verify_failed",
      `the package contains ${seen - 1} entries besides its manifest but ${total} were verified; it changed while it was being imported (${file})`,
    );
  }
  return placed;
}

// ── target free space (requirement 5.8 step 5) ─────────────────────

/** Headroom on top of the package data: temp files and metadata writes. */
const SPACE_HEADROOM = 1.1;

type FreeSpaceProbe = (root: string) => Promise<number | undefined>;

let freeSpaceProbeForTests: FreeSpaceProbe | null = null;

/** Test-only: replace the `fs.statfs` probe so the refusal path is reachable. */
export function __setFreeSpaceProbeForTests(
  probe: FreeSpaceProbe | null,
): void {
  freeSpaceProbeForTests = probe;
}

/** Bytes available on the volume holding `root`, or `undefined` when unknowable. */
async function availableBytesAt(root: string): Promise<number | undefined> {
  const probe = freeSpaceProbeForTests;
  if (probe) return probe(root);

  const existing = nearestExistingDirectory(root);
  if (existing === undefined) return undefined;
  try {
    const stats = await statfs(existing);
    const available = stats.bavail * stats.bsize;
    return Number.isFinite(available) ? available : undefined;
  } catch {
    // statfs is unavailable on some platforms and network filesystems. The
    // check is advisory: the import continues and a warning explains it.
    return undefined;
  }
}

function nearestExistingDirectory(target: string): string | undefined {
  let current = resolve(target);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface FreeSpaceRequest {
  manifest: SnapshotManifest;
  roots: ImportTargetRoots;
  /**
   * Absolute path of the pre-import backup that is about to be written, when one
   * will be. Its current size is part of the estimate; the caller omits it when
   * the import is restoring the backup itself and writes no new one.
   */
  backupPath?: string;
  warnings: string[];
}

/**
 * Preflight the target volumes (requirement doc section 5.8 step 5): the package
 * data plus 10% headroom, plus the existing backup's size on the home volume.
 *
 * An unknowable volume (statfs missing, unusual filesystem, missing backup) is a
 * warning, never a refusal — only a volume that positively reports too little
 * free space aborts the import (`insufficient_space`, exit code 2).
 */
export async function checkFreeDiskSpace(
  request: FreeSpaceRequest,
): Promise<void> {
  const { manifest, roots, backupPath, warnings } = request;
  const requiredByRoot = new Map<string, number>();

  for (const entry of manifest.entries) {
    if (entry.scope === "project" && roots.project === undefined) continue;
    const target = entryTarget(entry.path, roots);
    if (target === undefined) continue;
    requiredByRoot.set(
      target.root,
      (requiredByRoot.get(target.root) ?? 0) + entry.bytes,
    );
  }

  if (backupPath !== undefined) {
    let backupBytes = 0;
    try {
      backupBytes = statSync(backupPath).size;
    } catch {
      warnings.push(
        `cannot estimate the backup size: ${backupPath} does not exist yet; assuming 0 bytes`,
      );
    }
    requiredByRoot.set(
      roots.home,
      (requiredByRoot.get(roots.home) ?? 0) + backupBytes,
    );
  }

  for (const [root, bytes] of requiredByRoot) {
    if (bytes <= 0) continue;
    const required = Math.ceil(bytes * SPACE_HEADROOM);
    const available = await availableBytesAt(root);
    if (available === undefined) {
      warnings.push(
        `cannot determine the free space at ${root}; continuing without the disk-space check.`,
      );
      continue;
    }
    if (available < required) {
      throw snapshotError(
        "insufficient_space",
        `not enough free space at ${root}: the import needs about ${formatBytes(required)} (package data with 10% headroom, plus the backup estimate) but only ${formatBytes(available)} is available.`,
      );
    }
  }
}
