import { Box } from "ink";
import { useSyncExternalStore } from "react";
import { ApprovalPreview } from "@/cli/components/ApprovalPreview";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { BashCommandMessage } from "@/cli/components/BashCommandMessage";
import { CommandMessage } from "@/cli/components/CommandMessage";
import { ErrorMessage } from "@/cli/components/ErrorMessageRich";
import { EventMessage } from "@/cli/components/EventMessage";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { StatusMessage } from "@/cli/components/StatusMessage";
import { SubagentGroupStatic } from "@/cli/components/SubagentGroupStatic";
import { Text } from "@/cli/components/Text";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { TrajectorySummary } from "@/cli/components/TrajectorySummary";
import {
  getSystemRemindersExpanded,
  getSystemRemindersVisible,
  getThinkingExpanded,
  subscribeToSystemReminderDisplay,
  subscribeToThinkingDisplay,
} from "@/cli/components/transcript-display-state";
import {
  RecallBlockMessage,
  UserMessage,
} from "@/cli/components/UserMessageRich";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { StaticItem } from "./types";

export interface TranscriptItemViewProps {
  item: StaticItem;
  /** Position among the rendered rows; controls the leading blank line. */
  index: number;
  columns: number;
  statusLinePrompt: string;
  showCompactionsEnabled: boolean;
  precomputedDiffs: Map<string, AdvancedDiffSuccess>;
  hiddenToolCallId?: string;
  lastShellToolCallId?: string;
}

/**
 * Renders one transcript item.
 *
 * Shared by the append shell (inside Ink's `<Static>`) and the full-screen
 * viewport (inside its window), so a given item renders identically in both and
 * the row model has one layout to measure against. It reads the reminder and
 * thinking display state itself, matching what the append renderer did.
 */
export function TranscriptItemView({
  item,
  index,
  columns,
  statusLinePrompt,
  showCompactionsEnabled,
  precomputedDiffs,
  hiddenToolCallId,
  lastShellToolCallId,
}: TranscriptItemViewProps) {
  const systemRemindersVisible = useSyncExternalStore(
    subscribeToSystemReminderDisplay,
    getSystemRemindersVisible,
  );
  const systemRemindersExpanded = useSyncExternalStore(
    subscribeToSystemReminderDisplay,
    getSystemRemindersExpanded,
  );
  const thinkingExpanded = useSyncExternalStore(
    subscribeToThinkingDisplay,
    getThinkingExpanded,
  );

  try {
    return (
      <Box marginTop={index > 0 ? 1 : 0}>
        {item.kind === "welcome" ? (
          <WelcomeScreen loadingState="ready" {...item.snapshot} />
        ) : item.kind === "user" ? (
          <UserMessage
            line={item}
            prompt={statusLinePrompt}
            systemRemindersVisible={systemRemindersVisible}
            systemRemindersExpanded={systemRemindersExpanded}
          />
        ) : item.kind === "recall" ? (
          <RecallBlockMessage text={item.text} />
        ) : item.kind === "reasoning" ? (
          <ReasoningMessage line={item} expanded={thinkingExpanded} />
        ) : item.kind === "assistant" ? (
          <AssistantMessage line={item} />
        ) : item.kind === "tool_call" ? (
          <ToolCallMessage
            line={item}
            precomputedDiffs={precomputedDiffs}
            expandedToolCallId={hiddenToolCallId}
            lastShellToolCallId={lastShellToolCallId}
          />
        ) : item.kind === "subagent_group" ? (
          <SubagentGroupStatic agents={item.agents} />
        ) : item.kind === "error" ? (
          <ErrorMessage line={item} />
        ) : item.kind === "status" ? (
          <StatusMessage line={item} />
        ) : item.kind === "event" ? (
          !showCompactionsEnabled && item.eventType === "compaction" ? null : (
            <EventMessage line={item} />
          )
        ) : item.kind === "separator" ? (
          <Box marginTop={1}>
            <Text dimColor>{"─".repeat(columns)}</Text>
          </Box>
        ) : item.kind === "command" ? (
          <CommandMessage line={item} />
        ) : item.kind === "bash_command" ? (
          <BashCommandMessage line={item} />
        ) : item.kind === "trajectory_summary" ? (
          <TrajectorySummary line={item} />
        ) : item.kind === "approval_preview" ? (
          <ApprovalPreview
            toolName={item.toolName}
            toolArgs={item.toolArgs}
            precomputedDiff={item.precomputedDiff}
            allDiffs={precomputedDiffs}
            toolCallId={item.toolCallId}
          />
        ) : null}
      </Box>
    );
  } catch (err) {
    console.error(
      `[Transcript render error] kind=${item.kind} id=${item.id}`,
      err,
    );
    return (
      <Box>
        <Text color="red">
          ⚠ render error: {item.kind} ({String(err)})
        </Text>
      </Box>
    );
  }
}
