/**
 * Argument parsing and copy for `/compact` (feature ③, D-110 + D-119).
 *
 * Local compaction is no longer "summarize by ratio, automatically": the user
 * picks the topic block to keep, and the compression rate
 * (`sliding_window_percentage`) survives as the hard limit every cut is
 * measured against — a pick may never *keep* more than the rate allows — and as
 * the fallback cut when nothing has been marked. The cloud backend keeps its own
 * mode-based behaviour, so mode words still parse — the local path is what
 * rejects them.
 *
 * Everything here is pure: the CLI and the listener share the parsing and the
 * receipts, and tests cover them without a backend.
 */
import type { LocalTopicTrimOutcome } from "@/backend/local/local-topic-trim";

/** Mode words the cloud backend still accepts. */
export const COMPACT_MODE_ARGUMENTS = [
  "all",
  "sliding_window",
  "self_compact_all",
  "self_compact_sliding_window",
] as const;

export type CompactModeArgument = (typeof COMPACT_MODE_ARGUMENTS)[number];

export type CompactCommandRequest =
  | { kind: "help" }
  | { kind: "auto" }
  | { kind: "block"; index: number }
  | { kind: "mode"; mode: CompactModeArgument }
  | { kind: "invalid"; message: string };

export const COMPACT_COMMAND_USAGE = [
  "/compact [n]",
  "",
  "Summarize the older part of this conversation and keep the rest.",
  "",
  "USAGE",
  "  /compact        — pick a topic block to keep (compresses by the rate when nothing is marked)",
  "  /compact <n>    — keep block n straight away (works without a terminal)",
  "  /compact help   — show this help",
  "",
  "Every trim compresses this conversation's own history by the compression rate",
  "(sliding_window_percentage), and a cut may never keep more than that rate",
  "allows — so block 1, which keeps the whole context, is cut down to the rate's",
  "own point. `/topic list` lists the blocks, numbered oldest first.",
].join("\n");

/**
 * What a trim did, or refused to do.
 *
 * `confirmedSuggestion` covers the picker's default row: the cut is still
 * topic-aligned (the suggestion *is* a block), but the user did not choose it —
 * the compression rate did — and the receipt has to say so (V9,
 * `ratio_suggestion`).
 */
export function formatTopicTrimReceipt(
  outcome: LocalTopicTrimOutcome,
  options: { confirmedSuggestion?: boolean } = {},
): string {
  if (!outcome.executed) return formatTopicTrimRefusal(outcome);

  const confirmedSuggestion = options.confirmedSuggestion === true;
  const source = confirmedSuggestion
    ? outcome.ratioCapApplied
      ? "compression rate (the suggested block kept more, so the rate cut earlier)"
      : "compression rate (the block it points at, confirmed as it was)"
    : {
        topic_pick: "the topic block you picked",
        ratio_suggestion:
          "the compression rate (no marker defines a boundary here, so it decided)",
        ratio_cap:
          "the compression rate (the picked block kept more than the rate allows)",
      }[outcome.source];
  const lines = [
    "Context trimmed.",
    `  kept:       ${outcome.numMessagesAfter} messages (~${outcome.retainedTokens} tokens), starting at ${outcome.firstKeptMessageId ?? "the summary"}`,
    `  summarized: ${outcome.summarizedMessageCount} messages (~${outcome.summarizedTokens} tokens)`,
    `  cut point:  ${source}`,
  ];
  if (outcome.summarizedTitles.length > 0) {
    lines.push(`  topics:     ${outcome.summarizedTitles.join(", ")}`);
  }
  if (outcome.source === "topic_pick" && outcome.rewindTurns > 0) {
    lines.push(
      `  boundary:   rewound ${outcome.rewindTurns} user turn${outcome.rewindTurns === 1 ? "" : "s"} from the marker, so the new topic keeps its opening`,
    );
  }
  if (outcome.boundaryAdjusted) {
    lines.push(
      "  adjusted:   the requested cut point was moved to avoid splitting a tool call",
    );
  }
  if (outcome.ratioCapApplied) {
    lines.push(
      `  rate:       kept at most ~${outcome.retentionCapTokens ?? 0} tokens (the pick asked for ${outcome.requestedRetentionTokens})`,
    );
  }
  lines.push(
    `  before:     ${outcome.numMessagesBefore} messages in context`,
    "",
    "The evicted messages stay on disk: /search still finds them, and the summary replaces them in context.",
    "(warning: this evicts the provider cache and increases cost on the next turn)",
  );
  return lines.join("\n");
}

function formatTopicTrimRefusal(outcome: LocalTopicTrimOutcome): string {
  switch (outcome.noopReason) {
    case "empty_context":
    case "no_suggestion":
      return "There is nothing in this conversation's context to trim.";
    case "unknown_block":
      return "That topic block does not exist. Run /topic list to list the current blocks.";
    default:
      // The cut point resolved to the start of the context. The rate only does
      // that when there is nothing it can compress (one message, or a length it
      // cannot measure), so the advice is about length, not about a budget.
      if (outcome.source === "ratio_suggestion") {
        return `Nothing to trim: this conversation is too short to compress — the cut point is the start of the context, so the summary would replace nothing. Nothing was written.`;
      }
      return "Nothing to trim: that cut point is the start of the context, so everything in it is already kept. Run /topic list to see the blocks you can cut at. Nothing was written.";
  }
}

/**
 * `/compact` on a conversation that has no markers (D-119): the rate decides, so
 * the command acts instead of opening a picker with one row.
 */
export function formatNoMarkerCompactHint(
  topicMarkingEnabled: boolean,
): string {
  return topicMarkingEnabled
    ? "No topic markers yet, so the compression rate decided the cut point. Mark boundaries with /topic, or let the agent call TopicMark, to choose a cheaper-to-summarize point next time."
    : "No topic markers yet, so the compression rate decided the cut point. Topic marking is switched off, so only your own /topic markers would define blocks.";
}

/**
 * `/compact` on a conversation whose markers define no block of their own (H-2):
 * a `/topic` placed in the first turns, or every marker anchor trimmed away. The
 * picker would have one row, so the rate decides — and the note has to say *why*,
 * because "no markers yet" would be false.
 */
export function formatSingleBlockCompactHint(input: {
  topicMarkingEnabled: boolean;
  liveMarkerAnchor: boolean;
}): string {
  const why = input.liveMarkerAnchor
    ? "The marker in this conversation sits at the very start of the current context, so there is no earlier block to summarize."
    : "Every marker's anchor has left the current context, so no marker defines a boundary here.";
  const wayOut =
    "Run /topic <title> to mark a fresh boundary; /compact can cut at it.";
  return input.topicMarkingEnabled
    ? `${why} The compression rate decided the cut point instead. ${wayOut} The agent can also mark one with TopicMark when a topic ends.`
    : `${why} The compression rate decided the cut point instead. ${wayOut} Topic marking is switched off, so only your own /topic markers define blocks.`;
}

/**
 * Advisory line for the pre-send pressure check (D-112). `soft` only informs;
 * `hard` is the tier the local backend refuses to cross, so with no blocks to
 * choose between the line has to say what to do about it.
 *
 * The tier compares the **whole** context against the window (the provider's
 * `context_tokens`, which includes the compiled system prompt, memory and tool
 * definitions), while a trim compresses the **transcript** by the rate. That
 * mismatch is deliberate and no longer produces an impossible instruction: the
 * rate always has something to compress, so `/compact` is a real answer here.
 * (When the prompt floor alone fills the window, no trim can help; that case is
 * reported by the provider's own overflow error, not by this hint.)
 *
 * `hasBlocks` and `hasMarkers` are separate on purpose: markers that define no
 * boundary in the current context (a `/topic` in the first turns, or anchors
 * trimmed away) leave one block — and must not be described as "nothing has
 * marked a boundary yet" (H-2).
 */
export function formatContextPressureHint(input: {
  level: "soft" | "hard";
  contextTokens: number;
  contextWindow: number;
  hasBlocks: boolean;
  hasMarkers: boolean;
}): string {
  const percent = Math.round((input.contextTokens / input.contextWindow) * 100);
  const usage = `The context is at about ${percent}% of this model's window (${input.contextTokens} of ${input.contextWindow} tokens).`;
  if (input.level === "soft") {
    return `${usage} /compact compresses older topics into a summary when you want more room.`;
  }
  if (input.hasBlocks) {
    return `${usage} Pick a topic block to keep before sending, or press Esc to send anyway.`;
  }
  const why = input.hasMarkers
    ? "the markers in this conversation define no boundary inside the current context"
    : "nothing has marked a topic boundary yet";
  const wayOut = input.hasMarkers
    ? "/topic <title> to mark a fresh boundary"
    : "/topic <title> to mark a boundary for a cleaner cut";
  return `${usage} This is past the point where a turn this large can be sent, and ${why}. Run /compact to compress the older part, or ${wayOut}.`;
}

/**
 * Turn a planning failure into something actionable. Local compaction refuses
 * to plan when there is too little context to summarize, which used to surface
 * as the planner's own error text.
 */
export function formatCompactPlanningFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Not enough messages") ||
    message.includes("No assistant message found")
  ) {
    return "Nothing to trim: this conversation is too short to summarize. Nothing was written.";
  }
  if (message.includes("at the end of the message buffer")) {
    return "Nothing to trim: the newest messages are already the whole context.";
  }
  return message;
}

/** Parse the arguments after the command word. */
export function parseCompactCommandArgs(
  args: readonly string[],
): CompactCommandRequest {
  const [first, ...rest] = args;
  if (first === undefined) return { kind: "auto" };
  if (first === "help") return { kind: "help" };
  if (rest.length > 0) {
    return {
      kind: "invalid",
      message: `Unexpected argument "${rest[0]}".`,
    };
  }
  if ((COMPACT_MODE_ARGUMENTS as readonly string[]).includes(first)) {
    return { kind: "mode", mode: first as CompactModeArgument };
  }
  if (/^\d+$/.test(first)) {
    const index = Number.parseInt(first, 10);
    if (index >= 1) return { kind: "block", index };
    return { kind: "invalid", message: "Block numbers start at 1." };
  }
  return { kind: "invalid", message: `Unknown argument "${first}".` };
}

/** Mode names are a cloud-backend feature; local compaction is always sliding-window. */
export const COMPACT_MODE_LOCAL_UNSUPPORTED =
  "Local compaction always uses the sliding_window strategy, so it takes no mode argument. Run /compact help.";
