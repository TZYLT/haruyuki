/**
 * `MemoryCommit` — the dream run's shell-free way to make memory edits durable
 * (F-06 Q-13 / Q-53, requirement §5.4.4).
 *
 * A dream run is unattended and defaults to `acceptEdits`, which deliberately
 * does not allow Bash. Without this tool the only way to commit would be
 * `unrestricted`, contradicting the "least privilege" requirement. The tool
 * calls the harness's own commit path, so it cannot do what the memory
 * constraints forbid (no staging outside the agent's memory repository, no
 * `.git`, no shell).
 *
 * The permission layer auto-allows this tool **only inside a dream run
 * context** (`permissions/dream-run-guard.ts`); in an ordinary session it is
 * not declared at all, and a direct call still falls back to the normal ask
 * path.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCurrentAgentId, getCurrentAgentName } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  type CommitMemoryWriteParams,
  type CommitMemoryWriteResult,
  commitMemoryWrite,
} from "@/agent/memory-git";
import { getBackend } from "@/backend";
import { validateRequiredParams } from "./validation";

const TOOL_NAME = "MemoryCommit";

/** Longest commit subject accepted; keeps the git log readable. */
export const MEMORY_COMMIT_MAX_REASON_CHARS = 200;
/** Most pathspecs accepted in one call. */
export const MEMORY_COMMIT_MAX_PATHS = 100;

export interface MemoryCommitArgs {
  reason: string;
  paths: string[];
}

export interface MemoryCommitResult {
  content: string;
  status: "success" | "error";
}

/** Injection seams for tests; production callers pass nothing. */
export interface MemoryCommitDeps {
  agentId?: string;
  agentName?: string;
  memoryDir?: string;
  commit?: (
    params: CommitMemoryWriteParams,
  ) => Promise<CommitMemoryWriteResult>;
}

/**
 * Normalize one repository-relative path, or `null` when it must be refused.
 *
 * Rejecting absolute paths, drive letters, `..`, `.` and any `.git` segment is
 * the tool's whole security surface: the commit path itself is the harness's,
 * and a pathspec escaping the repository would let an unattended run touch the
 * workspace (requirement invariants 1 and 7).
 */
export function normalizeMemoryCommitPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return null;
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return null;
    if (segment === "." || segment === "..") return null;
    if (segment.toLowerCase() === ".git") return null;
  }
  return segments.join("/");
}

function error(content: string): MemoryCommitResult {
  return { content, status: "error" };
}

/**
 * Stage and commit the given memory paths.
 *
 * Returns a `status: "error"` result (not a throw) for refusals the model can
 * correct — a bad path, an empty path list, nothing to commit — and lets
 * unexpected git failures throw so the tool executor records a tool error.
 */
export async function memory_commit(
  args: MemoryCommitArgs,
  deps: MemoryCommitDeps = {},
): Promise<MemoryCommitResult> {
  validateRequiredParams(args, ["reason", "paths"], TOOL_NAME);

  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (reason.length === 0) {
    return error(`${TOOL_NAME}: "reason" must be a non-empty commit message.`);
  }
  if (reason.length > MEMORY_COMMIT_MAX_REASON_CHARS) {
    return error(
      `${TOOL_NAME}: "reason" is ${reason.length} characters; the limit is ${MEMORY_COMMIT_MAX_REASON_CHARS}.`,
    );
  }
  if (reason.includes("\n")) {
    return error(
      `${TOOL_NAME}: "reason" must be one line (no newlines); put details in the memory file itself.`,
    );
  }
  if (!Array.isArray(args.paths) || args.paths.length === 0) {
    return error(`${TOOL_NAME}: "paths" must list at least one changed path.`);
  }
  if (args.paths.length > MEMORY_COMMIT_MAX_PATHS) {
    return error(
      `${TOOL_NAME}: "paths" has ${args.paths.length} entries; the limit is ${MEMORY_COMMIT_MAX_PATHS}.`,
    );
  }

  const pathspecs: string[] = [];
  for (const raw of args.paths) {
    const normalized = normalizeMemoryCommitPath(raw);
    if (normalized === null) {
      return error(
        `${TOOL_NAME}: invalid path ${JSON.stringify(raw)}. Use a memory-repository-relative path such as "MEMORY.md" or "projects/acme"; absolute paths, "..", "." and ".git" are refused.`,
      );
    }
    if (!pathspecs.includes(normalized)) pathspecs.push(normalized);
  }

  let agentId = deps.agentId;
  if (!agentId) {
    try {
      agentId = getCurrentAgentId();
    } catch {
      return error(
        `${TOOL_NAME}: no agent is available in this execution context, so there is no memory repository to commit.`,
      );
    }
  }

  const backend = getBackend();
  if (!backend.capabilities.localMemfs) {
    return error(
      `${TOOL_NAME}: commits require the local backend's memory repository.`,
    );
  }

  const memoryDir = deps.memoryDir ?? getScopedMemoryFilesystemRoot(agentId);
  if (!existsSync(join(memoryDir, ".git"))) {
    return error(
      `${TOOL_NAME}: the agent's memory directory is not a git repository (${memoryDir}).`,
    );
  }

  const commit = deps.commit ?? commitMemoryWrite;
  const result = await commit({
    memoryDir,
    pathspecs,
    reason,
    author: {
      agentId,
      authorName: deps.agentName ?? getCurrentAgentName() ?? agentId,
    },
    // Dreams only run on the local backend; the remote sync path is the
    // main-session flow and is deliberately not reachable from this tool.
    syncMode: "local",
  });

  if (!result.committed || !result.sha) {
    return {
      content: `Nothing to commit for ${pathspecs.join(", ")}.`,
      status: "success",
    };
  }
  return {
    content: `Committed ${result.sha.slice(0, 12)}: ${reason}`,
    status: "success",
  };
}
