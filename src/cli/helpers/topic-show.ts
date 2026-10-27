/**
 * `/topic show` — the human face of a topic span.
 *
 * The projection itself (which messages, how they are cleaned, how the budget cuts
 * them) belongs to `backend/local/topic-recall.ts` and is shared with `TopicQuery`;
 * this module owns only the part that is about a *terminal*: how much of a long
 * span to print, and where the rest of it goes. Keeping it separate is what lets
 * `/topic show` print the shared projection verbatim for a span that fits, which is
 * what makes the two faces provably agree.
 *
 * A person reading a reply is not on a token budget, so the tiers are generous and
 * the cut is not silent: past the ceiling the reader gets the head, the tail, the
 * character count and a file that holds everything.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  TopicRecallResult,
  TopicRecallSpan,
} from "@/backend/local/topic-recall";
import { OVERFLOW_CONFIG, writeOverflowFile } from "@/tools/impl/overflow";
import { scrubAmbientSecrets } from "@/tools/secret-substitution";

/** What an ordinary `/topic show` prints in full before it starts cutting. */
export const TOPIC_SHOW_DISPLAY_MAX_CHARS = 8000;

/** `--full` lifts the ceiling to this; past it, only an outline is printed. */
export const TOPIC_SHOW_FULL_DISPLAY_MAX_CHARS = 30000;

/** Above this, the head/tail pair stops being readable and an outline is printed. */
export const TOPIC_SHOW_OUTLINE_THRESHOLD_CHARS = 30000;

/** How much of each end of a long span is printed. */
export const TOPIC_SHOW_EDGE_CHARS = 2000;

/** How many messages of each end the outline quotes. */
export const TOPIC_SHOW_OUTLINE_EDGE_MESSAGES = 2;

/** How much of an outline message is quoted. */
export const TOPIC_SHOW_OUTLINE_MESSAGE_PREVIEW_CHARS = 200;

/** The display ceiling for this invocation. */
export function topicShowDisplayBudget(full: boolean): number {
  return full
    ? TOPIC_SHOW_FULL_DISPLAY_MAX_CHARS
    : TOPIC_SHOW_DISPLAY_MAX_CHARS;
}

function overflowDisabledNote(): string {
  return "Nothing was written to disk: overflow files are switched off (HARUYUKI_TOOL_OVERFLOW_TO_FILE=false). Use `--out <path>` to write the complete text yourself.";
}

function completeTextPointer(
  chars: number,
  overflowPath: string | undefined,
): string {
  return overflowPath === undefined
    ? overflowDisabledNote()
    : `The complete text (${chars} characters) is in ${overflowPath}`;
}

/**
 * The head/tail view of a span that is too long to print but still short enough to
 * be recognisable: the opening and the closing of the topic, the size of what is
 * missing, and a pointer to all of it.
 */
function formatHeadTail(
  result: TopicRecallResult,
  overflowPath: string | undefined,
): string {
  const head = result.text.slice(0, TOPIC_SHOW_EDGE_CHARS);
  const tail = result.text.slice(-TOPIC_SHOW_EDGE_CHARS);
  const hidden = result.chars - head.length - tail.length;
  return [
    head,
    "",
    `… ${hidden} characters not shown …`,
    "",
    tail,
    "",
    completeTextPointer(result.chars, overflowPath),
  ].join("\n");
}

function flattenForOutline(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TOPIC_SHOW_OUTLINE_MESSAGE_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, TOPIC_SHOW_OUTLINE_MESSAGE_PREVIEW_CHARS - 1)}…`;
}

/**
 * The outline view: what the topic is, how big it is, when it ran, and the first and
 * last couple of messages — enough to decide whether the file is worth opening,
 * without printing something no one can read.
 */
function formatOutline(
  span: TopicRecallSpan,
  result: TopicRecallResult,
  overflowPath: string | undefined,
): string {
  const lines = [result.header];
  const spanLabel =
    span.startsAt === undefined || span.endsAt === undefined
      ? "unknown"
      : `${span.startsAt.slice(0, 16).replace("T", " ")} → ${span.endsAt
          .slice(0, 16)
          .replace("T", " ")} UTC`;
  lines.push(
    `size: ${result.messageCount} messages · ~${span.estimatedTokens} tokens · ${result.chars} characters`,
  );
  lines.push(`span: ${spanLabel}`);
  if (span.section !== undefined) {
    lines.push(`section: ${flattenForOutline(span.section)}`);
  }

  const edge = TOPIC_SHOW_OUTLINE_EDGE_MESSAGES;
  if (span.messages.length <= edge * 2) {
    lines.push("", "messages:");
    for (const message of span.messages) {
      lines.push(
        `  ${message.position}. ${message.role}: ${flattenForOutline(message.text)}`,
      );
    }
  } else {
    lines.push("", "first messages:");
    for (const message of span.messages.slice(0, edge)) {
      lines.push(
        `  ${message.position}. ${message.role}: ${flattenForOutline(message.text)}`,
      );
    }
    lines.push("", "last messages:");
    for (const message of span.messages.slice(-edge)) {
      lines.push(
        `  ${message.position}. ${message.role}: ${flattenForOutline(message.text)}`,
      );
    }
  }

  lines.push("", completeTextPointer(result.chars, overflowPath));
  return lines.join("\n");
}

/**
 * Render one span for a terminal.
 *
 * `result` is the *complete* projection (rendered without a ceiling), so the tier
 * decision is about display alone: under the ceiling the reader gets the shared
 * projection byte for byte, which is exactly what `TopicQuery` returns for the same
 * topic.
 */
export function formatTopicShowOutput(input: {
  span: TopicRecallSpan;
  result: TopicRecallResult;
  full: boolean;
  overflowPath?: string;
}): string {
  const budget = topicShowDisplayBudget(input.full);
  if (input.result.chars <= budget) return input.result.text;
  if (input.result.chars <= TOPIC_SHOW_OUTLINE_THRESHOLD_CHARS) {
    return formatHeadTail(input.result, input.overflowPath);
  }
  return formatOutline(input.span, input.result, input.overflowPath);
}

/**
 * Write the complete projection to the overflow directory and return its path.
 *
 * Reused rather than reinvented: `writeOverflowFile` is the one place stdout-bound
 * output becomes a file, and it scrubs known secret values on the way out. Returns
 * `undefined` when the operator switched overflow off, so the caller prints the
 * reason instead of a path that does not exist.
 */
export function writeTopicShowOverflow(
  completeText: string,
): string | undefined {
  if (!OVERFLOW_CONFIG.ENABLED) return undefined;
  return writeOverflowFile(completeText, process.cwd(), "topic-show");
}

/** `--out <path>`: the operator named the file, so that is where it goes. */
export function writeTopicShowFile(path: string, completeText: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, scrubAmbientSecrets(completeText), "utf8");
  return path;
}
