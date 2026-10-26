/**
 * Hard stop for the parent conversation's file-write tools while a reflection
 * run holds the memory repository (F-03 §5.7.2).
 *
 * The guard answers one synchronous question: "is this write target inside the
 * memory repository that an active reflection run is currently writing?" It
 * does not read the disk, does not take the memory lock and does not prompt —
 * `checkPermission` is synchronous, so the on-disk lock cannot be consulted
 * here (route §5.7.4). The cross-process case stays best-effort by design.
 *
 * M0 ships the seam only: the function throws, so an unwired guard cannot be
 * mistaken for an "allowed" answer. The work item that owns this module wires
 * `isReflectionRunActive` plus the existing write-target helpers
 * (`MEMORY_FILE_WRITE_TOOLS`, `writeTargets`, `isOwnMemoryWrite`), places the
 * call in `checker.ts` after the cross-agent guard and **before** the
 * own-memory allowance, and adds the rejection copy.
 */
export interface ReflectionWriteGuardInput {
  /** Canonical tool name, as the permission checker sees it. */
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** Agent whose memory may be under reflection; null when no agent is active. */
  agentId: string | null;
  workingDirectory: string;
}

export interface ReflectionWriteBlock {
  blocked: true;
  /** Full rejection text; the checker prefixes `Permission denied:` per tool. */
  message: string;
}

/**
 * Returns the rejection when the write must not proceed, `null` when it may.
 *
 * Reads, non-file tools and Bash are never blocked (§5.7.3): the requirement
 * deliberately accepts concurrent shell writes rather than narrowing the tool
 * block, which must stay byte-identical to the parent's.
 */
export function checkReflectionWriteBlock(
  input: ReflectionWriteGuardInput,
): ReflectionWriteBlock | null {
  void input;
  // Throwing (rather than answering "allowed") keeps an unwired guard loud: the
  // function must not be called before the work item that can actually decide
  // the question lands. Same convention as the F-02 M0 skeletons.
  throw new Error(
    "reflection-write-guard.checkReflectionWriteBlock: implemented at M1d",
  );
}
