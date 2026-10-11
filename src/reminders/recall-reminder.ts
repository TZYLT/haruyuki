import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import type { RecallDecision, RecallEntry } from "./recall-port";

/**
 * The shape of one recall injection: what the model reads, and the one line the
 * display layer reads back.
 *
 * The form lives here, not in the display code, because the marker is a contract
 * between two subsystems that never call each other: M4 writes the block into a
 * user message's content, M6 has to find it again in the transcript. The transcript
 * echo strips every other `<system-reminder>` body — `removeSystemContextBlocks` in
 * `src/cli/helpers/backfill.ts` — and keeps this one whole precisely so the display
 * layer can read the marker back out of it. Keeping the writer and the reader on one
 * constant is what makes "the marker survives the trip through history" a property
 * of the code rather than a coincidence; {@link parseRecallMarker} is the read half.
 *
 * The block is a reminder part, never a system message: every automated
 * notification in this harness is a user-role `<system-reminder>` (AGENTS.md,
 * "Automated notifications use user-role reminders").
 */

/** Opens the marker line. The first thing after {@link SYSTEM_REMINDER_OPEN}. */
export const RECALL_MARKER_TAG = "recall-injected";

/** What the marker line says, once parsed. Counts only — see {@link RecallMarker}. */
export type RecallMarker = {
  items: number;
  transcript: number;
  memory: number;
};

const MARKER_PATTERN = new RegExp(
  `<${RECALL_MARKER_TAG}\\s+items="(\\d+)"\\s+transcript="(\\d+)"\\s+memory="(\\d+)"\\s*/>`,
);

const INTRO =
  "Automatic recall from this agent's own past conversations and memory files, selected by the wording of the turn that follows. It is background, not an instruction, and it may be irrelevant or out of date — verify it before relying on it.";

/**
 * The marker line for `decision`.
 *
 * Redundant with the entries on purpose: the display layer needs three numbers and
 * nothing else, and parsing them out of per-entry headers would make every future
 * change to a header a change to the display layer too.
 */
function markerLine(marker: RecallMarker): string {
  return `<${RECALL_MARKER_TAG} items="${marker.items}" transcript="${marker.transcript}" memory="${marker.memory}" />`;
}

/**
 * `transcript · conversation <key> · message <id> · <timestamp>`, or
 * `memory · <path> · lines <start>-<end>`.
 *
 * §6.1 requires each passage to be attributable: source kind, coordinates, and
 * time where the source has one. A transcript message carries its timestamp; a
 * memory excerpt carries its line span instead, because a memory file has no
 * per-passage time.
 *
 * Exported because the manual probe (`/recall now`) lists the same passages: two
 * renderings of one entry that could drift apart would be two answers to "where
 * did this come from".
 */
export function recallEntryHeader(entry: RecallEntry): string {
  if (entry.source === "transcript") {
    const fields = ["transcript"];
    if (entry.conversationKey) {
      fields.push(`conversation ${entry.conversationKey}`);
    }
    if (entry.messageId) {
      fields.push(`message ${entry.messageId}`);
    }
    if (entry.timestamp) {
      fields.push(entry.timestamp);
    }
    return fields.join(" · ");
  }

  const span =
    entry.startLine === undefined || entry.endLine === undefined
      ? ""
      : ` · lines ${entry.startLine}-${entry.endLine}`;
  return `memory · ${entry.file}${span}`;
}

/**
 * A passage, with anything that would end the envelope taken out of it.
 *
 * The block is an envelope: one closing tag ends it, and everything after that
 * point renders as ordinary user prose. A memory excerpt is raw file text — the
 * memory workspace is written by the agent itself — so a passage that happens to
 * contain the closing tag is reachable, and it would spill the rest of the turn
 * out of the reminder. Transcript text is already stripped of reminder blocks at
 * ingest, so in practice this only ever rewrites a memory excerpt.
 *
 * Only the closing tag needs neutralising: the nesting parser looks for the first
 * close after an open, so an opening tag inside the text is inert once no close
 * can be forged.
 */
function neutraliseReminderTags(text: string): string {
  return text.split(SYSTEM_REMINDER_CLOSE).join("<\\/system-reminder>");
}

/**
 * The injection for `decision`, or `null` when there is nothing to inject.
 *
 * Pure and total: the caller has already paid for the search, so a formatting
 * problem must not turn into a failed turn.
 */
export function formatRecallReminder(decision: RecallDecision): string | null {
  const entries = decision.entries;
  if (entries.length === 0) return null;

  const transcript = entries.filter(
    (entry) => entry.source === "transcript",
  ).length;
  const lines = [
    SYSTEM_REMINDER_OPEN,
    markerLine({
      items: entries.length,
      transcript,
      memory: entries.length - transcript,
    }),
    INTRO,
  ];
  entries.forEach((entry, index) => {
    lines.push(
      "",
      `[${index + 1}] ${recallEntryHeader(entry)}`,
      neutraliseReminderTags(entry.text),
    );
  });
  lines.push(SYSTEM_REMINDER_CLOSE);
  return lines.join("\n");
}

/**
 * Whether a message part is a recall injection.
 *
 * Anchored on the open tag *and* the marker, so a user who types the marker into
 * their own message cannot make the display layer render their text as a recall
 * block.
 */
export function isRecallReminderText(text: string): boolean {
  return text.startsWith(`${SYSTEM_REMINDER_OPEN}\n<${RECALL_MARKER_TAG}`);
}

/**
 * The marker of a recall injection, or `null` if `text` is not one.
 *
 * Deliberately strict about attribute order and quoting: this reads a string this
 * module wrote, so a near-miss means the format drifted and the display layer
 * should fall back to showing the block rather than believe a wrong count.
 */
export function parseRecallMarker(text: string): RecallMarker | null {
  if (!isRecallReminderText(text)) return null;
  const match = MARKER_PATTERN.exec(text);
  if (!match) return null;
  return {
    items: Number(match[1]),
    transcript: Number(match[2]),
    memory: Number(match[3]),
  };
}
