/**
 * `DreamReviewMark` — the dream run's "I reviewed this file properly" call
 * (F-06 §5.10.3, checklist §3 W6).
 *
 * The decay recurrence in `agent/dream/dream-decay.ts` has one failure mode: a
 * clean file that nobody touches keeps `rr = 1`, so its carried decay never
 * falls and it sits at the top of the ranking forever, starving every other
 * file. A review mark is the only way the run can say "I looked at this file,
 * it is not rotting" and let the end-of-run ledger update drop it. The mark
 * carries one line of `evidence` so the report can show *what* was reviewed —
 * a mark without evidence would be a way to silence the ranking, not a review.
 *
 * What this tool is **not**: a todo tool, a progress marker, or a memory write.
 * Calling it claims the review already happened; it writes one JSONL line to
 * `<harness home>/dream/runs/<runId>/marks.jsonl` (never into the memory
 * repository) and changes no memory content. The storage module
 * (`agent/dream/dream-review-marks.ts`) owns the file format; this tool owns
 * the model-facing contract: dream-run context, repository-relative path,
 * existing file, bounded single-line evidence.
 *
 * Availability: the tool is declared only on a dream run's hidden conversation
 * (`tools/dream-tool-names.ts`), and the permission checker auto-allows it only
 * while `runtime-context.dreamRun` is set (`permissions/dream-run-guard.ts`).
 * A direct call outside a dream run is still refused here — the declaration is
 * a prompt surface, not a security boundary.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import {
  appendReviewMark,
  DREAM_REVIEW_COVERAGES,
  DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS,
  type DreamReviewCoverage,
} from "@/agent/dream/dream-review-marks";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getBackend } from "@/backend";
import { isDreamRun } from "@/permissions/dream-run-guard";
import { getRuntimeContext } from "@/runtime-context";
import { readDreamRunMetadata } from "@/types/dream-run-metadata";
import { isRecord } from "@/utils/type-guards";
import { normalizeMemoryCommitPath } from "./memory-commit";

const TOOL_NAME = "DreamReviewMark";

export interface DreamReviewMarkArgs {
  path?: unknown;
  coverage?: unknown;
  evidence?: unknown;
}

/** Injection seams for tests; production callers pass nothing. */
export interface DreamReviewMarkDeps {
  /** Overrides the ambient agent resolution; tests pin it. */
  agentId?: string;
  /** Overrides the resolved memory repository root; tests pin it. */
  memoryDir?: string;
  /** Overrides the runtime-context conversation used by the run-id fallback. */
  conversationId?: string | null;
  /** Overrides the dream-run detection; tests pin it. */
  dreamRun?: boolean;
  /** Overrides the runtime-context run id; tests pin it. */
  runId?: string;
  /** Epoch ms; defaults to the clock. Pinned by tests. */
  now?: number;
  /** Injection seam for the marks writer; production uses `appendReviewMark`. */
  append?: typeof appendReviewMark;
  /** Injection seam for the conversation-metadata run-id fallback. */
  backend?: { retrieveConversation(conversationId: string): Promise<unknown> };
}

/** The recorded mark, mirrored back so a caller can see what was written. */
export interface RecordedDreamReviewMark {
  run_id: string;
  path: string;
  coverage: DreamReviewCoverage;
}

/**
 * The tool result. `content` + `status` is the tool-runner contract; `ok` and
 * `mark` are the structured payload (null on a refusal).
 */
export interface DreamReviewMarkResult {
  content: string;
  status: "success" | "error";
  ok: boolean;
  mark: RecordedDreamReviewMark | null;
}

function error(content: string): DreamReviewMarkResult {
  return { content, status: "error", ok: false, mark: null };
}

function isCoverage(value: string): value is DreamReviewCoverage {
  return (DREAM_REVIEW_COVERAGES as readonly string[]).includes(value);
}

function resolveAgentId(deps: DreamReviewMarkDeps): string | null {
  if (deps.agentId) return deps.agentId;
  const runtimeAgentId = getRuntimeContext()?.agentId;
  if (typeof runtimeAgentId === "string" && runtimeAgentId.length > 0) {
    return runtimeAgentId;
  }
  try {
    return getCurrentAgentId();
  } catch {
    return null;
  }
}

function resolveConversationId(deps: DreamReviewMarkDeps): string | null {
  if (deps.conversationId !== undefined) return deps.conversationId;
  const runtimeConversationId = getRuntimeContext()?.conversationId;
  if (
    typeof runtimeConversationId === "string" &&
    runtimeConversationId.length > 0
  ) {
    return runtimeConversationId;
  }
  try {
    return getConversationId();
  } catch {
    return null;
  }
}

/**
 * The run id the marks file belongs to.
 *
 * The dream child sets `dreamRunId` on the runtime context (`dream-run-wiring`
 * does it for W7 too), so the common path never touches the backend. The
 * fallback reads the durable run record off the hidden conversation: a child
 * that somehow lost the context value must still be able to record a mark
 * rather than fail mid-review, and the conversation is the same authority
 * `DreamDone`/`DreamStatus` read.
 */
async function resolveRunId(deps: DreamReviewMarkDeps): Promise<string | null> {
  if (deps.runId !== undefined) {
    const pinned = deps.runId.trim();
    return pinned.length > 0 ? pinned : null;
  }
  const runtimeRunId = getRuntimeContext()?.dreamRunId;
  if (typeof runtimeRunId === "string" && runtimeRunId.trim().length > 0) {
    return runtimeRunId.trim();
  }
  const conversationId = resolveConversationId(deps);
  if (conversationId === null) return null;
  const backend = deps.backend ?? getBackend();
  let record: unknown;
  try {
    record = await backend.retrieveConversation(conversationId);
  } catch {
    return null;
  }
  const metadata = readDreamRunMetadata(
    isRecord(record) ? record.dream : undefined,
  );
  return metadata?.runId ?? null;
}

function resolveMemoryDir(
  agentId: string,
  deps: DreamReviewMarkDeps,
): { memoryDir: string } | { error: string } {
  if (deps.memoryDir) return { memoryDir: deps.memoryDir };
  if (!getBackend().capabilities.localMemfs) {
    return {
      error: `${TOOL_NAME}: review marks describe the local backend's memory repository, and this process is not using it.`,
    };
  }
  return { memoryDir: getScopedMemoryFilesystemRoot(agentId) };
}

/** `null` when the file exists inside the repository, otherwise the refusal. */
function checkMemoryFile(
  memoryDir: string,
  relativePath: string,
): string | null {
  const file = join(memoryDir, ...relativePath.split("/"));
  if (!existsSync(file)) {
    return `${TOOL_NAME}: "${relativePath}" does not exist in the memory repository. Pass the repository-relative path of a file you have actually read.`;
  }
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return `${TOOL_NAME}: "${relativePath}" is not a regular file in the memory repository, so there is no review to record for it.`;
  }
  return null;
}

/**
 * Record one review mark.
 *
 * Refusals (wrong context, bad coverage, bad path, missing file, empty or
 * multi-line evidence, no run id) come back as `status: "error"` results the
 * model can correct; nothing is written for them.
 */
export async function dream_review_mark(
  args: DreamReviewMarkArgs,
  deps: DreamReviewMarkDeps = {},
): Promise<DreamReviewMarkResult> {
  const dreamRun = deps.dreamRun ?? isDreamRun();
  if (!dreamRun) {
    return error(
      `${TOOL_NAME}: only a dream run can record review marks. This call did not come from a dream run, so nothing was recorded — the tool is declared only on a dream conversation, and an ordinary session has no review queue to mark.`,
    );
  }

  if (typeof args.coverage !== "string") {
    return error(
      `${TOOL_NAME}: "coverage" is required and must be one of ${DREAM_REVIEW_COVERAGES.join(", ")}.`,
    );
  }
  const coverage = args.coverage;
  if (!isCoverage(coverage)) {
    return error(
      `${TOOL_NAME}: "coverage" must be one of ${DREAM_REVIEW_COVERAGES.join(", ")}; received ${JSON.stringify(coverage)}.`,
    );
  }

  if (typeof args.path !== "string") {
    return error(
      `${TOOL_NAME}: "path" is required — the memory-repository-relative path of the reviewed file (for example "system/human.md").`,
    );
  }
  const path = normalizeMemoryCommitPath(args.path);
  if (path === null) {
    return error(
      `${TOOL_NAME}: invalid path ${JSON.stringify(args.path)}. Use a memory-repository-relative path such as "system/human.md"; absolute paths, "..", "." and ".git" are refused.`,
    );
  }

  if (typeof args.evidence !== "string") {
    return error(
      `${TOOL_NAME}: "evidence" is required — one line (at most ${DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS} characters) naming what was actually checked.`,
    );
  }
  const evidence = args.evidence.trim();
  if (evidence.length === 0) {
    return error(
      `${TOOL_NAME}: "evidence" must not be empty. Say which links, index entries, sections or contradictions you checked — a mark without evidence is not a review.`,
    );
  }
  if (evidence.includes("\n") || evidence.includes("\r")) {
    return error(
      `${TOOL_NAME}: "evidence" must be a single line (no newlines or carriage returns); summarize the review in one sentence.`,
    );
  }
  if (evidence.length > DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS) {
    return error(
      `${TOOL_NAME}: "evidence" is ${evidence.length} characters; the limit is ${DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS}. Summarize the review in one shorter line.`,
    );
  }

  const agentId = resolveAgentId(deps);
  if (agentId === null) {
    return error(
      `${TOOL_NAME}: no agent is available in this execution context, so there is no memory repository to review.`,
    );
  }
  const resolvedMemoryDir = resolveMemoryDir(agentId, deps);
  if ("error" in resolvedMemoryDir) return error(resolvedMemoryDir.error);
  const fileError = checkMemoryFile(resolvedMemoryDir.memoryDir, path);
  if (fileError !== null) return error(fileError);

  const runId = await resolveRunId(deps);
  if (runId === null) {
    return error(
      `${TOOL_NAME}: this dream turn has no run id (neither the runtime context nor the run record carries one), so the mark cannot be filed. Nothing was recorded.`,
    );
  }

  const append = deps.append ?? appendReviewMark;
  const appended = await append({
    runId,
    path,
    coverage,
    evidence,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (!appended.ok) {
    return error(`${TOOL_NAME}: ${appended.error}`);
  }

  return {
    content: [
      `${TOOL_NAME}: recorded coverage=${coverage} for ${path} in run ${runId}.`,
      `Evidence: ${evidence}`,
      "The run's end-of-run ledger update treats this file as reviewed: its carried decay is cleared and its `next` note is dropped. The evidence goes into the decay index and the run report.",
      "This recorded a review only — it did not edit, move or commit the file. If the file needs work, do the work and commit it with MemoryCommit first, then mark the result.",
    ].join("\n"),
    status: "success",
    ok: true,
    mark: { run_id: runId, path, coverage },
  };
}
