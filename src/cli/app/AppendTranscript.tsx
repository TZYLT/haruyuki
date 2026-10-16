import { Box } from "ink";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { BashCommandMessage } from "@/cli/components/BashCommandMessage";
import { CommandMessage } from "@/cli/components/CommandMessage";
import { ErrorMessage } from "@/cli/components/ErrorMessageRich";
import { EventMessage } from "@/cli/components/EventMessage";
import { PendingApprovalStub } from "@/cli/components/PendingApprovalStub";
import { LiveReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { StatusMessage } from "@/cli/components/StatusMessage";
import { SubagentGroupDisplay } from "@/cli/components/SubagentGroupDisplay";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { LiveUserMessage as UserMessage } from "@/cli/components/UserMessageRich";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import { AnimationProvider } from "@/cli/contexts/AnimationContext";
import type { AppViewProps } from "./AppView";
import { FocusedApproval } from "./FocusedApproval";
import { shouldRenderLiveItem } from "./live-items";
import { StaticTranscript } from "./StaticTranscript";

/**
 * Append-style transcript region (the `ui_v2=off` shell).
 *
 * Committed items go through Ink's `<Static>` (printed once, never re-rendered)
 * and the live items for the current turn render beneath them, with approvals
 * rendered inline. This is the behaviour the legacy shell has always had; it is
 * now a shell-supplied region so the full-screen shell can substitute a
 * virtualized viewport without a mode branch inside `AppView`.
 */
export function AppendTranscript(props: AppViewProps) {
  const {
    staticItems,
    staticRenderEpoch,
    columns,
    statusLinePrompt,
    showCompactionsEnabled,
    precomputedDiffsRef,
    expandedToolCallId,
    lastShellToolCallId,
    loadingState,
    continueSession,
    agentState,
    shouldAnimate,
    liveItems,
    currentApproval,
    approvalMap,
    pendingIds,
    queuedIds,
    queuedDecisions,
    stubDescriptions,
    streaming,
  } = props;

  return (
    <>
      <StaticTranscript
        renderEpoch={staticRenderEpoch}
        items={staticItems}
        columns={columns}
        statusLinePrompt={statusLinePrompt}
        showCompactionsEnabled={showCompactionsEnabled}
        precomputedDiffs={precomputedDiffsRef.current}
        hiddenToolCallId={expandedToolCallId ?? undefined}
        lastShellToolCallId={lastShellToolCallId ?? undefined}
      />

      {/* Loading screen / intro text */}
      {loadingState !== "ready" && (
        <WelcomeScreen
          loadingState={loadingState}
          continueSession={continueSession}
          agentState={agentState}
        />
      )}

      {loadingState === "ready" && (
        <AnimationProvider shouldAnimate={shouldAnimate}>
          {/* Show liveItems always - all approvals now render inline */}
          {liveItems.length > 0 && (
            <Box flexDirection="column">
              {liveItems.map((ln) => {
                if (
                  !shouldRenderLiveItem(ln, {
                    currentApprovalToolCallId: currentApproval?.toolCallId,
                    pendingIds,
                    queuedIds,
                  })
                ) {
                  return null;
                }

                // Check if this tool call matches the current approval awaiting user input
                const matchesCurrentApproval =
                  ln.kind === "tool_call" &&
                  currentApproval &&
                  ln.toolCallId === currentApproval.toolCallId;

                return (
                  <Box key={ln.id} flexDirection="column" marginTop={1}>
                    {matchesCurrentApproval ? (
                      <FocusedApproval
                        view={props}
                        precomputedDiff={
                          ln.toolCallId
                            ? precomputedDiffsRef.current.get(ln.toolCallId)
                            : undefined
                        }
                      />
                    ) : ln.kind === "user" ? (
                      <UserMessage line={ln} prompt={statusLinePrompt} />
                    ) : ln.kind === "reasoning" ? (
                      <LiveReasoningMessage line={ln} />
                    ) : ln.kind === "assistant" ? (
                      <AssistantMessage line={ln} />
                    ) : ln.kind === "tool_call" &&
                      ln.toolCallId &&
                      queuedIds.has(ln.toolCallId) ? (
                      // Render stub for queued (decided but not executed) approval
                      <PendingApprovalStub
                        toolName={
                          approvalMap.get(ln.toolCallId)?.toolName ||
                          ln.name ||
                          "Unknown"
                        }
                        description={stubDescriptions.get(ln.toolCallId)}
                        decision={queuedDecisions.get(ln.toolCallId)}
                      />
                    ) : ln.kind === "tool_call" &&
                      ln.toolCallId &&
                      pendingIds.has(ln.toolCallId) ? (
                      // Render stub for pending (undecided) approval
                      <PendingApprovalStub
                        toolName={
                          approvalMap.get(ln.toolCallId)?.toolName ||
                          ln.name ||
                          "Unknown"
                        }
                        description={stubDescriptions.get(ln.toolCallId)}
                      />
                    ) : ln.kind === "tool_call" ? (
                      <ToolCallMessage
                        line={ln}
                        precomputedDiffs={precomputedDiffsRef.current}
                        isStreaming={streaming}
                        expandedToolCallId={expandedToolCallId}
                        lastShellToolCallId={lastShellToolCallId}
                      />
                    ) : ln.kind === "error" ? (
                      <ErrorMessage line={ln} />
                    ) : ln.kind === "status" ? (
                      <StatusMessage line={ln} />
                    ) : ln.kind === "event" ? (
                      <EventMessage line={ln} />
                    ) : ln.kind === "command" ? (
                      <CommandMessage line={ln} />
                    ) : ln.kind === "bash_command" ? (
                      <BashCommandMessage line={ln} />
                    ) : null}
                  </Box>
                );
              })}
            </Box>
          )}

          {/* Fallback approval UI when backfill is disabled (no liveItems) */}
          {liveItems.length === 0 && currentApproval && (
            <Box flexDirection="column">
              <FocusedApproval view={props} />
            </Box>
          )}

          {/* Subagent group display - shows running/completed subagents */}
          <SubagentGroupDisplay />
        </AnimationProvider>
      )}
    </>
  );
}
