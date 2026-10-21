import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ApprovalResult } from "@/agent/approval-execution";
import type { PersonalityId } from "@/agent/personality-presets";
import type { SessionStats } from "@/agent/stats";
import type { CommandHandle } from "@/cli/commands/runner";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import type { ConversationSwitchContext } from "@/cli/helpers/conversation-switch-alert";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ModConversationCloseReason } from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import type { QueueRuntime } from "@/queue/queue-runtime";
import type { SharedReminderState } from "@/reminders/state";
import type {
  ActiveOverlay,
  AppCommandRunner,
  ProcessConversation,
  StaticItem,
  TabStripProjection,
} from "./types";

/**
 * Everything `useSubmitHandler` is given, in one place.
 *
 * Split from the hook because it is the *interface*, not the behaviour: the
 * submit path is a pipeline of command handlers, and this type is what they are
 * all handed. It also happens to be a fifth of the file by line count, which the
 * source-size ratchet cares about — but the split is the right one even without
 * that: a reader asking "what can a submit handler see?" should not have to scroll
 * past two hundred lines of prompt assembly to find out.
 *
 * The four small sibling types (`PendingGitReminder`, `ProfileConfirmPending`,
 * `WorktreeDiffSelectorPending`, `ModelSelectorOptions`) live here too: they are
 * fields of the context, so keeping them anywhere else would put the shape and its
 * parts in different files.
 */

export type BashCommandCacheEntry = {
  input: string;
  output: string;
};

export type PendingGitReminder = {
  dirty: boolean;
  aheadOfRemote: boolean;
  summary: string;
};

export type ProfileConfirmPending = {
  name: string;
  agentId: string;
  cmdId: string;
};

export type WorktreeDiffSelectorPending = {
  worktrees: import("@/web/worktree-diff-list").WorktreeDiffOption[];
};

export type ModelSelectorOptions = {
  filterProvider?: string;
  forceRefresh?: boolean;
};

export type SubmitHandlerContext = {
  abortControllerRef: MutableRefObject<AbortController | null>;
  agentDescription: string | null;
  agentId: string;
  agentIdRef: MutableRefObject<string>;
  agentLastRunAt: string | null;
  agentName: string | null;
  agentState: AgentState | null | undefined;
  agentStateRef: MutableRefObject<AgentState | null | undefined>;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  bashCommandCacheRef: MutableRefObject<BashCommandCacheEntry[]>;
  buffersRef: MutableRefObject<Buffers>;
  checkPendingApprovalsForSlashCommand: () => Promise<
    { blocked: true } | { blocked: false }
  >;
  commandRunner: AppCommandRunner;
  commandRunning: boolean;
  consumeQueuedApprovalInputForCurrentConversation: (
    otid?: string,
  ) => ApprovalCreate | null;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  conversationGenerationRef: MutableRefObject<number>;
  conversationId: string;
  conversationIdRef: MutableRefObject<string>;
  currentModelHandle: string | null;
  currentModelId: string | null;
  currentModelLabel: string | null;
  currentModelProvider: string | null;
  effectiveContextWindowSize: number | undefined;
  emittedIdsRef: MutableRefObject<Set<string>>;
  modAdapter: LocalModAdapter;
  firstUserQueryRef: MutableRefObject<string | null>;
  flushPendingReasoningEffort: () => Promise<void>;
  generateConversationDescription: (options?: {
    force?: boolean;
  }) => Promise<void>;
  generateConversationTitle: () => Promise<string | null>;
  handleAgentSelect: (
    targetAgentId: string,
    opts?: {
      profileName?: string;
      conversationId?: string;
      commandId?: string;
    },
  ) => Promise<void>;
  handleBtwCommand: (question: string) => Promise<void>;
  handleExit: () => Promise<void>;
  hasBackfilledRef: MutableRefObject<boolean>;
  isAgentBusy: () => boolean;
  isExecutingTool: boolean;
  llmConfigRef: MutableRefObject<LlmConfig | null>;
  maybeCarryOverActiveConversationModel: (
    targetConversationId: string,
  ) => Promise<void>;
  needsEagerApprovalCheck: boolean;
  openTrajectorySegment: () => void;
  overrideContentPartsRef: MutableRefObject<MessageCreate["content"] | null>;
  pendingApprovals: ApprovalRequest[];
  pendingConversationSwitchRef: MutableRefObject<ConversationSwitchContext | null>;
  pendingGitReminderRef: MutableRefObject<PendingGitReminder | null>;
  processConversation: ProcessConversation;
  processConversationWithQueuedApprovals: ProcessConversation;
  profileConfirmPending: ProfileConfirmPending | null;
  projectDirectory: string;
  queuedApprovalResults: ApprovalResult[] | null;
  reasoningTabCycleEnabled: boolean;
  recoverRestoredPendingApprovals: (
    approvals: ApprovalRequest[],
    options?: { notifyOnManualApproval?: boolean },
  ) => Promise<void>;
  refreshDerived: () => void;
  resetBootstrapReminderState: (pendingConversationBootstrap?: boolean) => void;
  resetDeferredToolCallCommits: () => void;
  resetPendingReasoningCycle: () => void;
  resetTrajectoryBases: () => void;
  runEndHooks: (reason?: ModConversationCloseReason) => Promise<void>;
  sessionHooksRanRef: MutableRefObject<boolean>;
  sessionStartFeedbackRef: MutableRefObject<string[]>;
  sessionStatsRef: MutableRefObject<SessionStats>;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => CommandHandle;
  /**
   * The tab strip's actions (`tab-strip-actions.ts`).
   *
   * `/close` goes through the same function a click on `×` does: the "can this be
   * closed" ruling (busy, last conversation) lives there, and a command that
   * re-derived it would be a second answer that could disagree.
   */
  tabStrip: TabStripProjection;
  setAgentDescription: Dispatch<SetStateAction<string | null>>;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setCommandRunning: (value: boolean) => void;
  setConversationAutoTitleEligibility: (enabled: boolean) => void;
  setConversationIdAndRef: (nextConversationId: string) => void;
  setConversationSummary: (summary: string | null) => void;
  setConversationOverrideContextWindowLimit: Dispatch<
    SetStateAction<number | null>
  >;
  setConversationOverrideModelSettings: Dispatch<
    SetStateAction<AgentState["model_settings"] | null>
  >;
  setCurrentPersonalityId: Dispatch<SetStateAction<PersonalityId | null>>;
  setDequeueEpoch: Dispatch<SetStateAction<number>>;
  setFeedbackPrefill: Dispatch<SetStateAction<string>>;
  setHasConversationModelOverride: (value: boolean) => void;
  setLines: Dispatch<SetStateAction<Line[]>>;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
  markLocalModelsAvailable: () => void;
  setModelSelectorOptions: Dispatch<SetStateAction<ModelSelectorOptions>>;
  setNeedsEagerApprovalCheck: Dispatch<SetStateAction<boolean>>;
  setProfileConfirmPending: Dispatch<
    SetStateAction<ProfileConfirmPending | null>
  >;
  setWorktreeDiffSelectorPending: Dispatch<
    SetStateAction<WorktreeDiffSelectorPending | null>
  >;
  setReasoningTabCycleEnabled: Dispatch<SetStateAction<boolean>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setStaticItems: Dispatch<SetStateAction<StaticItem[]>>;
  setStaticRenderEpoch: Dispatch<SetStateAction<number>>;
  setStreaming: (value: boolean) => void;
  setThinkingMessage: Dispatch<SetStateAction<string>>;
  setTokenStreamingEnabled: Dispatch<SetStateAction<boolean>>;
  setTrajectoryTokenBase: Dispatch<SetStateAction<number>>;
  sharedReminderStateRef: MutableRefObject<SharedReminderState>;
  shouldAutoGenerateConversationTitleRef: MutableRefObject<boolean>;

  streaming: boolean;
  systemInfoReminderEnabled: boolean;
  tokenStreamingEnabled: boolean;
  trajectoryRunTokenStartRef: MutableRefObject<number>;
  trajectoryTokenDisplayRef: MutableRefObject<number>;
  tuiQueueRef: MutableRefObject<QueueRuntime | null>;
  updateAgentName: (name: string) => void;
  updateMemorySyncCommand: (
    commandId: string,
    output: string,
    success: boolean,
    input?: string,
    keepRunning?: boolean,
  ) => void;
  userCancelledRef: MutableRefObject<boolean>;
  onReload?: () => Promise<void>;
};
