/**
 * F-04 M1: the compaction summarizer.
 *
 * One in-process completion on the conversation's **own frozen prefix**, parsed
 * into the two products `/compact` needs: topic boundaries with a section each,
 * and the overview that replaces the previous one. Nothing here persists: the
 * call either returns a usable product or degrades, and a cancelled or failed
 * run leaves no trace (requirement §5.2.5, §5.9.1).
 *
 * Assembly is deliberately *not* `assembleFrozenTurnPrefix` (route C-8: it
 * rewrites frozen collections and would fake prefix drift). It is the same four
 * frozen pieces a turn uses, exactly as the M0 gate assembled them
 * (`scripts/verify-compaction-prefix.ts`, `--summarize-only`):
 *
 *   snapshot.content + snapshot.frozenSkillsBlock → systemPrompt (byte-identical)
 *   frozenToolsArray(snapshot) → toPiTools(...)   → tools (only when frozen)
 *   the frozen agent the caller passes            → the model/sampling of the turn
 *   toPiMessages(stored in-context messages)      → the projected messages
 *   + exactly one appended user instruction
 *
 * The agent is a required input, not a lookup: only the backend knows how a
 * conversation resolves its execution agent (`agent_free` sessions synthesize
 * one; a conversation-level `/model` overlay rides on top). A different record
 * is a different payload — the drift M0's prefix gate exists to catch.
 *
 * The instruction carries the fixed template (`src/agent/prompts/compaction-summarizer.md`)
 * because no per-run text may enter the byte-identical system prompt. The static
 * template is imported as text; the dynamic segments (message id table, existing
 * marker table) and the output contract are assembled below, with every piece of
 * prose in one placeholder block so wording can change without the structure.
 *
 * Failure taxonomy (requirement §5.9.3, route §6.2-4): refusal / unavailable →
 * degrade to the retired one-step summary (`degraded: "whole-section"`, no
 * topics, narrative carries it; that path keeps the old prompt and Fable's model
 * substitution, this call does not); format → retry once, then the same
 * degradation; auth / network → throw (zero writes); overflow → middle-truncate
 * the message bodies once and retry, a second overflow degrades; cancelled
 * (`stopReason: "aborted"` or an abort during the request) →
 * `CompactionCancelledError`, never retried or degraded.
 */
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";

import summarizerTemplate from "@/agent/prompts/compaction-summarizer.md";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import { toPiMessages, toPiTools } from "@/backend/dev/pi-stream-adapter";
import {
  completeProviderOnce,
  ProviderCompletionError,
  ProviderCompletionOverflowError,
} from "@/backend/dev/provider-completion";
import { isRecord } from "@/utils/type-guards";
import {
  type LocalCompactionSummaryResult,
  summarizeLocalMessagesWholeSection,
} from "./compaction";
import type {
  CompactionOverview,
  CompactionTopicDraft,
  CompactUsage,
} from "./compaction-preview";
import { resolveLocalCompactionSettings } from "./local-compaction-settings";
import type {
  LocalImageContent,
  LocalMessage,
  LocalTextContent,
  LocalThinkingContent,
  LocalToolCall,
} from "./local-message";
import { removeOrphanLocalToolResults } from "./local-message-projection";
import { LocalStore } from "./local-store";
import type { LocalAgentRecord } from "./local-types";
import { applyFrozenAgentOverrides, frozenToolsArray } from "./prefix-freeze";
import { appendCompiledSkillsBlock } from "./system-prompt-compilation";
import type { LocalTopicMarker } from "./topic-compaction";

/** Requirement §5.4: `title` ≤ 60 characters, `section` ≤ 600 characters. */
const MAX_TOPIC_TITLE_CHARS = 60;
const MAX_TOPIC_SECTION_CHARS = 600;
/** How much of a message the id table shows. */
const PREVIEW_CHARS = 60;

/**
 * Overflow ladder. The summarizer may only compress the *messages* — the system
 * segment and the frozen tools are not ours to touch (route C-4). One retry:
 * keep the first message, as many trailing messages as fit, a middle-truncated
 * digest of what was dropped, and cap any single message body.
 */
const TRUNCATED_CONTEXT_CHARS = 24_000;
const TRUNCATED_MESSAGE_CHARS = 4_000;
const TRUNCATED_DIGEST_CHARS = 6_000;

/**
 * Every piece of prose the host assembles into the tail instruction.
 *
 * Wording is a placeholder (requirement §6.2-1–§6.2-3: structure now, copy
 * later). Keep the structural parts — the heading order, the frames that
 * interpolate ids and the reply shape — and replace only the sentences.
 */
const INSTRUCTION_WORDING = {
  inputHeading: "## Conversation input",
  inputLead: (count: number): string =>
    `The conversation's context above is ${count} message(s); their ids are listed here because a topic boundary is a message id.`,
  markersHeading: "## Existing topic boundaries (fixed)",
  markersLead:
    "These boundaries already exist. Do not define a topic across one, and do not mark an id that already has a marker.",
  markersEmpty: "(none)",
  retryHeading: "## Your previous reply was rejected",
  retryLead: (reason: string): string =>
    `The reply was not usable: ${reason}\nReply again with a complete, valid JSON object.`,
  truncatedHeading: "## Truncated input",
  truncatedLead:
    "The message bodies below were middle-truncated to fit the context window; the id list is complete, so boundaries may still use any listed id.",
  contractHeading: "## Reply",
  contractLead:
    "Reply with exactly one JSON object and no other text. The first topic must start at the first listed id, every topic start must be a listed id later than the previous one, and every restricted field plus the narrative must be non-empty.",
  contractShape: `{"topics":[{"title":"...","startMessageId":"<listed id>","section":"..."}],"overview":{"restricted":{"open":"...","errors":"...","relationship":"...","memoryIndex":"..."},"narrative":"..."}}`,
} as const;

/**
 * Placeholder for the degraded whole-section product (requirement §5.9.2). The
 * body is the retired one-step summary; this lead-in is the only prose of ours,
 * and it stays empty until the user replaces it.
 */
const DEGRADED_WHOLE_SECTION_LEAD_IN = "";

/** Placeholder for the note that replaces messages dropped by the overflow ladder. */
const TRUNCATED_CONTEXT_NOTE =
  "[Earlier messages omitted here after the context window overflowed; a compressed digest follows.]";

/** Input for one compaction summarizer run. Frozen at M0 (route §2.3). */
export interface SummarizeInput {
  /**
   * The agent as the frozen prefix pinned it — the caller's
   * `frozenAgentForConversation` (live/effective record + frozen model and
   * settings). This module never re-resolves an agent: only the backend knows
   * whether the conversation is `agent_free` or carries a `/model` overlay.
   */
  agent: LocalAgentRecord;
  agentId: string;
  conversationId: string;
  storageDir: string;
  signal?: AbortSignal;
}

/**
 * What one summarizer run produced.
 *
 * On a clean run, `topics` are the boundaries the write-back will turn into
 * markers and `overview` is the new overview. On `degraded: "whole-section"`
 * the structured product could not be used: `topics` is empty (nothing to
 * mark — "no topics were generated this run") and `overview.narrative` carries
 * the one-step summary for the whole segment; the restricted fields are empty
 * because no structured reply produced them, and no section headings are
 * invented for them.
 */
export interface SummarizeResult {
  topics: CompactionTopicDraft[];
  overview: CompactionOverview;
  degraded: "whole-section" | null;
  usage: CompactUsage;
}

/** The user cancelled; nothing may be written (requirement §5.9.1). */
export class CompactionCancelledError extends Error {
  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? `The compaction summarizer was cancelled: ${cause.message}`
        : "The compaction summarizer was cancelled.",
    );
    this.name = "CompactionCancelledError";
  }
}

/** A reply that parsed but violated the output contract (retryable). */
class SummarizerFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummarizerFormatError";
  }
}

interface ContextEntry {
  message: LocalMessage;
  /** 1-based position shown in the id table. */
  index: number;
}

/** Any content part a stored message may carry. */
type LocalContentPart =
  | LocalTextContent
  | LocalThinkingContent
  | LocalImageContent
  | LocalToolCall;

interface AssembledContext {
  /** The frozen agent, with the snapshot's model/settings applied once more. */
  agent: LocalAgentRecord;
  systemPrompt: string;
  entries: ContextEntry[];
  /** The projected (provider-facing) context, without the instruction. */
  projected: Message[];
  tools: ReturnType<typeof toPiTools>;
  markers: LocalTopicMarker[];
  template: string;
}

type ParsedReply =
  | { ok: true; topics: CompactionTopicDraft[]; overview: CompactionOverview }
  | { ok: false; reason: string };

type StructuredAttempt =
  | { kind: "text"; text: string; usage: CompactUsage }
  | { kind: "format"; reason: string; usage: CompactUsage }
  | { kind: "overflow"; usage: CompactUsage }
  | {
      kind: "providerError";
      error: ProviderCompletionError;
      usage: CompactUsage;
    };

// --- public entry point ----------------------------------------------------

/**
 * Summarize one conversation with one provider completion on its frozen prefix.
 *
 * Throws (never writes) on a missing frozen snapshot, an aborted call, auth or
 * network failures, and any transport error the provider layer did not classify.
 * Returns `degraded: "whole-section"` when the structured product is unusable
 * and the retired one-step fallback answered instead.
 */
export async function summarizeConversation(
  input: SummarizeInput,
): Promise<SummarizeResult> {
  const startedAt = Date.now();
  throwIfCancelled(input.signal);
  const assembled = assembleSummarizerContext(input);
  const modelsRuntime = new LocalPiModelsRuntime({
    storageDir: input.storageDir,
  });
  let usage = emptyUsage();

  /** `wallMs` is the run's actual wall clock, both legs included (§5.14). */
  const finish = (result: SummarizeResult): SummarizeResult => ({
    ...result,
    usage: { ...result.usage, wallMs: Date.now() - startedAt },
  });

  const run = (messages: Message[]): Promise<StructuredAttempt> =>
    runStructuredAttempt({
      input,
      agent: assembled.agent,
      modelsRuntime,
      systemPrompt: assembled.systemPrompt,
      tools: assembled.tools,
      messages,
    });

  const first = await run([
    ...assembled.projected,
    userMessage(buildInstruction(assembled)),
  ]);
  usage = addUsage(usage, first.usage);

  if (first.kind === "providerError") {
    if (isAuthOrNetworkFailure(first.error.message)) {
      // Network/auth: the compaction aborts with zero writes (§5.9.3③).
      throw first.error;
    }
    // Refusal / model unavailable: the old one-step summary takes over (§5.9.3①).
    return finish(await degradeToWholeSection({ input, assembled, usage }));
  }

  let retryMessages: Message[] | undefined;
  let rejection: string | undefined;
  if (first.kind === "overflow") {
    retryMessages = [
      ...toPiMessages(truncateContextMessages(storedMessagesOf(assembled))),
      userMessage(buildInstruction(assembled, { truncated: true })),
    ];
  } else if (first.kind === "format") {
    rejection = first.reason;
  } else {
    const parsed = parseSummarizerReply(first.text, assembled.entries);
    if (parsed.ok) {
      return finish({
        topics: parsed.topics,
        overview: parsed.overview,
        degraded: null,
        usage,
      });
    }
    rejection = parsed.reason;
  }

  const second = await run(
    retryMessages ?? [
      ...assembled.projected,
      userMessage(
        buildInstruction(assembled, {
          ...(rejection ? { rejection } : {}),
        }),
      ),
    ],
  );
  usage = addUsage(usage, second.usage);

  if (second.kind === "providerError") {
    if (isAuthOrNetworkFailure(second.error.message)) throw second.error;
    return finish(await degradeToWholeSection({ input, assembled, usage }));
  }
  if (second.kind === "text") {
    const parsed = parseSummarizerReply(second.text, assembled.entries);
    if (parsed.ok) {
      return finish({
        topics: parsed.topics,
        overview: parsed.overview,
        degraded: null,
        usage,
      });
    }
  }
  // A second unusable reply (format, overflow, or empty) ends the ladder (§5.9.2).
  return finish(await degradeToWholeSection({ input, assembled, usage }));
}

// --- context assembly ------------------------------------------------------

/**
 * The four frozen pieces plus the projected messages, exactly as the M0 gate
 * assembled them. Read-only: no snapshot is compiled, rewritten, or observed.
 */
function assembleSummarizerContext(input: SummarizeInput): AssembledContext {
  const store = new LocalStore(input.agentId, {
    storageDir: input.storageDir,
    seedDefaultAgent: false,
  });
  const snapshot = store.getCompiledSystemPrompt(
    input.conversationId,
    input.agentId,
  );
  if (!snapshot) {
    throw new Error(
      `The compaction summarizer needs a frozen system prompt for conversation "${input.conversationId}"; run one turn first (requirement §5.2.2).`,
    );
  }
  const storedMessages = store.listLocalMessages(
    input.conversationId,
    input.agentId,
  );
  const entries = contextEntries(storedMessages);
  if (entries.length === 0) {
    throw new Error(
      `The compaction summarizer found no in-context messages for conversation "${input.conversationId}".`,
    );
  }
  const projected = toPiMessages(entries.map((entry) => entry.message));
  if (projected.length !== entries.length) {
    // The id table and the request must describe the same messages; a mismatch
    // means this module's projection filter drifted from `toPiMessages`.
    throw new Error(
      "The compaction summarizer's id table no longer matches the projected context.",
    );
  }
  const frozenTools = frozenToolsArray(snapshot);
  // The passed record is already the frozen one; the overlay is applied once
  // more so a caller that hands over a live record cannot send a live model.
  const agent = applyFrozenAgentOverrides(input.agent, snapshot);
  return {
    agent,
    systemPrompt: appendCompiledSkillsBlock(
      snapshot.content,
      snapshot.frozenSkillsBlock,
    ),
    entries,
    projected,
    tools: frozenTools ? toPiTools(frozenTools) : undefined,
    markers: store.contextRewrites.readTopicMarkers(
      input.conversationId,
      input.agentId,
    ),
    template: summarizerTemplateFor(agent),
  };
}

/**
 * The stored messages that actually reach the provider, in order.
 *
 * `toPiMessages` drops orphan tool results, empty text-only messages, and a
 * trailing assistant reply; the id table must make exactly the same removals or
 * a boundary could name a message the model cannot see. Orphan removal is
 * shared rather than copied, the two remaining rules mirror `toPiMessage`, and
 * `assembleSummarizerContext` asserts the counts agree — so a future change to
 * the projection fails loudly here instead of silently shifting boundaries.
 */
function contextEntries(messages: LocalMessage[]): ContextEntry[] {
  const providerSafe = removeOrphanLocalToolResults(messages).messages;
  const kept = providerSafe.filter((message) => reachesProvider(message));
  while (kept.at(-1)?.role === "assistant") kept.pop();
  return kept.map((message, position) => ({ message, index: position + 1 }));
}

/** Mirror of `toPiMessage`'s "is this message dropped as empty" rule. */
function reachesProvider(message: LocalMessage): boolean {
  if (message.role === "toolResult") return true;
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content.trim().length > 0
      : hasVisibleContent(message.content);
  }
  return hasVisibleContent(message.content);
}

/** The same "some part survives normalization" test `toPiMessage` applies. */
function hasVisibleContent(content: readonly LocalContentPart[]): boolean {
  return content.some(
    (part) => part.type !== "text" || part.text.trim().length > 0,
  );
}

/** The user instruction's dynamic segments: id table, markers, contract. */
function buildInstruction(
  assembled: AssembledContext,
  options: { rejection?: string; truncated?: boolean } = {},
): string {
  const lines: string[] = [assembled.template.trim(), ""];
  lines.push(INSTRUCTION_WORDING.inputHeading);
  lines.push(INSTRUCTION_WORDING.inputLead(assembled.entries.length));
  for (const entry of assembled.entries) {
    lines.push(
      `[${entry.index}] ${entry.message.role} id=${entry.message.id}: ${previewOf(entry.message)}`,
    );
  }
  lines.push("");
  lines.push(INSTRUCTION_WORDING.markersHeading);
  lines.push(INSTRUCTION_WORDING.markersLead);
  const markerLines = markerTable(assembled);
  lines.push(
    markerLines.length > 0
      ? markerLines.join("\n")
      : INSTRUCTION_WORDING.markersEmpty,
  );
  if (options.truncated) {
    lines.push("");
    lines.push(INSTRUCTION_WORDING.truncatedHeading);
    lines.push(INSTRUCTION_WORDING.truncatedLead);
  }
  if (options.rejection) {
    lines.push("");
    lines.push(INSTRUCTION_WORDING.retryHeading);
    lines.push(INSTRUCTION_WORDING.retryLead(options.rejection));
  }
  lines.push("");
  lines.push(INSTRUCTION_WORDING.contractHeading);
  lines.push(INSTRUCTION_WORDING.contractLead);
  lines.push(INSTRUCTION_WORDING.contractShape);
  return lines.join("\n");
}

/**
 * Existing markers whose boundary falls inside the model's input.
 *
 * A marker anchored to a message the projection dropped (typically the trailing
 * assistant reply, route C-11) is not a boundary inside what the model can see:
 * nothing can be defined across it, and naming it would invite a boundary id
 * that is not in the input table. Those are left out.
 */
function markerTable(assembled: AssembledContext): string[] {
  const inContext = new Set(assembled.entries.map((entry) => entry.message.id));
  return assembled.markers
    .filter(
      (marker) =>
        marker.anchorMessageId !== null &&
        inContext.has(marker.anchorMessageId),
    )
    .map(
      (marker) =>
        `- "${marker.title}" at id=${marker.anchorMessageId} (created by ${marker.createdBy})`,
    );
}

/** The user's custom summary prompt replaces the fixed template (§5.7.1). */
function summarizerTemplateFor(agent: LocalAgentRecord): string {
  const settings = resolveLocalCompactionSettings(agent);
  if (
    typeof settings.prompt === "string" &&
    settings.prompt.trim().length > 0
  ) {
    return settings.prompt;
  }
  return summarizerTemplate;
}

// --- one provider call -----------------------------------------------------

async function runStructuredAttempt(input: {
  input: SummarizeInput;
  agent: LocalAgentRecord;
  modelsRuntime: LocalPiModelsRuntime;
  systemPrompt: string;
  tools: ReturnType<typeof toPiTools>;
  messages: Message[];
}): Promise<StructuredAttempt> {
  throwIfCancelled(input.input.signal);
  const context: Context = {
    systemPrompt: input.systemPrompt,
    messages: input.messages,
    ...(input.tools ? { tools: input.tools } : {}),
  };
  try {
    const result = await completeProviderOnce({
      agent: input.agent,
      context,
      conversationId: input.input.conversationId,
      storageDir: input.input.storageDir,
      modelsRuntime: input.modelsRuntime,
      ...(input.input.signal ? { signal: input.input.signal } : {}),
    });
    if (result.message.stopReason === "aborted") {
      throw new CompactionCancelledError();
    }
    const text = assistantTextOf(result.message);
    if (text.trim().length === 0) {
      return {
        kind: "format",
        reason: "the reply contained no text",
        usage: result.usage,
      };
    }
    return { kind: "text", text, usage: result.usage };
  } catch (error) {
    if (error instanceof CompactionCancelledError) throw error;
    if (isAbortError(error, input.input.signal)) {
      throw new CompactionCancelledError(error);
    }
    if (error instanceof ProviderCompletionOverflowError) {
      return { kind: "overflow", usage: error.usage };
    }
    if (error instanceof ProviderCompletionError) {
      return { kind: "providerError", error, usage: error.usage };
    }
    // Anything else is a transport/setup failure the caller must see (§5.9.3③).
    throw error;
  }
}

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

function assistantTextOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// --- parsing and validation ------------------------------------------------

/**
 * Parse and validate one reply. Never throws for a bad reply: the caller retries
 * once with `reason`, then degrades (§5.9.2).
 */
function parseSummarizerReply(
  text: string,
  entries: ContextEntry[],
): ParsedReply {
  let value: unknown;
  try {
    value = parseJsonObject(text);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return validateReply(value, entries);
  } catch (error) {
    if (error instanceof SummarizerFormatError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

/**
 * The five rules from §5.9.2 and route §3 M1:
 * contiguous boundaries with no hole, a real message id at each block's head,
 * all four restricted sections non-empty, a non-empty narrative, unique titles.
 */
function validateReply(value: unknown, entries: ContextEntry[]): ParsedReply {
  const record = requireRecord(value, "the reply");
  const rawTopics = record.topics;
  if (!Array.isArray(rawTopics) || rawTopics.length === 0) {
    throw new SummarizerFormatError("topics must be a non-empty array");
  }
  const positions = messagePositions(entries);
  const ids = entries.map((entry) => entry.message.id);
  const titles = new Set<string>();
  const topics: CompactionTopicDraft[] = [];
  let previousPosition = -1;
  for (const [offset, rawTopic] of rawTopics.entries()) {
    const topic = requireRecord(rawTopic, `topics[${offset}]`);
    const title = requireText(topic.title, `topics[${offset}].title`);
    if (title.length > MAX_TOPIC_TITLE_CHARS) {
      throw new SummarizerFormatError(
        `topics[${offset}].title is ${title.length} characters; the limit is ${MAX_TOPIC_TITLE_CHARS}`,
      );
    }
    if (titles.has(title)) {
      throw new SummarizerFormatError(
        `topics[${offset}].title repeats "${title}"`,
      );
    }
    titles.add(title);
    const section = requireText(topic.section, `topics[${offset}].section`);
    if (section.length > MAX_TOPIC_SECTION_CHARS) {
      throw new SummarizerFormatError(
        `topics[${offset}].section is ${section.length} characters; the limit is ${MAX_TOPIC_SECTION_CHARS}`,
      );
    }
    const boundary = boundaryOf(topic.startMessageId, positions, ids, offset);
    if (offset === 0 && boundary.position !== 0) {
      throw new SummarizerFormatError(
        "the first topic must start at the first input message (leading hole)",
      );
    }
    if (boundary.position <= previousPosition) {
      throw new SummarizerFormatError(
        `topics[${offset}].startMessageId is not after the previous topic's start`,
      );
    }
    previousPosition = boundary.position;
    topics.push({ title, startMessageId: boundary.messageId, section });
  }
  return { ok: true, topics, overview: validateOverview(record.overview) };
}

function validateOverview(value: unknown): CompactionOverview {
  const overview = requireRecord(value, "overview");
  const restricted = requireRecord(overview.restricted, "overview.restricted");
  return {
    restricted: {
      open: requireText(restricted.open, "overview.restricted.open"),
      errors: requireText(restricted.errors, "overview.restricted.errors"),
      relationship: requireText(
        restricted.relationship,
        "overview.restricted.relationship",
      ),
      memoryIndex: requireText(
        restricted.memoryIndex,
        "overview.restricted.memoryIndex",
      ),
    },
    narrative: requireText(overview.narrative, "overview.narrative"),
  };
}

function parseJsonObject(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch (error) {
    throw new SummarizerFormatError(
      `the reply is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function messagePositions(entries: ContextEntry[]): Map<string, number> {
  return new Map(
    entries.map((entry, position) => [entry.message.id, position]),
  );
}

interface ResolvedBoundary {
  position: number;
  messageId: string;
}

/**
 * Resolve a boundary to a position in the input. A message id is the contract; a
 * 1-based index is accepted too because the input table is numbered (§5.3), and
 * the resolved id is what the draft carries.
 */
function boundaryOf(
  value: unknown,
  positions: Map<string, number>,
  ids: string[],
  offset: number,
): ResolvedBoundary {
  const at = (position: number): ResolvedBoundary | undefined => {
    const messageId = ids[position];
    return messageId === undefined ? undefined : { position, messageId };
  };
  if (typeof value === "string") {
    const trimmed = value.trim();
    const direct = positions.get(trimmed);
    if (direct !== undefined) return at(direct) ?? failBoundary(offset);
    if (/^\d+$/.test(trimmed)) {
      const byIndex = at(Number(trimmed) - 1);
      if (byIndex) return byIndex;
    }
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    const byIndex = at(value - 1);
    if (byIndex) return byIndex;
  }
  return failBoundary(offset);
}

function failBoundary(offset: number): never {
  throw new SummarizerFormatError(
    `topics[${offset}].startMessageId is not a message id from the input list`,
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SummarizerFormatError(`${label} is not a JSON object`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SummarizerFormatError(`${label} is missing or empty`);
  }
  return value.trim();
}

// --- degradation -----------------------------------------------------------

/**
 * The whole segment as one section, using the retired one-step summarizer
 * (requirement §5.9.2, §5.9.3①). No topics, no markers: the write-back folds
 * the segment with this text only, so the overview narrative carries it.
 *
 * The fallback call's own tokens are added to the run's usage — a degraded
 * compaction is exactly when the operator wants to know what it cost (§5.14).
 */
async function degradeToWholeSection(input: {
  input: SummarizeInput;
  assembled: AssembledContext;
  usage: CompactUsage;
}): Promise<SummarizeResult> {
  throwIfCancelled(input.input.signal);
  let fallback: LocalCompactionSummaryResult;
  try {
    fallback = await summarizeLocalMessagesWholeSection({
      conversationId: input.input.conversationId,
      agent: input.assembled.agent,
      messages: storedMessagesOf(input.assembled),
      storageDir: input.input.storageDir,
      ...(input.input.signal ? { signal: input.input.signal } : {}),
    });
  } catch (error) {
    if (isAbortError(error, input.input.signal)) {
      throw new CompactionCancelledError(error);
    }
    throw error;
  }
  const narrative = [DEGRADED_WHOLE_SECTION_LEAD_IN, fallback.text.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (narrative.length === 0) {
    throw new Error("The degraded whole-section summary came back empty.");
  }
  return {
    topics: [],
    overview: {
      restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
      narrative,
    },
    degraded: "whole-section",
    usage: addUsage(input.usage, fallback.usage),
  };
}

function storedMessagesOf(assembled: AssembledContext): LocalMessage[] {
  return assembled.entries.map((entry) => entry.message);
}

// --- overflow ladder -------------------------------------------------------

/**
 * "Middle truncation" over the messages only (route C-4): keep the first
 * message, the newest messages that fit the budget, a middle-truncated digest of
 * what was dropped, and cap any single body. The id table the model sees is
 * still the *full* list, so boundaries stay legal.
 */
function truncateContextMessages(messages: LocalMessage[]): LocalMessage[] {
  const first = messages[0];
  if (!first) return messages;
  const head = truncateMessage(first, TRUNCATED_MESSAGE_CHARS);
  const suffix: LocalMessage[] = [];
  let chars = localMessageText(head).length;
  for (let position = messages.length - 1; position >= 1; position -= 1) {
    const message = messages[position];
    if (!message) continue;
    const truncated = truncateMessage(message, TRUNCATED_MESSAGE_CHARS);
    const length = localMessageText(truncated).length;
    if (chars + length > TRUNCATED_CONTEXT_CHARS) break;
    suffix.unshift(truncated);
    chars += length;
  }
  while (suffix[0]?.role === "toolResult") suffix.shift();
  const dropped = messages.slice(1, messages.length - suffix.length);
  const truncated: LocalMessage[] = [head];
  if (dropped.length > 0) {
    const digest = middleTruncateText(
      dropped.map(localMessageText).join("\n\n"),
      TRUNCATED_DIGEST_CHARS,
    );
    truncated.push({
      id: `${first.id}-truncated-context`,
      role: "user",
      content: `${TRUNCATED_CONTEXT_NOTE}\n\n${digest}`,
      timestamp: Date.now(),
    });
  }
  return [...truncated, ...suffix];
}

function localMessageText(message: LocalMessage): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : contentText(message.content);
  }
  return contentText(message.content);
}

function contentText(content: readonly unknown[]): string {
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "thinking" && typeof part.thinking === "string") {
        return part.thinking;
      }
      if (part.type === "toolCall" && typeof part.name === "string") {
        return `[tool call: ${part.name}]`;
      }
      if (part.type === "image") return "[image]";
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function truncateMessage(
  message: LocalMessage,
  maxChars: number,
): LocalMessage {
  if (localMessageText(message).length <= maxChars) return message;
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return {
        ...message,
        content: middleTruncateText(message.content, maxChars),
      };
    }
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "text"
          ? { ...part, text: middleTruncateText(part.text, maxChars) }
          : part,
      ),
    };
  }
  if (message.role === "assistant") {
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { ...part, text: middleTruncateText(part.text, maxChars) };
        }
        if (part.type === "thinking") {
          return {
            ...part,
            thinking: middleTruncateText(part.thinking, maxChars),
          };
        }
        return part;
      }),
    };
  }
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "text"
        ? { ...part, text: middleTruncateText(part.text, maxChars) }
        : part,
    ),
  };
}

function middleTruncateText(text: string, budgetChars: number): string {
  if (budgetChars <= 0 || text.length <= budgetChars) return text;
  const headLength = Math.floor(budgetChars * 0.5);
  const tailLength = budgetChars - headLength;
  const dropped = text.length - headLength - tailLength;
  return `${text.slice(0, headLength)}\n[... ${dropped} characters omitted ...]\n${text.slice(text.length - tailLength)}`;
}

// --- small helpers ---------------------------------------------------------

function previewOf(message: LocalMessage): string {
  const text = localMessageText(message).replace(/\s+/g, " ").trim();
  return text.length <= PREVIEW_CHARS
    ? text
    : `${text.slice(0, PREVIEW_CHARS)}…`;
}

/** Auth and transport failures abort the compaction; everything else may degrade. */
const AUTH_OR_NETWORK_PATTERNS: readonly RegExp[] = [
  /\b(401|403|407|408|429)\b/,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid api key/i,
  /authentication/i,
  /api key/i,
  /fetch failed/i,
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i,
  /network/i,
  /socket/i,
  /timed? ?out/i,
  /connection (refused|reset|closed)/i,
];

function isAuthOrNetworkFailure(message: string): boolean {
  return AUTH_OR_NETWORK_PATTERNS.some((pattern) => pattern.test(message));
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CompactionCancelledError();
}

function emptyUsage(): CompactUsage {
  return {
    promptTokens: 0,
    cachedInputTokens: 0,
    completionTokens: 0,
    wallMs: 0,
  };
}

/**
 * Failed spend is still spend (§5.14), so every call's tokens add up — the
 * structured attempts and the degraded fallback alike. `wallMs` is only carried
 * through; the caller replaces it with the run's real wall clock.
 */
function addUsage(total: CompactUsage, next: CompactUsage): CompactUsage {
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    wallMs: total.wallMs + next.wallMs,
  };
}
