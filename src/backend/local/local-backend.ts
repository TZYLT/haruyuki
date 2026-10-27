import { GIT_MEMORY_ENABLED_TAG } from "@/agent/agent-tags";
import { stampRootMemoryOnCreateBody } from "@/agent/memory-filesystem";
import {
  type InitializeLocalMemoryRepoFile,
  initializeLocalMemoryRepo,
} from "@/agent/memory-git";
import type {
  Backend,
  BackendCapabilities,
  ConversationCreateBody,
  ConversationMessageCompactBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  ConversationRecompileBody,
} from "@/backend/backend";
import {
  HEADLESS_BACKEND_CAPABILITIES,
  HeadlessBackend,
  type ResolvedTurnPrefix,
} from "@/backend/dev/headless-backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import type { PiStreamFunction } from "@/backend/dev/pi-stream-adapter";
import type {
  LlmEndInfo,
  LlmStartInfo,
} from "@/backend/dev/provider-turn-executor";
import { shouldAdvertiseTopicMarking } from "@/settings-tool-gates";
import { readTopicSettings } from "@/topic-settings";
import { isRecord } from "@/utils/type-guards";
import {
  estimateLocalMessageTokens,
  type LocalCompactionStats,
  type LocalCompleteFunction,
  packageLocalSummaryMessage,
  planLocalSlidingWindowCompaction,
  summarizeLocalMessagesSlidingWindow,
} from "./compaction";
import type { CompactionPreview, CompactPick } from "./compaction-preview";
import {
  applyCompaction as applyCompactionRun,
  type CompactionApplyResult,
  prepareCompaction as prepareCompactionRun,
} from "./compaction-run";
import { summarizeConversation } from "./compaction-summarizer";
import { initialMemoryFilesFromCreateBody } from "./initial-memory";
import {
  compactionSettingsRecord,
  localCompactionSettingsForStorage,
  mergeLocalCompactionSettings,
  type ResolvedLocalCompactionSettings,
  resolveLocalCompactionSettings,
  validateLocalCompactionSettingsRecord,
} from "./local-compaction-settings";
import type { LocalTopicMarkerAppendResult } from "./local-context-rewrite";
import { deleteLocalConversationSettings } from "./local-conversation-delete-settings";
import {
  createLocalExecutor,
  type LocalBackendExecutionMode,
} from "./local-executor-factory";
import type { LocalMessage } from "./local-message";
import {
  listLocalModels,
  localModelSettingsForHandle,
  resolveLocalModelConfig,
} from "./local-model-config";
import type {
  LocalAgentRecord,
  LocalStoreOptions,
  StoredMessage,
} from "./local-store";
import {
  consumeLocalTopicNudge,
  localTopicNudgePorts,
} from "./local-topic-nudge";
import {
  type LocalTopicList,
  type LocalTopicTrimPorts,
  listLocalTopics,
} from "./local-topic-trim";
import type { LocalTopicCreatedBy } from "./local-transcript-topic-entry";
import {
  getLocalBackendMemoryFilesystemRoot,
  isLocalBackendMemfsDisabledForProcess,
} from "./paths";
import {
  applyFrozenAgentOverrides,
  assembleFrozenTurnPrefix,
  buildContextPendingReport,
  type ContextPendingReport,
  collectMemoryPending,
  isMemoryDirDirty,
  stampFreezeMetadata,
} from "./prefix-freeze";
import {
  type RecallDedupWindow,
  recallDedupPorts,
  type SettledRecallDedup,
  settleRecallDedup as settleLocalRecallDedup,
} from "./recall-dedup";
import {
  appendAvailableSkillsBlock,
  compileLocalSystemPrompt,
  type LocalCompiledSystemPrompt,
  type LocalFreezeReason,
} from "./system-prompt-compilation";
import type { LocalTopicMarker } from "./topic-compaction";
import {
  type TopicNudgeDecision,
  userTurnsSinceLastTopicMarker,
} from "./topic-compaction";
import { refreshTopicIndexForConversation } from "./topic-index";

export interface LocalBackendOptions {
  storageDir: string;
  stateStorageDir?: string;
  defaultAgentId?: string;
  executionMode?: LocalBackendExecutionMode;
  executor?: HeadlessTurnExecutor;
  stream?: PiStreamFunction;
  complete?: LocalCompleteFunction;
  memoryDir?: string;
  memfsEnabled?: boolean;
  modelsRuntime?: LocalPiModelsRuntime;
}
/**
 * Hooks the harness installs (via {@link LocalBackend.setModEventHooks}) so
 * mods can observe backend-internal lifecycle that only the local backend owns
 * (compaction and provider calls). The backend stays mod-agnostic: it invokes
 * these plain callbacks and never touches mod state.
 */
export interface LocalBackendModEventHooks {
  onCompactStart?: (info: {
    agentId: string;
    conversationId: string;
    trigger: string;
  }) => void | Promise<void>;
  onCompactEnd?: (info: {
    agentId: string;
    conversationId: string;
    trigger: string;
    messagesBefore: number;
    messagesAfter: number;
    contextTokensBefore: number;
    contextTokensAfter: number;
  }) => void | Promise<void>;
  onLlmStart?: (info: LlmStartInfo) => void | Promise<void>;
  onLlmEnd?: (info: LlmEndInfo) => void | Promise<void>;
}

export class LocalBackend extends HeadlessBackend {
  override readonly capabilities: BackendCapabilities = {
    ...HEADLESS_BACKEND_CAPABILITIES,
    promptRecompile: true,
    localMemfs: true,
  };

  private readonly memoryDir?: string;
  private readonly storageDir: string;
  private readonly stateStorageDir?: string;
  private readonly piModelsRuntime: LocalPiModelsRuntime;
  private readonly complete?: LocalCompleteFunction;
  private readonly memfsEnabledOverride?: boolean;
  private modEventHooks?: LocalBackendModEventHooks;

  constructor(options: LocalBackendOptions) {
    const localBackendRef: { current?: LocalBackend } = {};
    // One runtime per backend: listing/turns/compaction share Models state.
    const runtime =
      options.modelsRuntime ??
      new LocalPiModelsRuntime({ storageDir: options.storageDir });
    const modelConfig = resolveLocalModelConfig(options.storageDir, runtime);
    const storeOptions: LocalStoreOptions = {
      storageDir: options.stateStorageDir ?? options.storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
      defaultAgentName: "Haruyuki",
      defaultAgentModel: modelConfig.handle,
      defaultAgentModelSettings: modelConfig.modelSettings,
      modelSettingsForModel: (handle) =>
        localModelSettingsForHandle(handle, runtime),
      conversationIdPrefix: "local-conv-",
      storedMessageIdPrefix: "letta-msg-",
      localMessageIdPrefix: "ui-msg-",
    };
    super(
      options.defaultAgentId ?? "agent-local-default",
      createLocalExecutor(
        options,
        runtime,
        (info) =>
          localBackendRef.current?.emitLlmStart(info) ?? Promise.resolve(),
        (info) =>
          localBackendRef.current?.emitLlmEnd(info) ?? Promise.resolve(),
      ),
      storeOptions,
      {
        modelHandle: modelConfig.handle,
        runIdPrefix: "local-run-",
        runMetadataBackend: "local",
      },
    );
    localBackendRef.current = this;
    this.storageDir = options.storageDir;
    this.stateStorageDir = options.stateStorageDir;
    this.memoryDir = options.memoryDir;
    this.complete = options.complete;
    this.memfsEnabledOverride = options.memfsEnabled;
    this.piModelsRuntime = runtime;
  }

  /**
   * Late-bound because the backend is a process-global singleton constructed
   * before the harness mod adapter exists. The harness calls this once the
   * registry is ready to forward backend-internal events to local mods.
   */
  setModEventHooks(hooks: LocalBackendModEventHooks | undefined): void {
    this.modEventHooks = hooks;
  }

  private async emitCompactStart(
    conversationId: string,
    agentId: string,
    trigger: string,
  ): Promise<void> {
    const hook = this.modEventHooks?.onCompactStart;
    if (!hook) return;
    try {
      await hook({ agentId, conversationId, trigger });
    } catch {
      // Mod event hooks must never break compaction.
    }
  }

  private async emitCompactEnd(
    conversationId: string,
    agentId: string,
    trigger: string,
    stats: LocalCompactionStats,
  ): Promise<void> {
    const hook = this.modEventHooks?.onCompactEnd;
    if (!hook) return;
    try {
      await hook({
        agentId,
        conversationId,
        trigger,
        messagesBefore: stats.messages_count_before ?? 0,
        messagesAfter: stats.messages_count_after ?? 0,
        contextTokensBefore: stats.context_tokens_before ?? 0,
        contextTokensAfter: stats.context_tokens_after ?? 0,
      });
    } catch {
      // Mod event hooks must never break compaction.
    }
  }

  private async emitLlmStart(info: LlmStartInfo): Promise<void> {
    const hook = this.modEventHooks?.onLlmStart;
    if (!hook) return;
    try {
      await hook(info);
    } catch {
      // Mod event hooks must never break a provider request.
    }
  }

  private async emitLlmEnd(info: LlmEndInfo): Promise<void> {
    const hook = this.modEventHooks?.onLlmEnd;
    if (!hook) return;
    try {
      await hook(info);
    } catch {
      // Mod event hooks must never break a provider request.
    }
  }

  getLocalStorageDir(): string {
    return this.storageDir;
  }

  /** Refresh one conversation's entries in the topic index (§5.11.3), on the
   * same root as the store: the ephemeral backend keeps state under it. */
  private refreshTopicIndex(conversationId: string, agentId: string): void {
    refreshTopicIndexForConversation(
      agentId,
      conversationId,
      this.stateStorageDir ?? this.storageDir,
    );
  }

  override async listModels() {
    return listLocalModels(this.storageDir, {
      modelsRuntime: this.piModelsRuntime,
    }) as never;
  }

  override async createAgent(
    ...args: Parameters<HeadlessBackend["createAgent"]>
  ) {
    let [body, ...restArgs] = args;
    // Stamp local memfs agents so downstream tag checks enable memory sync.
    if (this.isLocalMemfsEnabled()) {
      body = stampRootMemoryOnCreateBody(body);
      const bodyRecord = body as Record<string, unknown>;
      const existingTags = Array.isArray(bodyRecord.tags)
        ? (bodyRecord.tags as string[])
        : [];
      if (!existingTags.includes(GIT_MEMORY_ENABLED_TAG)) {
        body = {
          ...bodyRecord,
          tags: [...existingTags, GIT_MEMORY_ENABLED_TAG],
        } as typeof body;
      }
    }
    const requestedCompactionSettings = compactionSettingsRecord(
      (body as Record<string, unknown>).compaction_settings,
    );
    if (
      requestedCompactionSettings !== undefined &&
      requestedCompactionSettings !== null
    ) {
      validateLocalCompactionSettingsRecord(requestedCompactionSettings);
    }
    const compactionSettingsForStorage = localCompactionSettingsForStorage(
      requestedCompactionSettings,
    );
    let agent = await super.createAgent(body, ...restArgs);
    if (compactionSettingsForStorage !== undefined) {
      agent = this.store.setAgentCompactionSettings(
        agent.id,
        compactionSettingsForStorage,
      );
    }
    if (this.isLocalMemfsEnabled()) {
      await this.ensureLocalMemoryRepo(
        agent.id,
        initialMemoryFilesFromCreateBody(body),
        agent.name ?? undefined,
      );
    }
    await this.compileAndMaybePersistSystemPrompt("default", agent.id, {
      dryRun: false,
      reason: "conversation_created",
    });
    return agent;
  }

  /**
   * Fork a conversation, carrying its topic markers across: the store clones
   * messages with fresh ids, so each anchor is remapped onto the child's copy by
   * position — valid because the child is a prefix of the parent. An
   * `inherited-context` fork holds the current window instead, which is not a
   * positional prefix, so its markers are not copied at all.
   */
  override async forkConversation(
    ...args: Parameters<HeadlessBackend["forkConversation"]>
  ): ReturnType<HeadlessBackend["forkConversation"]> {
    const sourceMessages = this.store.listLocalMessages(
      args[0],
      args[1]?.agentId,
    );
    const forked = await super.forkConversation(...args);
    if (args[1]?.contextMode === "inherited-context") return forked;
    const forkedMessages = this.store.listLocalMessages(forked.id);
    const anchorIds = new Map(
      forkedMessages.map((message, index) => [
        sourceMessages[index]?.id ?? "",
        message.id,
      ]),
    );
    const targetAgentId =
      args[1]?.agentId ?? this.store.resolveAgentIdForConversation(forked.id);
    this.store.contextRewrites.copyTopicMarkersForFork({
      sourceConversationId: args[0],
      sourceAgentId:
        args[1]?.agentId ?? this.store.resolveAgentIdForConversation(args[0]),
      targetConversationId: forked.id,
      targetAgentId,
      anchorIds,
    });
    this.refreshTopicIndex(forked.id, targetAgentId);
    return forked;
  }

  override async updateAgent(
    ...args: Parameters<HeadlessBackend["updateAgent"]>
  ) {
    const [agentId, body] = args;
    const bodyRecord = body as Record<string, unknown>;
    const settings = Object.hasOwn(bodyRecord, "compaction_settings")
      ? compactionSettingsRecord(bodyRecord.compaction_settings)
      : undefined;
    if (settings !== undefined && settings !== null) {
      validateLocalCompactionSettingsRecord(settings);
    }
    const compactionSettingsForStorage =
      localCompactionSettingsForStorage(settings);
    let agent = await super.updateAgent(...args);
    if (Object.hasOwn(bodyRecord, "compaction_settings")) {
      if (compactionSettingsForStorage !== undefined) {
        agent = this.store.setAgentCompactionSettings(
          agentId,
          mergeLocalCompactionSettings(
            compactionSettingsRecord(agent.compaction_settings),
            compactionSettingsForStorage,
          ),
        );
      }
    }
    return agent;
  }

  override async createConversation(
    body: ConversationCreateBody,
  ): ReturnType<HeadlessBackend["createConversation"]> {
    const conversation = await super.createConversation(body);
    await this.compileAndMaybePersistSystemPrompt(
      conversation.id,
      conversation.agent_id,
      { dryRun: false, reason: "conversation_created" },
    );
    return conversation;
  }

  async createEphemeralConversation(body: {
    model: string;
    system: string;
    model_settings?: Record<string, unknown>;
    context_window_limit?: number | null;
    parent_agent_id?: string | null;
    name?: string;
    is_subagent?: boolean;
  }): Promise<
    Awaited<ReturnType<NonNullable<Backend["createEphemeralConversation"]>>>
  > {
    return this.store.createEphemeralConversation(body) as unknown as Awaited<
      ReturnType<NonNullable<Backend["createEphemeralConversation"]>>
    >;
  }

  /**
   * Physically delete a conversation (F-01 M2).
   *
   * The record is resolved first because the owning agent is what keys the
   * conversation-scoped settings; after deletion it cannot be resolved anymore.
   * The store performs the delete (directory out of the live tree, then memory,
   * then the trash copy) and the settings cleanup runs afterwards, idempotently:
   * a settings failure is logged and never resurrects the deleted row.
   */
  async deleteConversation(conversationId: string): Promise<void> {
    const conversation =
      this.store.resolveConversationRecordForDelete(conversationId);
    this.store.deleteConversation(conversationId, conversation.agent_id);
    // The transcript is gone, so this drops the conversation's index record.
    this.refreshTopicIndex(conversationId, conversation.agent_id);
    await deleteLocalConversationSettings({
      agentId: conversation.agent_id,
      agentFree: conversation.agent_free === true,
      conversationId,
    });
  }

  override async recompileConversation(
    conversationId: string,
    body?: ConversationRecompileBody,
  ) {
    const bodyRecord = (body ?? {}) as Record<string, unknown>;
    const agentId =
      typeof bodyRecord.agent_id === "string" && bodyRecord.agent_id.length > 0
        ? bodyRecord.agent_id
        : this.store.resolveAgentIdForConversation(conversationId);
    const compiled = await this.compileAndMaybePersistSystemPrompt(
      conversationId,
      agentId,
      {
        dryRun: bodyRecord.dry_run === true,
        reason: "manual_recompile",
      },
    );
    return compiled.content;
  }

  override async compactConversationMessages(
    conversationId: string,
    body?: ConversationMessageCompactBody,
  ): ReturnType<Backend["compactConversationMessages"]> {
    const bodyRecord = (body ?? {}) as Record<string, unknown>;
    const agentId =
      typeof bodyRecord.agent_id === "string" && bodyRecord.agent_id.length > 0
        ? bodyRecord.agent_id
        : this.store.resolveAgentIdForConversation(conversationId);
    const result = await this.compactLocalConversation(
      conversationId,
      agentId,
      "manual",
      body,
    );
    return {
      num_messages_before: result.numMessagesBefore,
      num_messages_after: result.numMessagesAfter,
      summary: result.summary,
    } as Awaited<ReturnType<Backend["compactConversationMessages"]>>;
  }

  /**
   * Local-only: describe the prefix changes that are registered but not yet
   * applied, for the `/context pending` command. Read-only — never rewrites the
   * frozen prefix (requirement §6, `buildContextPendingReport`).
   */
  async getContextPending(
    conversationId: string,
    agentId: string,
    options: { full?: boolean } = {},
  ): Promise<ContextPendingReport> {
    const snapshot = this.store.getCompiledSystemPrompt(
      conversationId,
      agentId,
    );
    const liveAgent = this.effectiveAgentForConversation(
      conversationId,
      agentId,
    );
    const memfsEnabled = this.isLocalMemfsEnabled();
    const memoryDir = this.memoryDirForAgent(agentId);
    const memory = memfsEnabled
      ? collectMemoryPending(memoryDir, snapshot?.memfsRevision, {
          full: options.full === true,
        })
      : { unappliedCommits: [], diffStat: "" };
    return buildContextPendingReport({
      snapshot,
      liveAgent,
      memory,
      dirty: memfsEnabled && isMemoryDirDirty(memoryDir),
    });
  }

  /**
   * Local-only: append a topic marker to the conversation transcript.
   *
   * A marker is metadata — the context, the in-context id list, and the frozen
   * prefix are all untouched, so `TopicMark` / `/topic` can never invalidate the
   * provider cache. The anchor is the newest in-context message at write time;
   * `contextMessageCount === 0` means there was nothing to anchor to and the
   * caller must refuse the mark.
   */
  markTopic(input: {
    conversationId: string;
    agentId?: string;
    title: string;
    summary?: string;
    createdBy: LocalTopicCreatedBy;
  }): LocalTopicMarkerAppendResult {
    const agentId =
      input.agentId ??
      this.store.resolveAgentIdForConversation(input.conversationId);
    const result = this.store.contextRewrites.appendTopicMarker({
      conversationId: input.conversationId,
      agentId,
      title: input.title,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdBy: input.createdBy,
    });
    this.refreshTopicIndex(input.conversationId, agentId);
    return result;
  }

  /** Local-only: every marker in the transcript, oldest first. */
  listTopicMarkers(
    conversationId: string,
    agentId?: string,
  ): LocalTopicMarker[] {
    return this.store.contextRewrites.readTopicMarkers(
      conversationId,
      agentId ?? this.store.resolveAgentIdForConversation(conversationId),
    );
  }

  /**
   * Local-only: the facts the marker frequency gate reads *before* writing.
   *
   * `markTopic` reports `turnsSincePrevious` too, but only after the row exists
   * — a gate that rejects has to decide first, so the same numbers must be
   * derivable without mutating anything.
   */
  topicMarkerState(
    conversationId: string,
    agentId?: string,
  ): {
    markers: LocalTopicMarker[];
    turnsSinceLastMarker: number;
    contextMessageCount: number;
    /** Anchor a fresh marker would get; `null` for an empty context (L-6). */
    latestMessageId: string | null;
  } {
    const resolvedAgentId =
      agentId ?? this.store.resolveAgentIdForConversation(conversationId);
    const messages = this.store.listLocalMessages(
      conversationId,
      resolvedAgentId,
    );
    const markers = this.store.contextRewrites.readTopicMarkers(
      conversationId,
      resolvedAgentId,
    );
    return {
      markers,
      turnsSinceLastMarker: userTurnsSinceLastTopicMarker(messages, markers),
      contextMessageCount: messages.length,
      latestMessageId: messages.at(-1)?.id ?? null,
    };
  }

  /**
   * Local-only: decide the one-shot no-marker nudge (D-114) and settle its flag
   * in the same call. Read the decision's `reason` for why it did not fire.
   */
  consumeTopicNudge(
    conversationId: string,
    agentId?: string,
  ): TopicNudgeDecision {
    return consumeLocalTopicNudge(localTopicNudgePorts(this.store), {
      conversationId,
      agentId:
        agentId ?? this.store.resolveAgentIdForConversation(conversationId),
      nudgeTurns: readTopicSettings().nudgeTurns,
    });
  }

  /**
   * Local-only: feature ②'s dedup window. Returns the fingerprints whose
   * recording turn is still inside the window, and (when `injected` is given)
   * records that this turn injected them.
   *
   * One method for the read and the write because the caller needs both answers
   * from the same observation of the conversation record: it filters candidates
   * with `suppressed`, then reports what survived. Omit `injected` to only prune —
   * that is what `/recall status` and a turn with no hits do.
   */
  settleRecallDedup(input: {
    conversationId: string;
    agentId?: string;
    currentTurn: number;
    keepTurns: number;
    injected?: RecallDedupWindow;
  }): SettledRecallDedup {
    return settleLocalRecallDedup(recallDedupPorts(this.store), {
      ...input,
      agentId:
        input.agentId ??
        this.store.resolveAgentIdForConversation(input.conversationId),
    });
  }

  /**
   * Local-only: the topic blocks of the current context, cut at each marker's
   * *effective* boundary, plus every marker in the transcript for
   * `/topic list --all`. Read-only — a list never rewrites anything.
   */
  listTopics(
    conversationId: string,
    agentId?: string,
    options: { rewindTurns?: number } = {},
  ): LocalTopicList {
    return listLocalTopics(this.topicTrimPorts(), {
      conversationId,
      ...(agentId === undefined ? {} : { agentId }),
      rewindTurns:
        options.rewindTurns ?? readTopicSettings().boundaryRewindTurns,
    });
  }

  /** F-04: run the summarizer once on the frozen prefix; writes nothing. */
  prepareCompaction(input: {
    conversationId: string;
    agentId?: string;
    signal?: AbortSignal;
  }): Promise<CompactionPreview> {
    const agentId =
      input.agentId ??
      this.store.resolveAgentIdForConversation(input.conversationId);
    const ports = this.topicTrimPorts();
    return prepareCompactionRun(
      {
        // The summarizer opens its own store, so it must sit on the same root
        // as this backend's: the ephemeral one keeps state in stateStorageDir.
        storageDir: this.stateStorageDir ?? this.storageDir,
        listMessages: ports.listMessages,
        readMarkers: ports.readMarkers,
        compactionSettings: ports.compactionSettings,
        frozenAgent: (conversationId, ownerAgentId) =>
          this.frozenAgentForConversation(conversationId, ownerAgentId),
        summarize: summarizeConversation,
      },
      {
        conversationId: input.conversationId,
        agentId,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
  }

  /** F-04: fold the preview's picked region; no model call, no write on a no-op. */
  applyCompaction(input: {
    preview: CompactionPreview;
    pick: CompactPick;
  }): Promise<CompactionApplyResult> {
    const ports = this.topicTrimPorts();
    return applyCompactionRun(
      {
        listMessages: ports.listMessages,
        readMarkers: ports.readMarkers,
        compactionSettings: ports.compactionSettings,
        rewrite: ports.rewrite,
        refreshFrozenPrefix: ports.refreshFrozenPrefix,
        clearTopicNudgeStreak: ports.clearTopicNudgeStreak,
        refreshIndex: () =>
          this.refreshTopicIndex(
            input.preview.conversationId,
            input.preview.agentId,
          ),
      },
      input,
    );
  }

  private topicTrimPorts(): LocalTopicTrimPorts {
    return {
      resolveAgentId: (conversationId) =>
        this.store.resolveAgentIdForConversation(conversationId),
      listMessages: (conversationId, agentId) =>
        this.store.listLocalMessages(conversationId, agentId),
      readMarkers: (conversationId, agentId) =>
        this.store.contextRewrites.readTopicMarkers(conversationId, agentId),
      contextWindow: (conversationId, agentId) =>
        this.effectiveContextWindow(conversationId, agentId),
      compactionSettings: (conversationId, agentId) =>
        resolveLocalCompactionSettings(
          this.frozenAgentForConversation(conversationId, agentId),
        ),
      rewrite: (input) => this.store.contextRewrites.rewriteInContext(input),
      clearTopicNudgeStreak: (id, agent) =>
        this.store.contextRewrites.setTopicNudgeSent(id, agent, false),
      refreshFrozenPrefix: async (conversationId, agentId) => {
        await this.compileAndMaybePersistSystemPrompt(conversationId, agentId, {
          dryRun: false,
          reason: "compaction",
        });
      },
    };
  }

  protected override async resolveSystemPromptForTurn(input: {
    conversationId: string;
    agentId: string;
    agent: LocalAgentRecord;
    body: ConversationMessageCreateBody | ConversationMessageStreamBody;
    history: StoredMessage[];
    uiMessages: LocalMessage[];
  }): Promise<ResolvedTurnPrefix> {
    const bodyRecord = input.body as Record<string, unknown>;
    const clientSkills = Array.isArray(bodyRecord.client_skills)
      ? (bodyRecord.client_skills as unknown[])
      : [];
    if (this.store.isAgentFreeConversation(input.conversationId)) {
      // Agent-free conversations never project memory; they are out of the
      // freeze scope (requirement §4.3) and keep recompiling skills per turn.
      return {
        systemPrompt: appendAvailableSkillsBlock(
          input.agent.system,
          clientSkills,
        ),
      };
    }
    const persisted = await this.getOrCompileSystemPrompt(
      input.conversationId,
      input.agentId,
      input.history.length,
    );
    const clientTools = Array.isArray(bodyRecord.client_tools)
      ? (bodyRecord.client_tools as unknown[])
      : [];
    const resolved = assembleFrozenTurnPrefix({
      snapshot: persisted,
      liveAgent: input.agent,
      clientSkills,
      clientTools,
    });
    if (resolved.changed) {
      this.store.setCompiledSystemPrompt(
        input.conversationId,
        input.agentId,
        resolved.snapshot,
      );
    }
    return {
      systemPrompt: resolved.systemPrompt,
      agent: resolved.agent,
      clientTools: resolved.clientTools,
    };
  }

  private memoryDirForAgent(agentId: string): string {
    return (
      this.memoryDir ??
      getLocalBackendMemoryFilesystemRoot(agentId, this.storageDir)
    );
  }

  private isLocalMemfsEnabled(): boolean {
    return (
      this.memfsEnabledOverride ?? !isLocalBackendMemfsDisabledForProcess()
    );
  }

  private async ensureLocalMemoryRepo(
    agentId: string,
    files: InitializeLocalMemoryRepoFile[] = [],
    authorName?: string,
  ): Promise<void> {
    await initializeLocalMemoryRepo({
      memoryDir: this.memoryDirForAgent(agentId),
      agentId,
      authorName,
      files,
    });
  }

  private effectiveContextWindow(
    conversationId: string,
    agentId: string,
  ): number | undefined {
    const conversation = this.store.retrieveConversation(
      conversationId,
      agentId,
    ) as { context_window_limit?: unknown; model_settings?: unknown };
    if (typeof conversation.context_window_limit === "number") {
      return conversation.context_window_limit;
    }
    const conversationModelSettings = conversation.model_settings;
    if (
      conversationModelSettings &&
      typeof conversationModelSettings === "object" &&
      !Array.isArray(conversationModelSettings) &&
      typeof (conversationModelSettings as { context_window_limit?: unknown })
        .context_window_limit === "number"
    ) {
      return (conversationModelSettings as { context_window_limit: number })
        .context_window_limit;
    }
    const agent = this.store.retrieveExecutionAgentRecord(
      conversationId,
      agentId,
    );
    return typeof agent.model_settings.context_window_limit === "number"
      ? agent.model_settings.context_window_limit
      : undefined;
  }

  /**
   * Resolve the model that compaction should use for a conversation.
   *
   * A normal turn runs on the conversation's model override (set via `/model`),
   * but compaction previously read only the agent's base model — so switching
   * a conversation's model never changed which model compaction (and its
   * summarizer) used. This overlays the conversation's `model` / `model_settings`
   * onto the agent record so compaction mirrors the turn path.
   */
  private effectiveAgentForConversation(
    conversationId: string,
    agentId: string,
  ): LocalAgentRecord {
    const agent = this.store.retrieveExecutionAgentRecord(
      conversationId,
      agentId,
    );
    const conversation = this.store.retrieveConversation(
      conversationId,
      agentId,
    ) as { model?: unknown; model_settings?: unknown };
    const model =
      typeof conversation.model === "string" ? conversation.model : undefined;
    const conversationModelSettings = isRecord(conversation.model_settings)
      ? conversation.model_settings
      : undefined;
    if (model === undefined && conversationModelSettings === undefined) {
      return agent;
    }
    return {
      ...agent,
      ...(model !== undefined ? { model } : {}),
      ...(conversationModelSettings !== undefined
        ? {
            model_settings: {
              ...agent.model_settings,
              ...conversationModelSettings,
            },
          }
        : {}),
    };
  }

  /**
   * The agent a compaction should run as: the live record, overlaid with the
   * model the frozen prefix pinned, so a pending `/model` switch only takes
   * effect after the rewrite completes (requirement §6).
   */
  private frozenAgentForConversation(
    conversationId: string,
    agentId: string,
  ): LocalAgentRecord {
    const liveAgent = this.effectiveAgentForConversation(
      conversationId,
      agentId,
    );
    const frozenSnapshot = this.store.getCompiledSystemPrompt(
      conversationId,
      agentId,
    );
    return frozenSnapshot
      ? applyFrozenAgentOverrides(liveAgent, frozenSnapshot)
      : liveAgent;
  }

  private async compactLocalConversation(
    conversationId: string,
    agentId: string,
    trigger: string,
    body?: ConversationMessageCompactBody,
  ): Promise<{
    numMessagesBefore: number;
    numMessagesAfter: number;
    summary: string;
    stats: LocalCompactionStats;
  }> {
    await this.emitCompactStart(conversationId, agentId, trigger);
    const result = await this.compactLocalConversationInner(
      conversationId,
      agentId,
      trigger,
      body,
    );
    await this.emitCompactEnd(conversationId, agentId, trigger, result.stats);
    return result;
  }

  private async compactLocalConversationInner(
    conversationId: string,
    agentId: string,
    trigger: string,
    body?: ConversationMessageCompactBody,
  ): Promise<{
    numMessagesBefore: number;
    numMessagesAfter: number;
    summary: string;
    stats: LocalCompactionStats;
  }> {
    // The summary runs on the frozen model: a pending `/model` switch only
    // takes effect after compaction completes (requirement §6).
    const agent = this.frozenAgentForConversation(conversationId, agentId);
    const settings = resolveLocalCompactionSettings(agent, body);
    const result = await this.compactLocalConversationSlidingWindow(
      conversationId,
      agentId,
      agent,
      trigger,
      settings,
    );
    // Whatever the mode produced is the answer, even when it left the context
    // above the window: escalating to a harsher strategy (the deleted `all`
    // fallback) would take the trim decision away from the operator (I1). A
    // planning failure now surfaces instead of being swallowed.
    await this.compileAndMaybePersistSystemPrompt(conversationId, agentId, {
      dryRun: false,
      reason: "compaction",
    });
    return result;
  }

  private async compactLocalConversationSlidingWindow(
    conversationId: string,
    agentId: string,
    agent: LocalAgentRecord,
    trigger: string,
    settings: ResolvedLocalCompactionSettings,
  ): Promise<{
    numMessagesBefore: number;
    numMessagesAfter: number;
    summary: string;
    stats: LocalCompactionStats;
  }> {
    const messages = this.store.listLocalMessages(conversationId, agentId);
    const contextWindow = this.effectiveContextWindow(conversationId, agentId);
    const plan = planLocalSlidingWindowCompaction(messages, {
      slidingWindowPercentage: settings.slidingWindowPercentage,
    });
    const summary = await summarizeLocalMessagesSlidingWindow({
      conversationId,
      agent,
      messages: plan.messagesToSummarize,
      complete: this.complete,
      prompt: settings.prompt,
      clipChars: settings.clipChars,
      localProviderAuthStorageDir: this.storageDir,
      modelsRuntime: this.piModelsRuntime,
    });
    const contextTokensAfter =
      Math.ceil(summary.length / 4) +
      estimateLocalMessageTokens(plan.messagesToKeep);
    const stats: LocalCompactionStats = {
      trigger,
      context_tokens_before: estimateLocalMessageTokens(messages),
      context_tokens_after: contextTokensAfter,
      context_window: contextWindow,
      messages_count_before: messages.length,
      messages_count_after: 1 + plan.messagesToKeep.length,
    };
    const storeResult = this.store.contextRewrites.rewriteInContext({
      conversationId,
      agentId,
      summary,
      packedSummary: packageLocalSummaryMessage(summary, stats, settings.mode),
      stats,
      remainingMessages: plan.messagesToKeep,
    });
    return {
      numMessagesBefore: storeResult.numMessagesBefore,
      numMessagesAfter: storeResult.numMessagesAfter,
      summary,
      stats,
    };
  }

  private async getOrCompileSystemPrompt(
    conversationId: string,
    agentId: string,
    previousMessageCount = 0,
  ): Promise<LocalCompiledSystemPrompt> {
    // Pending state (live memfs revision / raw system hash) is deliberately not
    // consulted: a turn never rewrites the prefix, it only applies it.
    const existing = this.store.getCompiledSystemPrompt(
      conversationId,
      agentId,
    );
    if (existing) {
      return existing;
    }
    return this.compileAndMaybePersistSystemPrompt(conversationId, agentId, {
      dryRun: false,
      previousMessageCount,
      reason: "conversation_created",
    });
  }

  private async compileAndMaybePersistSystemPrompt(
    conversationId: string,
    agentId: string,
    options: {
      dryRun: boolean;
      previousMessageCount?: number;
      reason: LocalFreezeReason;
    },
  ): Promise<LocalCompiledSystemPrompt> {
    const agent = this.effectiveAgentForConversation(conversationId, agentId);
    const memfsEnabled = this.isLocalMemfsEnabled();
    if (memfsEnabled) {
      await this.ensureLocalMemoryRepo(agentId, [], agent.name);
    }
    const previousMessageCount =
      options.previousMessageCount ??
      this.store.listConversationMessages(conversationId, {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody).length;
    const compiled = stampFreezeMetadata(
      compileLocalSystemPrompt({
        agent,
        conversationId,
        previousMessageCount,
        memoryDir: memfsEnabled ? this.memoryDirForAgent(agentId) : undefined,
        includeMemfs: memfsEnabled,
        includeTopicMarking: shouldAdvertiseTopicMarking(
          agentId,
          conversationId,
        ),
      }),
      { reason: options.reason, agent },
    );
    if (!options.dryRun) {
      this.store.setCompiledSystemPrompt(conversationId, agentId, compiled);
    }
    return compiled;
  }
}
