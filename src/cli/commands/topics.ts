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
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import {
  formatTopicBlockList,
  formatTopicMarkerHistory,
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
  const unknown = args.filter((arg) => arg !== "--all");
  if (unknown.length > 0) {
    return `Unknown option "${unknown[0]}".\n\n${TOPICS_COMMAND_USAGE}`;
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
  return args.includes("--all")
    ? formatTopicMarkerHistory(list, { topicMarkingEnabled })
    : formatTopicBlockList(list, { topicMarkingEnabled });
}
