import { APIError } from "@letta-ai/letta-client/core/error";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import type { CommandHandle } from "@/cli/commands/runner";
import { type Buffers, type Line, toLines } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import { resetContextHistory } from "@/cli/helpers/context-tracker";
import type { ConversationSwitchContext } from "@/cli/helpers/conversation-switch-alert";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { settingsManager } from "@/settings-manager";
import { uid } from "./ids";
import type { ActiveOverlay, AppCommandRunner, StaticItem } from "./types";

type SubmitCommandResult = { submitted: boolean };

type NavigationCommandContext = {
  agentId: string;
  agentState: AgentState | null | undefined;
  buffersRef: MutableRefObject<Buffers>;
  commandRunner: AppCommandRunner;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  conversationId: string;
  emittedIdsRef: MutableRefObject<Set<string>>;
  hasBackfilledRef: MutableRefObject<boolean>;
  pendingConversationSwitchRef: MutableRefObject<ConversationSwitchContext | null>;
  recoverRestoredPendingApprovals: (
    approvals: ApprovalRequest[],
    options?: { notifyOnManualApproval?: boolean },
  ) => Promise<void>;
  resetBootstrapReminderState: (pendingConversationBootstrap?: boolean) => void;
  resetDeferredToolCallCommits: () => void;
  resetTrajectoryBases: () => void;
  setCommandRunning: (value: boolean) => void;
  setConversationAutoTitleEligibility: (enabled: boolean) => void;
  setConversationIdAndRef: (nextConversationId: string) => void;
  setLines: Dispatch<SetStateAction<Line[]>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setStaticItems: Dispatch<SetStateAction<StaticItem[]>>;
  setStaticRenderEpoch: Dispatch<SetStateAction<number>>;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => void;
};

/**
 * What a direct conversation switch needs from the app.
 *
 * Deliberately narrower than `NavigationCommandContext`: the switch is also
 * reachable from the tab strip, which has no command to open and nothing to
 * search. Every field is structural, so a caller that already holds the wider
 * context passes it unchanged.
 */
export type ConversationSwitchDeps = Pick<
  NavigationCommandContext,
  | "agentId"
  | "agentState"
  | "buffersRef"
  | "contextTrackerRef"
  | "emittedIdsRef"
  | "hasBackfilledRef"
  | "pendingConversationSwitchRef"
  | "recoverRestoredPendingApprovals"
  | "resetBootstrapReminderState"
  | "resetDeferredToolCallCommits"
  | "resetTrajectoryBases"
  | "setCommandRunning"
  | "setConversationAutoTitleEligibility"
  | "setConversationIdAndRef"
  | "setLines"
  | "setStaticItems"
  | "setStaticRenderEpoch"
>;

/** What a direct switch ended up doing. */
export type ConversationSwitchOutcome =
  | { status: "switched"; message: string }
  | { status: "failed"; message: string };

/**
 * Load a conversation into the main area.
 *
 * One implementation for every direct switch — `/resume <id>` as a command and a
 * click on a conversation tab — because the alternative was two copies of the
 * same twenty steps (validate, persist, remember the switch, clear the buffers,
 * backfill, restore approvals) that had already started to drift. The caller
 * owns the *report*: a command passes its handle and gets the success/failure row,
 * a click passes none and reports a failure in the one-line notice instead.
 *
 * `"already on this conversation"` is deliberately not an outcome: the caller
 * knows the conversation it is on (a command's `conversationId` prop, a click's
 * `conversationIdRef`) and checking it here would need the value threaded in for
 * one comparison.
 */
export async function switchConversationDirect(
  ctx: ConversationSwitchDeps,
  targetConversationId: string,
  options: {
    origin: ConversationSwitchContext["origin"];
    /** The command row to finish; absent for a switch nobody typed. */
    command?: CommandHandle | null;
  },
): Promise<ConversationSwitchOutcome> {
  const { command } = options;
  ctx.setCommandRunning(true);
  try {
    const resumeData = ctx.agentState
      ? await getResumeDataFromBackend(ctx.agentState, targetConversationId)
      : null;
    if (!resumeData) {
      return { status: "failed", message: "Failed: agent state not available" };
    }

    ctx.setConversationIdAndRef(targetConversationId);
    ctx.setConversationAutoTitleEligibility(false);

    ctx.pendingConversationSwitchRef.current = {
      origin: options.origin,
      conversationId: targetConversationId,
      isDefault: targetConversationId === "default",
      messageCount: resumeData.messageHistory.length,
      messageHistory: resumeData.messageHistory,
    };

    settingsManager.persistSession(ctx.agentId, targetConversationId);

    const currentAgentName = ctx.agentState?.name || "Unnamed Agent";
    const message =
      resumeData.messageHistory.length > 0
        ? [
            `Resumed conversation with "${currentAgentName}"`,
            `${CLI_GLYPHS.result}  Agent: ${ctx.agentId}`,
            `${CLI_GLYPHS.result}  Conversation: ${targetConversationId}`,
          ].join("\n")
        : [
            `Switched to conversation with "${currentAgentName}"`,
            `${CLI_GLYPHS.result}  Agent: ${ctx.agentId}`,
            `${CLI_GLYPHS.result}  Conversation: ${targetConversationId} (empty)`,
          ].join("\n");

    command?.finish(message, true);
    const successItem: StaticItem | null = command
      ? {
          kind: "command",
          id: command.id,
          input: command.input,
          output: message,
          phase: "finished",
          success: true,
        }
      : null;

    ctx.buffersRef.current.byId.clear();
    ctx.buffersRef.current.order = [];
    ctx.buffersRef.current.tokenCount = 0;
    resetContextHistory(ctx.contextTrackerRef.current);
    ctx.resetBootstrapReminderState();
    ctx.emittedIdsRef.current.clear();
    ctx.resetDeferredToolCallCommits();
    ctx.setStaticItems([]);
    ctx.setStaticRenderEpoch((e) => e + 1);
    ctx.resetTrajectoryBases();

    const separator = { kind: "separator" as const, id: uid("sep") };
    if (resumeData.messageHistory.length > 0) {
      ctx.hasBackfilledRef.current = false;
      backfillBuffers(ctx.buffersRef.current, resumeData.messageHistory);
      const backfilledItems: StaticItem[] = [];
      for (const id of ctx.buffersRef.current.order) {
        const ln = ctx.buffersRef.current.byId.get(id);
        if (!ln) continue;
        ctx.emittedIdsRef.current.add(id);
        backfilledItems.push({ ...ln } as StaticItem);
      }
      ctx.setStaticItems(
        successItem
          ? [separator, ...backfilledItems, successItem]
          : [separator, ...backfilledItems],
      );
      ctx.setLines(toLines(ctx.buffersRef.current));
      ctx.hasBackfilledRef.current = true;
    } else {
      ctx.setStaticItems(successItem ? [separator, successItem] : [separator]);
      ctx.setLines(toLines(ctx.buffersRef.current));
    }

    if (resumeData.pendingApprovals.length > 0) {
      await ctx.recoverRestoredPendingApprovals(resumeData.pendingApprovals);
    }

    return { status: "switched", message };
  } catch (error) {
    let errorMsg = "Unknown error";
    if (error instanceof APIError) {
      if (error.status === 404) {
        errorMsg = "Conversation not found";
      } else if (error.status === 422) {
        errorMsg = "Invalid conversation ID";
      } else {
        errorMsg = error.message;
      }
    } else if (error instanceof Error) {
      errorMsg = error.message;
    }
    const message = `Failed to switch conversation: ${errorMsg}`;
    command?.fail(message);
    return { status: "failed", message };
  } finally {
    ctx.setCommandRunning(false);
  }
}

export async function handleNavigationCommand(
  trimmed: string,
  ctx: NavigationCommandContext,
): Promise<SubmitCommandResult | null> {
  const { commandRunner, conversationId, setSearchQuery, openOverlay } = ctx;

  // Special handling for /agents command - show agent browser
  if (
    trimmed === "/agents" ||
    trimmed === "/pinned" ||
    trimmed === "/profiles"
  ) {
    openOverlay(
      "resume",
      "/agents",
      "Opening agent browser...",
      "Agent browser dismissed",
    );
    return { submitted: true };
  }

  // Special handling for /resume command - show conversation selector or switch directly
  if (trimmed.startsWith("/resume")) {
    const parts = trimmed.split(/\s+/);
    const targetConvId = parts[1];

    if (targetConvId === "help") {
      const cmd = commandRunner.start(trimmed, "Showing resume help...");
      const output = [
        "/resume help",
        "",
        "Resume a previous conversation.",
        "",
        "USAGE",
        "  /resume                       — open conversation selector",
        "  /resume <conversation_id>     — switch directly to a conversation",
        "  /resume help                  — show this help",
      ].join("\n");
      cmd.finish(output, true);
      return { submitted: true };
    }

    if (targetConvId) {
      const cmd = commandRunner.start(trimmed, "Switching conversation...");
      if (targetConvId === conversationId) {
        cmd.finish("Already on this conversation", true);
        return { submitted: true };
      }
      await switchConversationDirect(ctx, targetConvId, {
        origin: "resume-direct",
        command: cmd,
      });
      return { submitted: true };
    }

    openOverlay(
      "conversations",
      "/resume",
      "Opening conversation selector...",
      "Conversation selector dismissed",
    );
    return { submitted: true };
  }

  // Special handling for /search command - show message search
  if (trimmed.startsWith("/search")) {
    const [, ...rest] = trimmed.split(/\s+/);
    const query = rest.join(" ").trim();
    setSearchQuery(query);
    openOverlay(
      "search",
      "/search",
      "Opening message search...",
      "Message search dismissed",
    );
    return { submitted: true };
  }

  return null;
}
