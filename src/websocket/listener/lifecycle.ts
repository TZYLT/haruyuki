import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import WebSocket from "ws";
import {
  setSchedulerTaskRunner,
  startScheduler as startCronScheduler,
} from "@/cron/scheduler";
import { createSharedReminderState } from "@/reminders/state";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import {
  getListenerTelemetrySurface,
  getTerminalTelemetrySurface,
  telemetry,
} from "@/telemetry";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import { loadTools } from "@/tools/manager";
import type { RuntimeScope } from "@/types/protocol_v2";
import { isDebugEnabled } from "@/utils/debug";
import { sealStartupLogs } from "@/utils/startup-log-boundary";
import {
  rejectPendingApprovalResolvers,
  replayPendingApprovalRequestsToConnection,
} from "./approval";
import {
  getOrCreateProcessTransport,
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import {
  cleanupListenerConnection,
  closeListenerRuntimeConnections,
  createConnectionTurnProcessor,
} from "./connection-lifecycle";
import { emitInitialConnectionState as emitInitialState } from "./connection-state-sync";
import { LISTENER_PONG_TIMEOUT_MS } from "./constants";
import {
  handleAbortMessageInput,
  handleApprovalResponseInput,
  handleChangeDeviceStateInput,
} from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createListenerCronRunner } from "./cron-host";
import { loadPersistedCwdMap } from "./cwd";
import {
  createExternalToolNotificationState,
  installExternalToolBridge,
  rejectPendingExternalToolCalls,
} from "./external-tools";
import { createFileCommandSession } from "./file-commands";
import { startConnectionHeartbeat } from "./heartbeat";
import { createListenerMessageHandler } from "./message-router";
import {
  disposeListenerModAdapter,
  reloadListenerModAdapter,
} from "./mod-adapter";
import { loadPersistedPermissionModeMap } from "./permission-mode";
import {
  clearProcessServices,
  installProcessEventRouting,
  invalidateProcessServices,
  waitForProcessServicesSlot,
} from "./process-services";
import { scheduleQueuePump } from "./queue";
import {
  clearConversationRuntimeState,
  getActiveRuntime,
  safeEmitWsEvent,
  setActiveRuntime,
} from "./runtime";
import { notifyStreamObserversRuntimeStopped } from "./stream-observers";
import { replaySyncStateForRuntime } from "./sync-replay";
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
  LocalListenerTransport,
} from "./transport";
import type {
  IncomingMessage,
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";
import { clearListenerWarmState } from "./warmup";
import { stopAllWorktreeWatchers } from "./worktree-watcher";

function trackListenerError(
  errorType: string,
  error: unknown,
  context: string,
): void {
  trackBoundaryError({
    errorType,
    error,
    context,
  });
}

export function safeSocketSend(
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    socket.send(serialized);
    return true;
  } catch (error) {
    trackListenerError(errorType, error, context);
    if (isDebugEnabled()) {
      console.error(`[Listen] ${context} send failed:`, error);
    }
    return false;
  }
}

function safeTransportSend(
  transport: ListenerTransport,
  payload: unknown,
  errorType: string,
  context: string,
): boolean {
  if (!isListenerTransportOpen(transport)) {
    return false;
  }

  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    transport.send(serialized);
    return true;
  } catch (error) {
    trackListenerError(errorType, error, context);
    if (isDebugEnabled()) {
      console.error(`[Listen] ${context} send failed:`, error);
    }
    return false;
  }
}

export function runDetachedListenerTask(
  commandName: string,
  task: () => Promise<void>,
): void {
  void task().catch((error) => {
    trackListenerError(
      `listener_${commandName}_failed`,
      error,
      `listener_${commandName}`,
    );
    if (isDebugEnabled())
      console.error(`[Listen] ${commandName} failed:`, error);
  });
}
function getParsedRuntimeScope(
  parsed: unknown,
): RuntimeScope<string | null> | null {
  if (!parsed || typeof parsed !== "object" || !("runtime" in parsed)) {
    return null;
  }

  const runtime = (
    parsed as {
      runtime?: { agent_id?: unknown; conversation_id?: unknown };
    }
  ).runtime;
  if (
    !runtime ||
    (runtime.agent_id !== null && typeof runtime.agent_id !== "string")
  )
    return null;

  return {
    agent_id: runtime.agent_id,
    conversation_id:
      typeof runtime.conversation_id === "string"
        ? runtime.conversation_id
        : "default",
  };
}

function stampInboundUserMessageOtids(
  incoming: IncomingMessage,
): IncomingMessage {
  let didChange = false;
  const messages = incoming.messages.map((payload) => {
    if (!("content" in payload) || payload.otid) {
      return payload;
    }

    didChange = true;
    return {
      ...payload,
      otid:
        "client_message_id" in payload &&
        typeof payload.client_message_id === "string"
          ? payload.client_message_id
          : crypto.randomUUID(),
    } satisfies MessageCreate & { client_message_id?: string };
  });

  if (!didChange) {
    return incoming;
  }

  return {
    ...incoming,
    messages,
  };
}

export function createRuntime(): ListenerRuntime {
  const bootWorkingDirectory = getCurrentWorkingDirectory();
  return {
    socket: null,
    transport: null,
    heartbeatInterval: null,
    lastPongAt: null,
    intentionallyClosed: false,
    sessionId: `listen-${crypto.randomUUID()}`,
    nextConnectionOrdinal: 0,
    connections: new Map(),
    connectionIdsByRuntimeKey: new Map(),
    processTransport: null,
    processServicesStarted: false,
    processServicesGeneration: 0,
    ...createExternalToolNotificationState(),
    processServicesReady: null,
    processServicesReadyGeneration: null,
    serviceCommandHandler: null,
    serviceCommandTypes: new Set(),
    eventSeqCounter: 0,
    queueEmitScheduled: false,
    pendingQueueEmitScope: undefined,
    onWsEvent: undefined,
    reminderState: createSharedReminderState(),
    bootWorkingDirectory,
    workingDirectoryByConversation: loadPersistedCwdMap(),
    worktreeWatcherByConversation: new Map(),
    permissionModeByConversation: loadPersistedPermissionModeMap(),
    skillSourcesByConversation: new Map(),
    reminderStateByConversation: new Map(),
    contextTrackerByConversation: new Map(),
    connectionId: null,
    connectionName: null,
    conversationRuntimes: new Map(),
    memfsSyncedAgents: new Map(),
    secretsHydrationByAgent: new Map(),
    secretsHydrationFreshnessByAgent: new Map(),
    secretsDirtyAgents: new Set(),
    pendingExternalToolCalls: new Map(),
    agentMetadataByAgent: new Map(),
    lastEmittedStatus: null,
  };
}

export function stopRuntime(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  notifyStreamObserversRuntimeStopped(runtime);
  disposeListenerModAdapter(runtime);
  rejectPendingExternalToolCalls(runtime, "Listener runtime stopped");
  runtime.intentionallyClosed = true;
  invalidateProcessServices(runtime);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    rejectPendingApprovalResolvers(
      conversationRuntime,
      "Listener runtime stopped",
    );
    clearConversationRuntimeState(conversationRuntime);
    if (conversationRuntime.queueRuntime) {
      conversationRuntime.queuedMessagesByItemId.clear();
      conversationRuntime.queueRuntime.clear("shutdown");
    }
  }
  runtime.conversationRuntimes.clear();
  closeListenerRuntimeConnections(runtime, suppressCallbacks);
  runtime.processServicesReady = null;
  runtime.processServicesReadyGeneration = null;
  clearListenerWarmState(runtime);
  runtime.reminderStateByConversation.clear();
  runtime.skillSourcesByConversation.clear();
  runtime.contextTrackerByConversation.clear();
  stopAllWorktreeWatchers(runtime);
}

export async function startConnectedListenerRuntime(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  opts: Pick<
    StartListenerOptions,
    "connectionId" | "onConnected" | "onStatusChange" | "onWsEvent"
  >,
  processQueuedTurn: ProcessQueuedTurn,
  options: {
    startHeartbeat?: boolean;
    startCronScheduler?: boolean;
    startProcessServices?: boolean;
    emitInitialState?: boolean;
  } = {},
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) return;
  sealStartupLogs();
  installExternalToolBridge(runtime);
  // Opt out when another process already holds the cron scheduler lease.
  // HARUYUKI_DISABLE_CRON_SCHEDULER=1 suppresses recurring lease-held messages.
  const shouldStartCronScheduler =
    options.startCronScheduler !== false &&
    process.env.HARUYUKI_DISABLE_CRON_SCHEDULER !== "1";

  markListenerConnectionInitialized(runtime, opts.connectionId);
  safeEmitWsEvent("recv", "lifecycle", {
    type:
      getListenerTransportKind(transport) === "websocket"
        ? "_ws_open"
        : "_local_open",
  });
  await opts.onConnected(opts.connectionId);

  await emitInitialState(runtime, transport, opts.connectionId, options);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    replayPendingApprovalRequestsToConnection(
      conversationRuntime,
      opts.connectionId,
    );
  }

  if (options.startHeartbeat !== false) {
    startConnectionHeartbeat(
      runtime,
      transport,
      () => {
        trackListenerError(
          "listener_pong_timeout",
          new Error(
            `No relay pong within ${LISTENER_PONG_TIMEOUT_MS}ms; terminating half-open socket to force reconnect`,
          ),
          "listener_heartbeat",
        );
        runtime.socket?.terminate();
      },
      (heartbeatTransport) => {
        return safeTransportSend(
          heartbeatTransport,
          { type: "ping" },
          "listener_ping_send_failed",
          "listener_heartbeat",
        );
      },
    );
  }

  if (options.startProcessServices === false) return;

  const processTransport = getOrCreateProcessTransport(runtime);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    if (conversationRuntime.queueRuntime?.isEmpty === false) {
      scheduleQueuePump(
        conversationRuntime,
        processTransport,
        opts as StartListenerOptions,
        processQueuedTurn,
      );
    }
  }

  if (runtime.processServicesStarted) return;
  if (!(await waitForProcessServicesSlot(runtime, opts.connectionId))) return;

  const processServicesGeneration = runtime.processServicesGeneration + 1;
  runtime.processServicesGeneration = processServicesGeneration;
  const processServicesReady = (async () => {
    const processTransport = getOrCreateProcessTransport(runtime);

    installProcessEventRouting({
      runtime,
      processTransport,
      opts: opts as StartListenerOptions,
      processQueuedTurn,
    });

    if (shouldStartCronScheduler) {
      // F-05: the host provides the runner, the adapter provides the tick.
      setSchedulerTaskRunner(
        createListenerCronRunner({
          transport: processTransport,
          opts: opts as StartListenerOptions,
          processQueuedTurn,
        }),
      );
      startCronScheduler(
        processTransport,
        opts as StartListenerOptions,
        processQueuedTurn,
      );
    }

    if (runtime.processServicesGeneration === processServicesGeneration) {
      runtime.processServicesStarted = true;
    }
  })();
  runtime.processServicesReady = processServicesReady;
  runtime.processServicesReadyGeneration = processServicesGeneration;
  try {
    await processServicesReady;
  } catch (error) {
    if (runtime.processServicesGeneration !== processServicesGeneration) return;
    clearProcessServices(runtime);
    throw error;
  } finally {
    if (runtime.processServicesReady === processServicesReady) {
      runtime.processServicesReady = null;
      runtime.processServicesReadyGeneration = null;
    }
  }
}

/**
 * Attach an already-open, locally accepted websocket to a listener runtime.
 *
 * This helper does not reconnect on close. It is intended for local
 * app-server transports where the HTTP server keeps running and the next
 * client connection creates a fresh runtime.
 */

export async function attachOpenListenerSocket(
  runtime: ListenerRuntime,
  socket: WebSocket,
  opts: StartListenerOptions,
  options: {
    startHeartbeat?: boolean;
    startCronScheduler?: boolean;
    startProcessServices?: boolean;
    startupReady?: Promise<void>;
  } = {},
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    return;
  }

  const connection = openListenerConnection({
    runtime,
    connectionId: opts.connectionId,
    writer: socket,
    options: opts,
  });
  const fileCommandSession = createFileCommandSession({
    socket,
    safeSocketSend,
    runDetachedListenerTask,
  });

  installExternalToolBridge(runtime);
  const transport: ListenerTransport = socket;
  const processQueuedTurn = createConnectionTurnProcessor(runtime);

  const handleMessage = createListenerMessageHandler({
    runtime,
    socket,
    connectionId: opts.connectionId,
    opts,
    processQueuedTurn,
    fileCommandSession,
    getParsedRuntimeScope,
    replaySyncStateForRuntime,
    getOrCreateScopedRuntime,
    handleApprovalResponseInput,
    handleChangeDeviceStateInput,
    handleAbortMessageInput,
    stampInboundUserMessageOtids,
    safeSocketSend,
    runDetachedListenerTask,
    trackListenerError,
  });
  socket.on("message", (data: WebSocket.RawData) => {
    void (async () => {
      await options.startupReady;
      if (
        connection.cancellation.signal.aborted ||
        runtime.connections.get(opts.connectionId) !== connection
      ) {
        return;
      }
      await handleMessage(data);
    })().catch((error) => {
      trackListenerError(
        "listener_message_handler_failed",
        error,
        "listener_message_handler",
      );
      opts.onError(error instanceof Error ? error : new Error(String(error)));
    });
  });

  socket.on("close", (code: number, reason: Buffer) => {
    if (
      runtime !== getActiveRuntime() ||
      runtime.connections.get(opts.connectionId) !== connection
    ) {
      return;
    }

    const reasonText = reason.toString();
    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_close",
      code,
      reason: reasonText,
    });
    fileCommandSession.dispose();
    cleanupListenerConnection(runtime, opts.connectionId);
    opts.onDisconnected();
  });

  socket.on("error", (error: Error) => {
    trackListenerError("listener_websocket_error", error, "listener_socket");
    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_error",
      message: error.message,
    });
    if (isDebugEnabled()) {
      console.error("[Listen] WebSocket error:", error);
    }
  });

  await options.startupReady;
  if (
    connection.cancellation.signal.aborted ||
    runtime.connections.get(opts.connectionId) !== connection
  ) {
    return;
  }

  await startConnectedListenerRuntime(
    runtime,
    transport,
    opts,
    processQueuedTurn,
    {
      startHeartbeat: options.startHeartbeat ?? false,
      startCronScheduler: options.startCronScheduler ?? true,
      startProcessServices: options.startProcessServices ?? true,
      emitInitialState: false,
    },
  );
}

export interface StartLocalChannelListenerOptions {
  connectionId: string;
  deviceId: string;
  connectionName: string;
  onConnected: (connectionId: string) => void;
  onError: (error: Error) => void;
  onStatusChange?: StartListenerOptions["onStatusChange"];
  onLog?: StartListenerOptions["onLog"];
  onWsEvent?: StartListenerOptions["onWsEvent"];
  /**
   * F-05 short-lived host (C-5): `false` keeps this runtime from claiming the
   * scheduler lease or starting a tick loop. It still builds the conversation
   * runtimes the cron runner needs.
   */
  startCronScheduler?: boolean;
  /** Skip process services (cron tick does not need subagent/message routing). */
  startProcessServices?: boolean;
}

/** What a caller needs to drive one scheduled run on this runtime. */
export interface LocalChannelListenerHandle {
  runtime: ListenerRuntime;
  transport: ListenerTransport;
  options: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
}

/**
 * Start a listener runtime for local channel adapters without environment
 * registration or a remote WebSocket server.
 *
 * Returns nothing; use {@link startLocalChannelListenerWithHandle} when the
 * caller needs the transport/queue processor (F-05's short-lived host does).
 */
export async function startLocalChannelListener(
  opts: StartLocalChannelListenerOptions,
): Promise<void> {
  await startLocalChannelListenerWithHandle(opts);
}

/**
 * Same start-up, but hands back the pieces a caller needs to drive one run, or
 * `null` when it failed (`opts.onError` already fired).
 */
export async function startLocalChannelListenerWithHandle(
  opts: StartLocalChannelListenerOptions,
): Promise<LocalChannelListenerHandle | null> {
  const existingRuntime = getActiveRuntime();
  if (existingRuntime) {
    stopRuntime(existingRuntime, true);
  }

  const runtime = createRuntime();
  runtime.onWsEvent = opts.onWsEvent;
  runtime.connectionId = opts.connectionId;
  runtime.connectionName = opts.connectionName;
  setActiveRuntime(runtime);
  telemetry.setSurface(getListenerTelemetrySurface());
  telemetry.init();

  try {
    await reloadListenerModAdapter(runtime);
    await loadTools();
    const transport = new LocalListenerTransport();
    const connectionOptions: StartListenerOptions = {
      ...opts,
      wsUrl: "local://listener",
      onDisconnected: () => {},
    };
    openListenerConnection({
      runtime,
      connectionId: opts.connectionId,
      writer: transport,
      options: connectionOptions,
    });
    const processQueuedTurn = createConnectionTurnProcessor(runtime);

    await startConnectedListenerRuntime(
      runtime,
      transport,
      opts,
      processQueuedTurn,
      {
        startHeartbeat: false,
        startCronScheduler: opts.startCronScheduler ?? true,
        startProcessServices: opts.startProcessServices ?? true,
      },
    );
    return {
      runtime,
      transport,
      options: connectionOptions,
      processQueuedTurn,
    };
  } catch (error) {
    stopRuntime(runtime, true);
    if (getActiveRuntime() === runtime) {
      setActiveRuntime(null);
    }
    opts.onError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Check if listener is currently active.
 */
export function isListenerActive(): boolean {
  const runtime = getActiveRuntime();
  return runtime !== null && runtime.transport !== null;
}

/**
 * Stop the active listener connection.
 */
export function stopListenerClient(): void {
  const runtime = getActiveRuntime();
  if (!runtime) {
    return;
  }
  setActiveRuntime(null);
  telemetry.setSurface(getTerminalTelemetrySurface(!process.stdin.isTTY));
  stopRuntime(runtime, true);
}
