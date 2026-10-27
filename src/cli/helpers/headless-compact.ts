/**
 * F-04's `/compact` for headless: recognition, the ledger row, the result
 * envelope, and the output sinks.
 *
 * Headless is the path with no slash registry (§8-6), so `/compact` is
 * recognised on the input path itself — that is why the parser lives here and
 * not with the command registry. The three execution steps
 * (`prepare → pick → apply`) are **not** here: they moved to
 * `@/agent/compaction-execute`, because the websocket listener runs the same
 * steps and may not import a `cli/` module (AGENTS.md layer table). The receipt
 * copy moved with them.
 *
 * What stays is what only this mode has: the input-path parser, the usage copy a
 * headless client actually gets, the `result` envelope (§8-6: no transcript to
 * write a command row into), and the choice between the three output formats.
 *
 * The ledger row is written *here*, not in the executor — §5.14 makes the caller
 * the writer, and headless has its own ledger path (tests point it at a temporary
 * file).
 */
import { randomUUID } from "node:crypto";
import {
  compactionUsageFactsFromFailure,
  formatCompactPlanningFailure,
  type LocalCompactionFacts,
  type LocalCompactionOutcome,
  runLocalCompaction,
} from "@/agent/compaction-execute";
import type { Backend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import type { ResultMessage } from "@/types/protocol";
import type { CompactionTopicReport } from "@/types/task-control-protocol";
import {
  type CompactionUsageOutcome,
  recordCompactionUsage,
} from "@/usage/compaction-usage";
import {
  COMPACT_MODE_LOCAL_UNSUPPORTED,
  parseCompactCommandArgs,
} from "./compact-command";

/**
 * The slash commands headless can actually answer.
 *
 * Reported as `slash_commands` on the init event so an SDK client knows what it
 * may send. This is a *report*, not a dispatcher: headless has no registry, and
 * `/compact` is recognised on the input path (§8-6).
 */
export const HEADLESS_SLASH_COMMANDS: readonly string[] = ["compact"];

/**
 * Headless usage text.
 *
 * Deliberately not `COMPACT_COMMAND_USAGE`: that copy tells the reader to "pick
 * a topic block", which this mode cannot do — with no picker, a bare `/compact`
 * compresses by the rate (route C-28).
 */
export const HEADLESS_COMPACT_USAGE = [
  "/compact [n]",
  "",
  "Summarize the older part of this conversation and keep the rest.",
  "",
  "USAGE",
  "  /compact        — compress by the compression rate (there is no picker here)",
  "  /compact <n>    — keep block n of the cut-point table",
  "  /compact help   — show this help",
  "",
  "Without a number the rate decides, and the receipt names the cut it took.",
  "`/topic list` (or the TUI) shows the numbered blocks.",
].join("\n");

/** What a `/compact` line on the input path asked for. */
export type HeadlessCompactRequest =
  | { kind: "help" }
  | { kind: "compact"; blockIndex?: number }
  | { kind: "invalid"; message: string };

/**
 * Recognise `/compact` in a user-typed line, or return `null`.
 *
 * Everything else is ordinary prompt text and must stay that way: a message that
 * merely mentions `/compact` is not a command.
 */
export function parseHeadlessCompactInput(
  input: string,
): HeadlessCompactRequest | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [word, ...rest] = trimmed.split(/\s+/);
  if (word !== "/compact") return null;
  const parsed = parseCompactCommandArgs(rest);
  switch (parsed.kind) {
    case "help":
      return { kind: "help" };
    case "block":
      return { kind: "compact", blockIndex: parsed.index };
    case "invalid":
      return { kind: "invalid", message: parsed.message };
    case "mode":
      // Mode words are the cloud backend's; a local compaction always uses the
      // sliding-window strategy (§5.13).
      return { kind: "invalid", message: COMPACT_MODE_LOCAL_UNSUPPORTED };
    default:
      return { kind: "compact" };
  }
}

export interface HeadlessCompactCommandInput {
  backend: Backend;
  conversationId: string;
  agentId?: string;
  request: HeadlessCompactRequest;
  signal?: AbortSignal;
  /** Tests point this at a temporary ledger; production reads the default. */
  ledgerPath?: string;
}

export interface HeadlessCompactResult {
  success: boolean;
  output: string;
  topic_report?: CompactionTopicReport;
}

/**
 * One ledger row per attempt (§5.14): numbers and ids only.
 *
 * A run that never answered has no model to name. It stays empty rather than
 * guessing, because a guessed model would be aggregated as if the summarizer had
 * really run on it — the same rule the TUI's path follows.
 *
 * The agent id has to come from the caller or the preview: looking it up through
 * `retrieveConversation` would *create* an unknown conversation on the local
 * backend, so bookkeeping on a failed compaction would turn a zero-write exit
 * into a write (§5.9.1). A caller that cannot name the agent therefore writes no
 * row for a failure that never reached a preview — but every successful run and
 * every failed write-back still lands.
 */
async function recordCompactionRun(
  input: HeadlessCompactCommandInput,
  facts: LocalCompactionFacts,
  outcome: CompactionUsageOutcome,
): Promise<void> {
  if (facts.agentId === null) return;
  await recordCompactionUsage(
    {
      agentId: facts.agentId,
      conversationId: input.conversationId,
      model: facts.model,
      promptTokens: facts.usage?.promptTokens ?? 0,
      cachedInputTokens: facts.usage?.cachedInputTokens ?? 0,
      completionTokens: facts.usage?.completionTokens ?? 0,
      wallMs: facts.usage?.wallMs ?? 0,
      outcome,
    },
    input.ledgerPath === undefined ? {} : { path: input.ledgerPath },
  );
}

/**
 * Answer one `/compact` on the headless input path.
 *
 * Unlike the TUI there is no picker and no cancel channel: a bare `/compact`
 * takes the rate's default selection, and the only way out of a slow summarizer
 * is the process signal.
 */
export async function handleHeadlessCompactCommand(
  input: HeadlessCompactCommandInput,
): Promise<HeadlessCompactResult> {
  if (input.request.kind === "help") {
    return { success: true, output: HEADLESS_COMPACT_USAGE };
  }
  if (input.request.kind === "invalid") {
    return {
      success: false,
      output: `${input.request.message}\n\n${HEADLESS_COMPACT_USAGE}`,
    };
  }
  // The local form of the check the executor cannot make for itself: it takes
  // the three calls, not a `Backend`, so an untyped backend would fail inside
  // the run instead of here with a sentence.
  if (!(input.backend instanceof LocalBackend)) {
    return {
      success: false,
      output:
        "Compaction needs the local backend, and this session is not running on it.",
    };
  }
  let outcome: LocalCompactionOutcome;
  try {
    outcome = await runLocalCompaction({
      backend: input.backend,
      conversationId: input.conversationId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.request.blockIndex === undefined
        ? {}
        : { blockIndex: input.request.blockIndex }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    // A failed run's spend rides on the error; the row is written before the
    // failure is reported, so the receipt and the ledger cannot disagree.
    await recordCompactionRun(
      input,
      compactionUsageFactsFromFailure(error, input.agentId),
      "failed",
    );
    return {
      success: false,
      output: `Failed: ${formatCompactPlanningFailure(error)}`,
    };
  }
  // Outside the failure branch: a ledger write that did not land must not be
  // re-reported as a failed compaction.
  await recordCompactionRun(input, outcome, outcome.kind);
  if (outcome.kind === "cancelled") {
    return { success: false, output: outcome.receipt };
  }
  return {
    success: true,
    output: outcome.receipt,
    topic_report: outcome.report,
  };
}

/**
 * The `result` envelope a `/compact`-only run emits.
 *
 * Same shape a turn's result envelope has, with zero usage: the summarizer's own
 * numbers live in the receipt and in the ledger, and no turn ran.
 */
export function buildHeadlessCompactResultEnvelope(input: {
  result: HeadlessCompactResult;
  sessionId: string;
  agentId: string | null;
  conversationId: string;
}): ResultMessage & { is_error: boolean } {
  return {
    type: "result",
    subtype: input.result.success ? "success" : "error",
    is_error: !input.result.success,
    session_id: input.sessionId,
    uuid: `result-compact-${randomUUID()}`,
    agent_id: input.agentId,
    conversation_id: input.conversationId,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    result: input.result.output,
    run_ids: [],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      step_count: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    },
  };
}

/**
 * Where a `/compact` result goes in each headless output format.
 *
 * The sinks are passed in rather than imported: `headless.ts` owns stdout and
 * the wire, this module owns the choice between them — so the pinned entry file
 * gains a call site instead of a second copy of the format switch.
 */
export interface HeadlessCompactOutputSinks {
  outputFormat: string;
  sessionId: string;
  agentId: string | null;
  conversationId: string;
  writeWire: (message: ResultMessage & { is_error: boolean }) => void;
  writeStdout: (text: string) => Promise<void>;
  writeStderr: (text: string) => void;
}

export async function emitHeadlessCompactResult(
  result: HeadlessCompactResult,
  sinks: HeadlessCompactOutputSinks,
): Promise<void> {
  const envelope = buildHeadlessCompactResultEnvelope({
    result,
    sessionId: sinks.sessionId,
    agentId: sinks.agentId,
    conversationId: sinks.conversationId,
  });
  if (sinks.outputFormat === "stream-json") {
    sinks.writeWire(envelope);
    return;
  }
  if (sinks.outputFormat === "json") {
    await sinks.writeStdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  // Text keeps the old contract: success on stdout, failure on stderr.
  if (result.success) await sinks.writeStdout(`${result.output}\n`);
  else sinks.writeStderr(result.output);
}
