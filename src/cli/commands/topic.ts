/**
 * `/topic <title> [summary]`, `/topic show <#n|title>` — the user-side half of the
 * topic-marker channel.
 *
 * Users are not rate limited. The agent-side gate exists to stop the model
 * marking every turn; a person typing a marker is deliberate, so the same
 * interval is reported as a note and never blocks the write.
 *
 * The command is local-only for the same reason the tool is: markers are rows in
 * the local transcript, and the cloud backend manages context server-side.
 *
 * `show` lives here rather than in the registry's subcommand branches because it
 * reads the same transcript the marker write appends to, and because it must be
 * intercepted: the fall-through treats the first word as a title, so without the
 * branch `/topic show foo` would record a marker called "show foo" (the C-22 bug,
 * one word over). `list` and `search` are claimed one layer up, in the registry
 * and the TUI submit path, because those two open faces.
 */
import type { DreamCommandScope } from "@/agent/reflection-runs";
import { type Backend, getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  queryTopicIndex,
  type TopicIndexEntry,
} from "@/backend/local/topic-index";
import {
  readTopicRecallSpan,
  renderTopicRecall,
} from "@/backend/local/topic-recall";
import { shortTimestamp } from "@/cli/helpers/topic-list";
import {
  formatTopicShowOutput,
  topicShowDisplayBudget,
  writeTopicShowFile,
  writeTopicShowOverflow,
} from "@/cli/helpers/topic-show";
import { validateTopicMarkArgs } from "@/tools/impl/topic-mark";
import { readTopicSettings } from "@/topic-settings";

export const TOPIC_COMMAND_USAGE = [
  "/topic <title> [summary] | show <#n|title> [--full] [--out <path>]",
  "",
  "Record a topic boundary in this conversation, or read back the conversation a",
  "boundary covers.",
  "",
  "MARKING",
  "  /topic Auth token refresh bug            — the whole line is the title",
  '  /topic "Auth token refresh bug" Details  — quote the title to add a summary',
  "",
  "The marker points at the newest message in the context and never changes",
  "the context itself. `/topic list` lists the topic blocks it defines, and",
  "`/topic search <kw>` searches every topic this agent has recorded.",
  "",
  "READING A TOPIC BACK",
  "  /topic show 2                  — marker #2 of this conversation (see /topic list --context)",
  '  /topic show "auth token"       — the one topic whose title contains this',
  "  /topic show 2 --full           — lift the print ceiling from 8k to 30k characters",
  "  /topic show 2 --out topic.txt  — write the complete text to a file you name",
  "",
  "Only what a person wrote is printed: reasoning, tool calls, tool results and",
  "injected reminders are dropped, and a compaction summary is unpacked. Long",
  "topics are cut with an explicit count, and the complete text goes to a file.",
].join("\n");

/**
 * Split the command line into a title and an optional summary.
 *
 * Whitespace already separates arguments, so a multi-word title needs quoting:
 * everything up to the closing quote is the title and the rest is the summary.
 * An unbalanced quote is not worth an error — the whole line becomes the title.
 */
export function parseTopicCommandArgs(args: string[]): {
  title: string;
  summary?: string;
} {
  const raw = args.join(" ").trim();
  if (raw.startsWith('"')) {
    const closing = raw.indexOf('"', 1);
    // `closing === 1` is an empty title, which validation rejects by name.
    if (closing >= 1) {
      const title = raw.slice(1, closing).trim();
      const summary = raw.slice(closing + 1).trim();
      return summary.length > 0 ? { title, summary } : { title };
    }
  }
  return { title: raw };
}

export const TOPIC_COMMAND_LOCAL_ONLY =
  "Topic markers are only available on the local backend. This conversation runs on the Letta API, where context is managed by the server.";

export interface TopicCommandDeps {
  backend?: Backend;
}

export interface TopicCommandReceipt {
  title: string;
  summary?: string;
  markerId: string;
  anchorMessageId: string;
  contextMessageCount: number;
  /** `null` when this is the first marker in the conversation. */
  turnsSincePrevious: number | null;
  /** The agent-side minimum spacing, reported as a note only. */
  spacingTurns: number;
}

/**
 * Render the receipt. Pure so the copy is testable without a backend, and so
 * the "user marks are never blocked" rule is visible in one place.
 */
export function formatTopicCommandReceipt(input: TopicCommandReceipt): string {
  const lines = [
    "Topic marker recorded.",
    `  id:       ${input.markerId}`,
    `  title:    ${input.title}`,
    ...(input.summary === undefined ? [] : [`  summary:  ${input.summary}`]),
    `  anchor:   ${input.anchorMessageId} (the newest of ${input.contextMessageCount} in-context messages)`,
    `  previous: ${
      input.turnsSincePrevious === null
        ? "none (this is the first marker)"
        : `${input.turnsSincePrevious} user turn${input.turnsSincePrevious === 1 ? "" : "s"} ago`
    }`,
  ];
  if (
    input.turnsSincePrevious !== null &&
    input.turnsSincePrevious < input.spacingTurns
  ) {
    lines.push(
      `  note:     sooner than the ${input.spacingTurns}-user-turn spacing the agent-side gate uses; user marks are never blocked`,
    );
  }
  lines.push(
    "Markers are metadata: the context and the frozen prefix are unchanged.",
  );
  return lines.join("\n");
}

/** Parsed `/topic show` arguments. */
export interface TopicShowArgs {
  /** A position number (`2`) or a title substring (`auth token`). */
  selector?: string;
  full: boolean;
  outPath?: string;
}

/** How many ambiguous title matches are listed before refusing to guess. */
export const TOPIC_SHOW_MATCH_LIMIT = 5;

/**
 * Split `/topic show`'s arguments.
 *
 * A position number and a title substring are the same slot, so digits are kept as
 * they were typed and interpreted later: `/topic show 2026` is an out-of-range
 * position, not a title search, which is the one shape that reads oddly — and it
 * has to pick something, so it picks the documented one.
 */
export function parseTopicShowArgs(
  args: readonly string[],
): ({ ok: true } & TopicShowArgs) | { ok: false; content: string } {
  let full = false;
  let outPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) break;
    if (arg === "--full") {
      full = true;
      continue;
    }
    if (arg === "--out") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return {
          ok: false,
          content: "`--out` needs a file path, for example `--out topic.txt`.",
        };
      }
      outPath = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      return {
        ok: false,
        content: `Unknown option "${arg}". \`/topic show\` takes \`--full\` and \`--out <path>\`.`,
      };
    }
    positional.push(arg);
  }
  const selector = positional.join(" ").trim();
  return {
    ok: true,
    full,
    ...(selector.length === 0 ? {} : { selector }),
    ...(outPath === undefined ? {} : { outPath }),
  };
}

function markerPositionError(requested: number, available: number): string {
  if (available === 0) {
    return "This conversation has no topic markers yet, so there is no position to show. Mark one with /topic <title>.";
  }
  return `There is no marker #${requested}: this conversation has ${available} (1–${available}). Run /topic list --context to see them.`;
}

function ambiguousTitleError(
  selector: string,
  matches: readonly TopicIndexEntry[],
): string {
  const shown = matches.slice(0, TOPIC_SHOW_MATCH_LIMIT);
  return [
    `"${selector}" matches ${matches.length} topics. Narrow it, or pass a position number from /topic list --context:`,
    ...shown.map(
      (entry) =>
        `  ${entry.title} · ${shortTimestamp(entry.createdAt)} · session ${entry.conversationId} · topic_id ${entry.topicId}`,
    ),
    ...(matches.length > shown.length
      ? [`  ... and ${matches.length - shown.length} more`]
      : []),
  ].join("\n");
}

/**
 * `/topic show <位置号|标题子串> [--full] [--out <path>]`.
 *
 * A position is this conversation's `/topic list --context` number; anything else is
 * a title substring across the agent's index. Several matches are listed and
 * refused rather than guessed at — picking one of two plausible topics and printing
 * the wrong conversation is worse than asking again.
 */
async function handleTopicShowCommand(
  args: readonly string[],
  scope: DreamCommandScope | undefined,
  deps: TopicCommandDeps,
): Promise<string> {
  const parsed = parseTopicShowArgs(args);
  if (!parsed.ok) return `${parsed.content}\n\n${TOPIC_COMMAND_USAGE}`;
  if (parsed.selector === undefined) {
    return `Which topic? Pass a position number or part of a title.\n\n${TOPIC_COMMAND_USAGE}`;
  }
  if (!scope?.agentId) {
    throw new Error("Topic markers require an active agent.");
  }
  const backend = deps.backend ?? getBackend();
  if (!(backend instanceof LocalBackend)) {
    return TOPIC_COMMAND_LOCAL_ONLY;
  }
  const agentId = scope.agentId;
  const conversationId = scope.conversationId ?? "default";
  const storageDir = backend.getLocalStorageDir();

  let target: { conversationId: string; topicId: string };
  const position = /^\d+$/.test(parsed.selector)
    ? Number(parsed.selector)
    : undefined;
  if (position !== undefined) {
    // The same order `/topic list --context` prints: the transcript's, oldest
    // first. Reading it from the markers (not the index) is what keeps the two
    // faces numbered alike.
    const markers = backend.listTopicMarkers(conversationId, agentId);
    const marker = markers[position - 1];
    if (marker === undefined) {
      return markerPositionError(position, markers.length);
    }
    target = { conversationId, topicId: marker.id };
  } else {
    const needle = parsed.selector.toLowerCase();
    const matches = queryTopicIndex({ agentId, storageDir }).filter((entry) =>
      entry.title.toLowerCase().includes(needle),
    );
    if (matches.length === 0) {
      return `No topic title contains "${parsed.selector}". Run /topic list --all or /topic search <kw> to see what exists. Topics in hidden conversations are not searched by title; pass a position number from /topic list --context instead.`;
    }
    if (matches.length > 1) {
      return ambiguousTitleError(parsed.selector, matches);
    }
    const match = matches[0];
    if (!match) {
      return `No topic title contains "${parsed.selector}".`;
    }
    target = { conversationId: match.conversationId, topicId: match.topicId };
  }

  const span = readTopicRecallSpan({
    storageDir,
    agentId,
    conversationId: target.conversationId,
    topicId: target.topicId,
  });
  if (!span) {
    return "That marker is not readable: its conversation transcript no longer holds it. The topic index may be stale; run /topic list --all to refresh it.";
  }

  // Always project the complete span first: the display tier is a decision about
  // *printing*, and the file (named or overflow) has to hold everything.
  const complete = renderTopicRecall({
    span,
    tier: "full",
    maxChars: Number.POSITIVE_INFINITY,
  });

  if (parsed.outPath !== undefined) {
    const written = writeTopicShowFile(parsed.outPath, complete.text);
    return `Wrote ${complete.chars} characters of "${span.title}" to ${written}.`;
  }

  const overflowPath =
    complete.chars > topicShowDisplayBudget(parsed.full)
      ? writeTopicShowOverflow(complete.text)
      : undefined;
  return formatTopicShowOutput({
    span,
    result: complete,
    full: parsed.full,
    ...(overflowPath === undefined ? {} : { overflowPath }),
  });
}

export async function handleTopicCommand(
  args: string[],
  scope?: DreamCommandScope,
  deps: TopicCommandDeps = {},
): Promise<string> {
  if (args.length === 0 || args[0] === "help") {
    return TOPIC_COMMAND_USAGE;
  }
  // A subcommand, not a title. Without this branch the fall-through below records
  // a marker called "show foo" — the C-22 bug one word over. The cost is that a
  // topic cannot be titled "show …"; `list` and `search` already pay the same cost.
  if (args[0]?.toLowerCase() === "show") {
    return handleTopicShowCommand(args.slice(1), scope, deps);
  }
  const parsed = parseTopicCommandArgs(args);
  const validated = validateTopicMarkArgs(parsed);
  if (!validated.ok) {
    return `${validated.content}\n\n${TOPIC_COMMAND_USAGE}`;
  }

  if (!scope?.agentId) {
    throw new Error("Topic markers require an active agent.");
  }
  const backend = deps.backend ?? getBackend();
  if (!(backend instanceof LocalBackend)) {
    return TOPIC_COMMAND_LOCAL_ONLY;
  }

  const conversationId = scope.conversationId ?? "default";
  const state = backend.topicMarkerState(conversationId, scope.agentId);
  if (state.contextMessageCount === 0) {
    return "There is nothing in this conversation's context to anchor a topic marker to yet.";
  }

  const written = backend.markTopic({
    conversationId,
    agentId: scope.agentId,
    title: validated.title,
    ...(validated.summary === undefined ? {} : { summary: validated.summary }),
    createdBy: "user",
  });
  return formatTopicCommandReceipt({
    title: validated.title,
    ...(validated.summary === undefined ? {} : { summary: validated.summary }),
    markerId: written.entryId,
    anchorMessageId: written.marker.anchorMessageId ?? "",
    contextMessageCount: written.contextMessageCount,
    turnsSincePrevious:
      state.markers.length === 0 ? null : written.turnsSincePrevious,
    // The note quotes the same threshold the agent-side gate uses, so the two
    // cannot disagree after `topic_marker_reject_turns` changes.
    spacingTurns: readTopicSettings().markerRejectTurns,
  });
}
