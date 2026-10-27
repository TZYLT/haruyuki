/**
 * `/topic <title> [summary]` — the user-side half of the topic-marker channel.
 *
 * Users are not rate limited. The agent-side gate exists to stop the model
 * marking every turn; a person typing a marker is deliberate, so the same
 * interval is reported as a note and never blocks the write.
 *
 * The command is local-only for the same reason the tool is: markers are rows in
 * the local transcript, and the cloud backend manages context server-side.
 */
import type { DreamCommandScope } from "@/agent/reflection-runs";
import { type Backend, getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { validateTopicMarkArgs } from "@/tools/impl/topic-mark";
import { readTopicSettings } from "@/topic-settings";

export const TOPIC_COMMAND_USAGE = [
  "/topic <title> [summary]",
  "",
  "Record a topic boundary in this conversation.",
  "",
  "USAGE",
  "  /topic Auth token refresh bug            — the whole line is the title",
  '  /topic "Auth token refresh bug" Details  — quote the title to add a summary',
  "",
  "The marker points at the newest message in the context and never changes",
  "the context itself. `/topic list` lists the topic blocks it defines, and",
  "`/topic search <kw>` searches every topic this agent has recorded.",
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

export async function handleTopicCommand(
  args: string[],
  scope?: DreamCommandScope,
  deps: TopicCommandDeps = {},
): Promise<string> {
  if (args.length === 0 || args[0] === "help") {
    return TOPIC_COMMAND_USAGE;
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
