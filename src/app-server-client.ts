import { isAppServerInfoResponseMessage } from "./types/app-server-info";

// The client's type surface and its socket helpers live in a sibling module;
// the entry re-exports it whole so `./app-server-client` consumers are unchanged.
export * from "./app-server-client-shared";
export type { AppServerInfoResponseMessage } from "./types/app-server-info";
export { isAppServerInfoResponseMessage } from "./types/app-server-info";

import type {
  AppServerChannel,
  AppServerClientOptions,
  AppServerCommandBody,
  AppServerDisconnectHandler,
  AppServerExternalToolCallHandler,
  AppServerMessageHandler,
  AppServerRawCommand,
  AppServerRawRequestOptions,
  AppServerRawResponse,
  AppServerRequestBody,
  AppServerRequestCommand,
  AppServerRequestCommandWithId,
  AppServerRequestOptions,
  AppServerSendCommand,
  AppServerSendHandler,
  AppServerSocketLike,
} from "./app-server-client-shared";
import {
  appServerSocketOptions,
  attachSocketListener,
  DEFAULT_REQUEST_TIMEOUT_MS,
  getGlobalWebSocket,
  type PendingRequest,
  parseProtocolMessage,
  resolveAppServerUrl,
  waitForSocketOpen,
} from "./app-server-client-shared";

import type {
  AbortMessageCommand,
  AbortMessageResponseMessage,
  AppServerInfoResponseMessage,
  CompactionCancelCommand,
  CompactionCancelResponseMessage,
  CompactionCommitCommand,
  CompactionCommitResponseMessage,
  CompactionPrepareCommand,
  CompactionPrepareResponseMessage,
  ConversationCompactCommand,
  ConversationCompactResponseMessage,
  ConversationDeleteCommand,
  ConversationDeleteResponseMessage,
  ConversationListCommand,
  ConversationListResponseMessage,
  ConversationMessagesListCommand,
  ConversationMessagesListResponseMessage,
  ConversationRetrieveCommand,
  ConversationRetrieveResponseMessage,
  CronAddCommand,
  CronAddResponseMessage,
  CronDeleteAllCommand,
  CronDeleteAllResponseMessage,
  CronDeleteCommand,
  CronDeleteResponseMessage,
  CronGetCommand,
  CronGetResponseMessage,
  CronListCommand,
  CronListResponseMessage,
  CronPauseCommand,
  CronPauseResponseMessage,
  CronResumeCommand,
  CronResumeResponseMessage,
  CronRunsCommand,
  CronRunsResponseMessage,
  CronTriggerCommand,
  CronTriggerResponseMessage,
  CronUpdateCommand,
  CronUpdateResponseMessage,
  DreamNoteAppendCommand,
  DreamNoteAppendResponseMessage,
  DreamNoteRemoveCommand,
  DreamNoteRemoveResponseMessage,
  DreamNotesListCommand,
  DreamNotesListResponseMessage,
  DreamRunCommand,
  DreamRunResponseMessage,
  DreamStatusCommand,
  DreamStatusResponseMessage,
  GetDreamSettingsCommand,
  GetDreamSettingsResponseMessage,
  InputAcceptedResponseMessage,
  InputCommand,
  LaunchSubagentCommand,
  LaunchSubagentResponse,
  MonitorStopCommand,
  MonitorStopResponse,
  ResumeQueueCommand,
  ResumeQueueResponseMessage,
  RuntimeExternalToolsUpdateCommand,
  RuntimeExternalToolsUpdateResponseMessage,
  RuntimeStartCommand,
  RuntimeStartResponseMessage,
  SetDreamSettingsCommand,
  SetDreamSettingsResponseMessage,
  SyncCommand,
  SyncResponseMessage,
  UsageAggregateCommand,
  UsageAggregateResponseMessage,
  WsProtocolCommand,
  WsProtocolMessage,
} from "./types/app-server-protocol";

/**
 * Command body accepted by the additive family wrappers: the wrapper adds the
 * discriminant and derives the request id, so callers pass only the payload.
 */
type CommandBody<T extends { type: string }> = Omit<
  T,
  "type" | "request_id"
> & {
  request_id?: string;
};

/** Family-wrapper options; `requestCommand` derives the response predicate. */
type CommandOptions<T extends WsProtocolMessage> = Omit<
  AppServerRequestOptions<T>,
  "predicate"
>;

export type {
  CompactionTopicBlock,
  CompactionTopicReport,
} from "./types/app-server-protocol";

export class AppServerClient {
  readonly socket: AppServerSocketLike;
  /** @deprecated Alias for socket. */
  readonly control: AppServerSocketLike;
  /** @deprecated Alias for socket; no second stream connection is created. */
  readonly stream: AppServerSocketLike;

  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly sendHandlers = new Set<AppServerSendHandler>();
  private readonly disconnectHandlers = new Set<AppServerDisconnectHandler>();
  private explicitlyClosed = false;
  private disconnectNotified = false;
  private nextRequestNumber = 0;

  constructor(options: AppServerClientOptions) {
    const WebSocket = options.WebSocket ?? getGlobalWebSocket();
    if (!WebSocket) {
      throw new Error("No WebSocket implementation available");
    }

    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const socketOptions = appServerSocketOptions(options.authToken);
    this.socket = new WebSocket(
      resolveAppServerUrl(options.url),
      socketOptions,
    );
    this.control = this.socket;
    this.stream = this.socket;

    attachSocketListener(this.socket, "message", (event) => {
      this.handleMessage(event, "control");
    });
    attachSocketListener(this.socket, "close", (event) => {
      this.handleDisconnect("control", event);
    });
  }

  async connect(): Promise<this> {
    await waitForSocketOpen(this.socket);
    return this;
  }

  close(): void {
    if (this.explicitlyClosed) return;
    this.explicitlyClosed = true;
    this.rejectAllPending("App-server client closed");
    this.socket.close();
  }

  onMessage(handler: AppServerMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onSend(handler: AppServerSendHandler): () => void {
    this.sendHandlers.add(handler);
    return () => this.sendHandlers.delete(handler);
  }

  onDisconnect(handler: AppServerDisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  nextRequestId(prefix = "req"): string {
    this.nextRequestNumber += 1;
    return `${prefix}-${this.nextRequestNumber}`;
  }

  send(command: WsProtocolCommand): void {
    this.writeCommand(command);
  }

  private writeCommand(command: AppServerSendCommand): void {
    for (const handler of this.sendHandlers) {
      handler(command);
    }
    this.socket.send(JSON.stringify(command));
  }

  /**
   * Send a forward-compatible protocol command from a compatibility adapter.
   * Prefer the typed wrappers above this boundary for normal product code.
   */
  sendRaw(command: AppServerRawCommand): void {
    this.writeCommand(command);
  }

  /**
   * Request a forward-compatible response without mirroring the full protocol
   * union in a downstream compatibility adapter.
   */
  requestRaw<TResponse extends AppServerRawResponse>(
    command: AppServerRawCommand & { request_id: string },
    options: AppServerRawRequestOptions<TResponse>,
  ): Promise<TResponse> {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.request_id);
        reject(new Error(`Timed out waiting for ${command.request_id}`));
      }, timeoutMs);

      this.pending.set(command.request_id, {
        resolve: (message) => resolve(message as unknown as TResponse),
        reject,
        predicate: options.predicate,
        timeout,
      });

      try {
        this.sendRaw(command);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(command.request_id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  request<TMessage extends WsProtocolMessage = WsProtocolMessage>(
    command: AppServerRequestCommandWithId,
    options?: AppServerRequestOptions<TMessage>,
  ): Promise<TMessage>;

  request<
    TType extends AppServerRequestCommand["type"],
    TMessage extends WsProtocolMessage = WsProtocolMessage,
  >(
    type: TType,
    body?: AppServerRequestBody,
    options?: AppServerRequestOptions<TMessage>,
  ): Promise<TMessage>;

  request<TMessage extends WsProtocolMessage = WsProtocolMessage>(
    commandOrType:
      | AppServerRequestCommandWithId
      | AppServerRequestCommand["type"],
    bodyOrOptions:
      | AppServerRequestBody
      | AppServerRequestOptions<TMessage> = {},
    maybeOptions: AppServerRequestOptions<TMessage> = {},
  ): Promise<TMessage> {
    const isTypeRequest = typeof commandOrType === "string";
    const command = isTypeRequest
      ? ({
          type: commandOrType,
          request_id:
            (bodyOrOptions as { request_id?: string }).request_id ??
            this.nextRequestId(commandOrType),
          ...(bodyOrOptions as object),
        } as AppServerRequestCommandWithId)
      : commandOrType;
    const options = isTypeRequest
      ? maybeOptions
      : (bodyOrOptions as AppServerRequestOptions<TMessage>);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.request_id);
        reject(new Error(`Timed out waiting for ${command.request_id}`));
      }, timeoutMs);

      this.pending.set(command.request_id, {
        resolve: (message) => resolve(message as TMessage),
        reject,
        predicate: options.predicate,
        timeout,
      });

      try {
        this.send(command);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(command.request_id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Typed request for the additive command families (dream, compaction, usage,
   * cron). Derives the request id and the response predicate from the command
   * type, so each wrapper stays a few lines and this file stays under the
   * 1,000-line ceiling while the family grows.
   */
  requestCommand<TMessage extends WsProtocolMessage>(
    command: AppServerCommandBody,
    expectedType: TMessage["type"],
    options: Omit<AppServerRequestOptions<TMessage>, "predicate"> = {},
  ): Promise<TMessage> {
    const requestId = command.request_id ?? this.nextRequestId(command.type);
    return this.request<TMessage>(
      { ...command, request_id: requestId } as AppServerRequestCommandWithId,
      {
        ...options,
        predicate: (message): message is TMessage =>
          message.type === expectedType &&
          (message as { request_id?: string }).request_id === requestId,
      },
    );
  }

  conversationRetrieve(
    command: Omit<ConversationRetrieveCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<ConversationRetrieveResponseMessage>,
      "predicate"
    > = {},
  ): Promise<ConversationRetrieveResponseMessage> {
    return this.requestCommand<ConversationRetrieveResponseMessage>(
      { type: "conversation_retrieve", ...command },
      "conversation_retrieve_response",
      options,
    );
  }

  conversationMessagesList(
    command: Omit<ConversationMessagesListCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<ConversationMessagesListResponseMessage>,
      "predicate"
    > = {},
  ): Promise<ConversationMessagesListResponseMessage> {
    return this.requestCommand<ConversationMessagesListResponseMessage>(
      { type: "conversation_messages_list", ...command },
      "conversation_messages_list_response",
      options,
    );
  }

  info(
    options: Omit<
      AppServerRequestOptions<AppServerInfoResponseMessage>,
      "predicate"
    > = {},
  ): Promise<AppServerInfoResponseMessage> {
    return this.request(
      {
        type: "app_server_info",
        request_id: this.nextRequestId("app-server-info"),
      },
      {
        ...options,
        predicate: isAppServerInfoResponseMessage,
      },
    );
  }

  stopMonitor(
    command: Omit<MonitorStopCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<MonitorStopResponse>,
      "predicate"
    > = {},
  ): Promise<MonitorStopResponse> {
    return this.request(
      {
        type: "monitor_stop",
        ...command,
        request_id: command.request_id ?? this.nextRequestId("monitor-stop"),
      },
      {
        ...options,
        predicate: (message): message is MonitorStopResponse =>
          message.type === "monitor_stop_response" &&
          message.process_id === command.process_id &&
          message.runtime.agent_id === command.runtime.agent_id &&
          message.runtime.conversation_id === command.runtime.conversation_id,
      },
    );
  }

  launchSubagent(
    command: Omit<LaunchSubagentCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<LaunchSubagentResponse>,
      "predicate"
    > = {},
  ): Promise<LaunchSubagentResponse> {
    return this.request(
      {
        ...command,
        type: "launch_subagent",
        request_id: command.request_id ?? this.nextRequestId("launch-subagent"),
      },
      {
        ...options,
        predicate: (message): message is LaunchSubagentResponse =>
          message.type === "launch_subagent_response",
      },
    );
  }

  runtimeStart(
    command: Omit<RuntimeStartCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<RuntimeStartResponseMessage>,
      "predicate"
    > = {},
  ): Promise<RuntimeStartResponseMessage> {
    return this.request(
      {
        type: "runtime_start",
        request_id: command.request_id ?? this.nextRequestId("runtime-start"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is RuntimeStartResponseMessage =>
          message.type === "runtime_start_response",
      },
    );
  }

  runtimeExternalToolsUpdate(
    command: Omit<RuntimeExternalToolsUpdateCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<RuntimeExternalToolsUpdateResponseMessage>,
      "predicate"
    > = {},
  ): Promise<RuntimeExternalToolsUpdateResponseMessage> {
    return this.request(
      {
        type: "runtime_external_tools_update",
        request_id:
          command.request_id ?? this.nextRequestId("runtime-external-tools"),
        ...command,
      },
      {
        ...options,
        predicate: (
          message,
        ): message is RuntimeExternalToolsUpdateResponseMessage =>
          message.type === "runtime_external_tools_update_response",
      },
    );
  }

  sync(
    command: Omit<SyncCommand, "type" | "request_id"> & { request_id?: string },
    options: Omit<
      AppServerRequestOptions<SyncResponseMessage>,
      "predicate"
    > = {},
  ): Promise<SyncResponseMessage> {
    return this.request(
      {
        type: "sync",
        request_id: command.request_id ?? this.nextRequestId("sync"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is SyncResponseMessage =>
          message.type === "sync_response",
      },
    );
  }

  abort(
    command: Omit<AbortMessageCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<AbortMessageResponseMessage>,
      "predicate"
    > = {},
  ): Promise<AbortMessageResponseMessage> {
    return this.request(
      {
        type: "abort_message",
        request_id: command.request_id ?? this.nextRequestId("abort"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is AbortMessageResponseMessage =>
          message.type === "abort_message_response",
      },
    );
  }

  /** Release queue items parked by `abort()` without sending a new message. */
  resumeQueue(
    command: Omit<ResumeQueueCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<ResumeQueueResponseMessage>,
      "predicate"
    > = {},
  ): Promise<ResumeQueueResponseMessage> {
    return this.request(
      {
        type: "resume_queue",
        request_id: command.request_id ?? this.nextRequestId("resume-queue"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is ResumeQueueResponseMessage =>
          message.type === "resume_queue_response",
      },
    );
  }

  conversationList(
    command: Omit<ConversationListCommand, "type" | "request_id"> & {
      request_id?: string;
    } = {},
    options: Omit<
      AppServerRequestOptions<ConversationListResponseMessage>,
      "predicate"
    > = {},
  ): Promise<ConversationListResponseMessage> {
    return this.request(
      {
        type: "conversation_list",
        request_id:
          command.request_id ?? this.nextRequestId("conversation-list"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is ConversationListResponseMessage =>
          message.type === "conversation_list_response",
      },
    );
  }

  conversationDelete(
    command: Omit<ConversationDeleteCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<ConversationDeleteResponseMessage>,
      "predicate"
    > = {},
  ): Promise<ConversationDeleteResponseMessage> {
    return this.request(
      {
        type: "conversation_delete",
        request_id:
          command.request_id ?? this.nextRequestId("conversation-delete"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is ConversationDeleteResponseMessage =>
          message.type === "conversation_delete_response",
      },
    );
  }

  /**
   * Compact a conversation in one shot.
   *
   * F-04: on the local backend this runs the same `prepare → pick → apply` as
   * `/compact`, and the response carries the overview and cut-point table in
   * `topic_report`. This path has no picker, so `body.topic_block` is ignored
   * and the compression rate's default cut is applied; a client that wants to
   * choose the cut point uses the multi-step `compactionPrepare` /
   * `compactionCommit` family (`block_index`), or `execute_command` with
   * `compact <n>`.
   */
  conversationCompact(
    command: Omit<ConversationCompactCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<ConversationCompactResponseMessage>,
      "predicate"
    > = {},
  ): Promise<ConversationCompactResponseMessage> {
    return this.request(
      {
        type: "conversation_compact",
        request_id:
          command.request_id ?? this.nextRequestId("conversation-compact"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is ConversationCompactResponseMessage =>
          message.type === "conversation_compact_response",
      },
    );
  }

  // ── M5-A additive families: cron, dream, compaction, usage ─────────
  // Each wrapper only names the discriminant and its response type;
  // `requestCommand` owns request-id allocation and response correlation.

  cronList(
    command: CommandBody<CronListCommand> = {},
    options: CommandOptions<CronListResponseMessage> = {},
  ): Promise<CronListResponseMessage> {
    return this.requestCommand<CronListResponseMessage>(
      { type: "cron_list", ...command },
      "cron_list_response",
      options,
    );
  }

  cronGet(
    command: CommandBody<CronGetCommand>,
    options: CommandOptions<CronGetResponseMessage> = {},
  ): Promise<CronGetResponseMessage> {
    return this.requestCommand<CronGetResponseMessage>(
      { type: "cron_get", ...command },
      "cron_get_response",
      options,
    );
  }

  cronAdd(
    command: CommandBody<CronAddCommand>,
    options: CommandOptions<CronAddResponseMessage> = {},
  ): Promise<CronAddResponseMessage> {
    return this.requestCommand<CronAddResponseMessage>(
      { type: "cron_add", ...command },
      "cron_add_response",
      options,
    );
  }

  cronUpdate(
    command: CommandBody<CronUpdateCommand>,
    options: CommandOptions<CronUpdateResponseMessage> = {},
  ): Promise<CronUpdateResponseMessage> {
    return this.requestCommand<CronUpdateResponseMessage>(
      { type: "cron_update", ...command },
      "cron_update_response",
      options,
    );
  }

  cronDelete(
    command: CommandBody<CronDeleteCommand>,
    options: CommandOptions<CronDeleteResponseMessage> = {},
  ): Promise<CronDeleteResponseMessage> {
    return this.requestCommand<CronDeleteResponseMessage>(
      { type: "cron_delete", ...command },
      "cron_delete_response",
      options,
    );
  }

  cronDeleteAll(
    command: CommandBody<CronDeleteAllCommand>,
    options: CommandOptions<CronDeleteAllResponseMessage> = {},
  ): Promise<CronDeleteAllResponseMessage> {
    return this.requestCommand<CronDeleteAllResponseMessage>(
      { type: "cron_delete_all", ...command },
      "cron_delete_all_response",
      options,
    );
  }

  cronRuns(
    command: CommandBody<CronRunsCommand>,
    options: CommandOptions<CronRunsResponseMessage> = {},
  ): Promise<CronRunsResponseMessage> {
    return this.requestCommand<CronRunsResponseMessage>(
      { type: "cron_runs", ...command },
      "cron_runs_response",
      options,
    );
  }

  cronTrigger(
    command: CommandBody<CronTriggerCommand>,
    options: CommandOptions<CronTriggerResponseMessage> = {},
  ): Promise<CronTriggerResponseMessage> {
    return this.requestCommand<CronTriggerResponseMessage>(
      { type: "cron_trigger", ...command },
      "cron_trigger_response",
      options,
    );
  }

  cronPause(
    command: CommandBody<CronPauseCommand>,
    options: CommandOptions<CronPauseResponseMessage> = {},
  ): Promise<CronPauseResponseMessage> {
    return this.requestCommand<CronPauseResponseMessage>(
      { type: "cron_pause", ...command },
      "cron_pause_response",
      options,
    );
  }

  cronResume(
    command: CommandBody<CronResumeCommand>,
    options: CommandOptions<CronResumeResponseMessage> = {},
  ): Promise<CronResumeResponseMessage> {
    return this.requestCommand<CronResumeResponseMessage>(
      { type: "cron_resume", ...command },
      "cron_resume_response",
      options,
    );
  }

  dreamStatus(
    command: CommandBody<DreamStatusCommand>,
    options: CommandOptions<DreamStatusResponseMessage> = {},
  ): Promise<DreamStatusResponseMessage> {
    return this.requestCommand<DreamStatusResponseMessage>(
      { type: "dream_status", ...command },
      "dream_status_response",
      options,
    );
  }

  dreamRun(
    command: CommandBody<DreamRunCommand>,
    options: CommandOptions<DreamRunResponseMessage> = {},
  ): Promise<DreamRunResponseMessage> {
    return this.requestCommand<DreamRunResponseMessage>(
      { type: "dream_run", ...command },
      "dream_run_response",
      options,
    );
  }

  getDreamSettings(
    command: CommandBody<GetDreamSettingsCommand>,
    options: CommandOptions<GetDreamSettingsResponseMessage> = {},
  ): Promise<GetDreamSettingsResponseMessage> {
    return this.requestCommand<GetDreamSettingsResponseMessage>(
      { type: "get_dream_settings", ...command },
      "get_dream_settings_response",
      options,
    );
  }

  setDreamSettings(
    command: CommandBody<SetDreamSettingsCommand>,
    options: CommandOptions<SetDreamSettingsResponseMessage> = {},
  ): Promise<SetDreamSettingsResponseMessage> {
    return this.requestCommand<SetDreamSettingsResponseMessage>(
      { type: "set_dream_settings", ...command },
      "set_dream_settings_response",
      options,
    );
  }

  dreamNoteAppend(
    command: CommandBody<DreamNoteAppendCommand>,
    options: CommandOptions<DreamNoteAppendResponseMessage> = {},
  ): Promise<DreamNoteAppendResponseMessage> {
    return this.requestCommand<DreamNoteAppendResponseMessage>(
      { type: "dream_note_append", ...command },
      "dream_note_append_response",
      options,
    );
  }

  dreamNotesList(
    command: CommandBody<DreamNotesListCommand>,
    options: CommandOptions<DreamNotesListResponseMessage> = {},
  ): Promise<DreamNotesListResponseMessage> {
    return this.requestCommand<DreamNotesListResponseMessage>(
      { type: "dream_notes_list", ...command },
      "dream_notes_list_response",
      options,
    );
  }

  dreamNoteRemove(
    command: CommandBody<DreamNoteRemoveCommand>,
    options: CommandOptions<DreamNoteRemoveResponseMessage> = {},
  ): Promise<DreamNoteRemoveResponseMessage> {
    return this.requestCommand<DreamNoteRemoveResponseMessage>(
      { type: "dream_note_remove", ...command },
      "dream_note_remove_response",
      options,
    );
  }

  compactionPrepare(
    command: CommandBody<CompactionPrepareCommand>,
    options: CommandOptions<CompactionPrepareResponseMessage> = {},
  ): Promise<CompactionPrepareResponseMessage> {
    return this.requestCommand<CompactionPrepareResponseMessage>(
      { type: "compaction_prepare", ...command },
      "compaction_prepare_response",
      options,
    );
  }

  compactionCommit(
    command: CommandBody<CompactionCommitCommand>,
    options: CommandOptions<CompactionCommitResponseMessage> = {},
  ): Promise<CompactionCommitResponseMessage> {
    return this.requestCommand<CompactionCommitResponseMessage>(
      { type: "compaction_commit", ...command },
      "compaction_commit_response",
      options,
    );
  }

  compactionCancel(
    command: CommandBody<CompactionCancelCommand>,
    options: CommandOptions<CompactionCancelResponseMessage> = {},
  ): Promise<CompactionCancelResponseMessage> {
    return this.requestCommand<CompactionCancelResponseMessage>(
      { type: "compaction_cancel", ...command },
      "compaction_cancel_response",
      options,
    );
  }

  usageAggregate(
    command: CommandBody<UsageAggregateCommand>,
    options: CommandOptions<UsageAggregateResponseMessage> = {},
  ): Promise<UsageAggregateResponseMessage> {
    return this.requestCommand<UsageAggregateResponseMessage>(
      { type: "usage_aggregate", ...command },
      "usage_aggregate_response",
      options,
    );
  }

  onExternalToolCall(handler: AppServerExternalToolCallHandler): () => void {
    return this.onMessage((message, channel) => {
      if (
        channel !== "control" ||
        message.type !== "external_tool_call_request"
      ) {
        return;
      }

      void Promise.resolve(handler(message))
        .then((result) => {
          this.send({
            type: "external_tool_call_response",
            request_id: message.request_id,
            result,
          });
        })
        .catch((error) => {
          this.send({
            type: "external_tool_call_response",
            request_id: message.request_id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
  }

  /**
   * Submit input to a runtime. Observe progress, tool activity, approvals, and
   * terminal lifecycle events through onMessage().
   */
  input(command: Omit<InputCommand, "type">): void {
    this.send({ type: "input", ...command });
  }

  /**
   * Submit an input and wait only until the listener accepts it into the
   * normal dispatch/queue path. This never waits for turn completion.
   */
  submitInput(
    command: Omit<InputCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<InputAcceptedResponseMessage>,
      "predicate"
    > = {},
  ): Promise<InputAcceptedResponseMessage> {
    return this.request(
      {
        type: "input",
        request_id: command.request_id ?? this.nextRequestId("input"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is InputAcceptedResponseMessage =>
          message.type === "input_accepted",
      },
    );
  }

  private handleMessage(event: unknown, channel: AppServerChannel): void {
    const message = parseProtocolMessage(event);

    for (const handler of this.messageHandlers) {
      handler(message, channel);
    }

    const requestId =
      message && typeof message === "object" && "request_id" in message
        ? (message as { request_id?: unknown }).request_id
        : undefined;
    if (channel !== "control" || typeof requestId !== "string") {
      return;
    }

    const pending = this.pending.get(requestId);
    if (!pending || (pending.predicate && !pending.predicate(message))) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(message);
  }

  private rejectAllPending(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private handleDisconnect(channel: AppServerChannel, event: unknown): void {
    this.rejectAllPending("App-server socket closed");
    if (this.explicitlyClosed || this.disconnectNotified) return;
    this.disconnectNotified = true;
    for (const handler of this.disconnectHandlers) {
      handler({ channel, event });
    }
  }
}

export function createAppServerClient(
  options: AppServerClientOptions,
): AppServerClient {
  return new AppServerClient(options);
}
