/**
 * `/topic list [--all]` — read-only view of the topic blocks (feature ③).
 *
 * Local-only for the same reason `/topic` is: blocks are derived from transcript
 * markers, and the cloud backend manages context server-side. The command never
 * writes, so it is safe to run at any point in a conversation.
 */
import type { DreamCommandScope } from "@/agent/reflection-runs";
import { type Backend, getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { queryTopicIndex } from "@/backend/local/topic-index";
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import {
  formatTopicBlockList,
  formatTopicIndexList,
  formatTopicMarkerHistory,
  formatTopicSearchResults,
  TOPICS_COMMAND_USAGE,
} from "@/cli/helpers/topic-list";
import { shouldAdvertiseTopicMarking } from "@/settings-tool-gates";

export interface TopicsCommandDeps {
  backend?: Backend;
}

export async function handleTopicsCommand(
  args: string[],
  scope?: DreamCommandScope,
  deps: TopicsCommandDeps = {},
): Promise<string> {
  if (args[0] === "help") return TOPICS_COMMAND_USAGE;
  const unknown = args.filter((arg) => arg !== "--all" && arg !== "--context");
  if (unknown.length > 0) {
    return `Unknown option "${unknown[0]}".\n\n${TOPICS_COMMAND_USAGE}`;
  }
  // Two orders, two questions: `--all` is "what has this agent recorded" (time,
  // newest first, every conversation), `--context` is "what did this
  // conversation mark, in the order it happened" (oldest first, with positions).
  // Asking for both in one command has no single answer.
  if (args.includes("--all") && args.includes("--context")) {
    return `--all and --context are different views; pick one.\n\n${TOPICS_COMMAND_USAGE}`;
  }

  if (!scope?.agentId) {
    throw new Error("Topic lists require an active agent.");
  }
  const backend = deps.backend ?? getBackend();
  if (!(backend instanceof LocalBackend)) {
    return TOPIC_COMMAND_LOCAL_ONLY;
  }

  const conversationId = scope.conversationId ?? "default";
  const list = backend.listTopics(conversationId, scope.agentId);
  const topicMarkingEnabled = shouldAdvertiseTopicMarking(
    scope.agentId,
    conversationId,
  );
  if (args.includes("--context")) {
    return formatTopicMarkerHistory(list, { topicMarkingEnabled });
  }
  if (args.includes("--all")) {
    const storageDir = backend.getLocalStorageDir?.();
    if (!storageDir) return TOPIC_COMMAND_LOCAL_ONLY;
    return formatTopicIndexList(
      queryTopicIndex({ agentId: scope.agentId, storageDir }),
    );
  }
  return formatTopicBlockList(list, { topicMarkingEnabled });
}

/**
 * `/topic search <kw>` — this agent's topic markers, matched on title and
 * section (requirement §5.11.9).
 *
 * The TUI opens a face for this command (`submit-topic-commands.ts`); every other
 * channel has no face, so the registry's answer is the same rows printed. Both
 * read the per-agent index, and the index is the only thing read: **search never
 * writes a marker** — that was the bug this subcommand exists to end (C-22).
 *
 * The storage root comes from the backend instance, never from the default: a
 * backend built on a temporary root (every test) would otherwise write its
 * self-healed index into the user's real `~/.haruyuki/lc-local-backend`
 * (route §2.3, 《31》A1).
 */
export async function handleTopicsSearchCommand(
  args: string[],
  scope?: DreamCommandScope,
  deps: TopicsCommandDeps = {},
): Promise<string> {
  if (args[0] === "help") return TOPICS_COMMAND_USAGE;
  if (!scope?.agentId) {
    throw new Error("Topic search requires an active agent.");
  }
  const backend = deps.backend ?? getBackend();
  if (!(backend instanceof LocalBackend)) {
    return TOPIC_COMMAND_LOCAL_ONLY;
  }
  const storageDir = backend.getLocalStorageDir?.();
  if (!storageDir) return TOPIC_COMMAND_LOCAL_ONLY;

  const keyword = args.join(" ").trim();
  const entries = queryTopicIndex({
    agentId: scope.agentId,
    storageDir,
    ...(keyword.length > 0 ? { keyword } : {}),
  });
  return formatTopicSearchResults(keyword, entries);
}
