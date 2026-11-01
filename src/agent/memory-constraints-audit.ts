import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT } from "./memory-constraints";

export interface MemoryConstraintsValidationResult {
  valid: boolean;
  output: string;
}

export interface InvalidPendingMemory {
  status: "invalid";
  summary: string;
  memoryDir: string;
  localOnly: boolean;
}

/** Persistent MemFS layout policy recorded beside the memory repository. */
export type MemoryLayoutPolicy =
  | "legacy-only"
  | "root-marker"
  | "shared-memory";

/**
 * Read the layout policy the harness recorded in the repository's common Git
 * directory. Repositories created outside the harness carry no policy file, so
 * the committed root `MEMORY.md` history is the fallback signal; an unknown or
 * missing value means `legacy-only`.
 *
 * Kept as the single implementation: the dream layout facts (W1) read the same
 * policy and must not drift from the commit-time audit.
 */
export function readMemoryLayoutPolicy(memoryDir: string): MemoryLayoutPolicy {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: memoryDir,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    const policy = readFileSync(
      resolve(memoryDir, commonDir, "letta-memory-layout-policy"),
      "utf8",
    ).trim();
    if (policy === "legacy-only" || policy === "shared-memory") return policy;
    if (policy === "root-marker") {
      const v2Started = execFileSync(
        "git",
        ["rev-list", "-n", "1", "HEAD", "--", "MEMORY.md"],
        { cwd: memoryDir, encoding: "utf8", windowsHide: true },
      ).trim();
      return v2Started ? "root-marker" : "legacy-only";
    }
  } catch {
    /* Repositories created outside the harness have no persistent policy. */
  }
  return spawnSync("git", ["cat-file", "-e", "HEAD:MEMORY.md"], {
    cwd: memoryDir,
    stdio: "ignore",
    windowsHide: true,
  }).status === 0
    ? "root-marker"
    : "legacy-only";
}

/** Validate the committed MemFS tree without changing its index or working tree. */
export function validateMemoryConstraintsHead(
  memoryDir: string,
): MemoryConstraintsValidationResult {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-memory-audit-"));
  const indexPath = join(tempDir, "index");
  const validatorPath = join(tempDir, "validator.cjs");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };

  try {
    execFileSync("git", ["read-tree", "HEAD"], {
      cwd: memoryDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const layoutPolicy = readMemoryLayoutPolicy(memoryDir);
    writeFileSync(validatorPath, MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT, "utf8");
    const result = spawnSync(
      "node",
      [validatorPath, "--layout", layoutPolicy, "--audit"],
      {
        cwd: memoryDir,
        encoding: "utf8",
        env,
        windowsHide: true,
      },
    );
    return {
      valid: result.status === 0,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    };
  } catch (error) {
    return {
      valid: false,
      output: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Validate the tree post-turn sync would publish. Hosted MemFS validates only
 * the pushed tip, and the runtime loads only the head of main, so intermediate
 * commits are not checked.
 */
export function invalidPendingMemory(
  memoryDir: string,
  localOnly: boolean,
): InvalidPendingMemory | null {
  const validation = validateMemoryConstraintsHead(memoryDir);
  if (validation.valid) return null;
  return {
    status: "invalid",
    summary: `Committed memory fails validation:\n${validation.output}`,
    memoryDir,
    localOnly,
  };
}
