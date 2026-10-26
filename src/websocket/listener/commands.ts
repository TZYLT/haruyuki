import type WebSocket from "ws";
import { regenerateConversationDescription } from "@/agent/conversation-description";
import {
  applySetMaxContext,
  formatSetMaxContextResult,
} from "@/agent/max-context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getActiveMemoryDirectory } from "@/agent/memory-runtime";
import { requestCloudReflectionRun } from "@/agent/reflection-runs";
import type { ConversationMessageCompactBody } from "@/backend";
import { getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { hasSelectableTopicBlocks } from "@/backend/local/local-topic-trim";
import { refreshCustomCommands } from "@/cli/commands/custom";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
  formatTopicTrimReceipt,
  parseCompactCommandArgs,
} from "@/cli/helpers/compact-command";
import { buildDoctorMessage } from "@/cli/helpers/doctor-command";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import {
  buildInitMessage,
  gatherInitGitContext,
} from "@/cli/helpers/init-command";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import {
  consumePendingCompactionTrigger,
  runPostCompactionTail,
} from "@/cli/helpers/post-compaction";
import { parseReflectCommandArgs } from "@/cli/helpers/reflect-command";
import { launchReflectionSubagent } from "@/cli/helpers/reflection-launcher";
import { buildModCommandPrompt } from "@/cli/mods/command-runtime";
import { runPreCompactHooks } from "@/hooks";
import type { ModCommand } from "@/mods/types";
import { settingsManager } from "@/settings-manager";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import type {
  ExecuteCommandCommand,
  SlashCommandEndMessage,
  SlashCommandStartMessage,
  StreamDelta,
} from "@/types/protocol_v2";
import { debugLog } from "@/utils/debug";
import { markSecretsReminderRefreshPending } from "./commands/secrets";
import { getConversationWorkingDirectory } from "./cwd";
import {
  ensureListenerAgentModAdapter,
  reloadListenerModAdapter,
} from "./mod-adapter";
import { getListenerModCommand, runListenerModCommand } from "./mod-commands";
import {
  createLifecycleMessageBase,
  emitCanonicalMessageDelta,
  emitDeviceStatusUpdate,
} from "./protocol-outbound";
import {
  beginExternalToolNotificationReset,
  clearConversationRuntimeState,
  emitListenerStatus,
  invalidateExternalToolNotifications,
} from "./runtime";
import {
  ensureSecretsHydratedForAgent,
  invalidateSecretsCacheForAgent,
} from "./secrets-sync";
import { handleIncomingMessage } from "./turn";
import { buildMaybeLaunchReflectionSubagent } from "./turn-events";
import type { ConversationRuntime, StartListenerOptions } from "./types";

export { SUPPORTED_REMOTE_COMMANDS } from "./listener-constants";

/**
 * Handle an `execute_command` message from the web app.
 *
 * Dispatches to the appropriate command handler based on `command_id`.
 * Results flow back as `slash_command_start` / `slash_command_end`
 * stream deltas so they appear in the web UMI message list.
 */
export async function handleExecuteCommand(
  command: ExecuteCommandCommand,
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    onLog?: StartListenerOptions["onLog"];
    connectionId?: string;
    connectionName?: string;
  },
): Promise<void> {
  const scope = {
    agent_id: conversationRuntime.agentId,
    conversation_id: conversationRuntime.conversationId,
  };

  const trimmedArgs = command.args?.trim();
  const input = trimmedArgs
    ? `/${command.command_id} ${trimmedArgs}`
    : `/${command.command_id}`;

  // Emit slash_command_start
  const startDelta: SlashCommandStartMessage = {
    ...createLifecycleMessageBase("slash_command_start"),
    command_id: command.command_id,
    input,
  };
  emitCanonicalMessageDelta(
    socket,
    conversationRuntime,
    startDelta as StreamDelta,
    scope,
  );

  try {
    let output: string;

    switch (command.command_id) {
      case "clear":
        output = await handleClearCommand(socket, conversationRuntime, {
          ...opts,
        });
        break;

      // `clear-messages` is a retained wire id: desktop clients still send it,
      // while the current TUI form is `/messages clear` (the hub mapping in
      // src/cli/commands/hubs.ts rewrites the old name to it). Keep the case so
      // a client that has not followed the rename keeps working.
      case "clear-messages":
        output = await handleClearCommand(socket, conversationRuntime, {
          ...opts,
          resetAllAgentMessages: true,
        });
        break;

      case "doctor": {
        const agentId = conversationRuntime.agentId;
        if (!agentId) throw new Error("Doctor requires an active agent.");
        const doctorMessage = buildDoctorMessage({
          agentId,
          conversationId: conversationRuntime.conversationId,
          memoryDir: getActiveMemoryDirectory(agentId),
          local: getBackend().capabilities.localMemfs,
          symptom: trimmedArgs,
        });
        await handleIncomingMessage(
          {
            type: "message",
            agentId,
            conversationId: conversationRuntime.conversationId,
            messages: [
              {
                type: "message",
                role: "user",
                content: [{ type: "text", text: doctorMessage }],
              },
            ],
          },
          socket,
          conversationRuntime,
          opts.onStatusChange,
          opts.connectionId,
        );
        output = "";
        break;
      }

      case "init":
        output = await handleInitCommand(socket, conversationRuntime, opts);
        break;

      case "compact":
        output = await handleCompactCommand(
          socket,
          conversationRuntime,
          trimmedArgs,
        );
        break;

      case "reload":
        output = await handleReloadCommand(conversationRuntime);
        // Re-advertise so newly (un)registered mod commands reach the client.
        emitDeviceStatusUpdate(socket, conversationRuntime, scope);
        break;

      case "dream":
      case "reflect":
      // `reflection` is a retained wire id as well: the current TUI form is
      // `/reflect` (`/dream` kept its own name). Both dispatch here, so an old
      // client sending `reflection` gets the same behaviour as `/reflect`.
      case "reflection":
        output = await handleReflectCommand(
          socket,
          conversationRuntime,
          trimmedArgs,
        );
        break;

      // `context-limit` is the advertised wire id. `set-max-context` is the
      // pre-rename id and intentionally stays dispatched but unadvertised: the
      // advertised list is the desktop client's allowlist, so keeping the old
      // name out of it stops new clients from rendering the retired name, while
      // the shared case keeps a client that still sends the old id working.
      // `listen-client-protocol.test.ts` pins that `set-max-context` is absent
      // from SUPPORTED_REMOTE_COMMANDS, so it must not be added there without
      // revisiting that client contract. Documented in
      // UNADVERTISED_REMOTE_COMMAND_ALIASES (listener-constants.ts).
      case "context-limit":
      case "set-max-context":
        output = await handleSetMaxContextCommand(
          conversationRuntime,
          trimmedArgs,
        );
        break;

      case "channels":
        output = await handleChannelsCommand(
          socket,
          conversationRuntime,
          trimmedArgs,
          opts,
        );
        break;

      default: {
        if (conversationRuntime.agentId) {
          await ensureListenerAgentModAdapter(
            conversationRuntime.listener,
            conversationRuntime.agentId,
          );
        }
        const modCommand = getListenerModCommand(
          conversationRuntime.listener,
          command.command_id,
          conversationRuntime.agentId,
        );
        if (!modCommand) {
          emitSlashCommandEnd(socket, conversationRuntime, scope, {
            command_id: command.command_id,
            input,
            output: `Unknown command: ${command.command_id}`,
            success: false,
          });
          emitExecuteCommandResponse(socket, command, {
            success: false,
            output: `Unknown command: ${command.command_id}`,
          });
          return;
        }
        await handleModCommand(
          modCommand,
          command,
          input,
          trimmedArgs,
          socket,
          conversationRuntime,
          scope,
          opts,
        );
        return;
      }
    }

    emitSlashCommandEnd(socket, conversationRuntime, scope, {
      command_id: command.command_id,
      input,
      output,
      success: true,
    });
    emitExecuteCommandResponse(socket, command, { success: true, output });
  } catch (error) {
    trackBoundaryError({
      errorType: "listener_execute_command_failed",
      error,
      context: "listener_command_execution",
    });
    const errorMessage = error instanceof Error ? error.message : String(error);
    emitSlashCommandEnd(socket, conversationRuntime, scope, {
      command_id: command.command_id,
      input,
      output: `Failed: ${errorMessage}`,
      success: false,
    });
    emitExecuteCommandResponse(socket, command, {
      success: false,
      output: `Failed: ${errorMessage}`,
    });
  }
}

/**
 * Run a mod-registered slash command and surface its result. Mirrors the TUI
 * mod command path: `output` is shown as command output, `handled` closes
 * silently, and `prompt` injects a user turn through the normal message flow.
 */
async function handleModCommand(
  modCommand: ModCommand,
  command: ExecuteCommandCommand,
  input: string,
  trimmedArgs: string | undefined,
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  scope: { agent_id: string | null; conversation_id: string },
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<void> {
  const result = await runListenerModCommand(conversationRuntime, modCommand, {
    commandId: command.command_id,
    args: trimmedArgs ?? "",
    rawInput: input,
  });

  if (result.type === "prompt") {
    if (!modCommand.showInTranscript) {
      emitSlashCommandEnd(socket, conversationRuntime, scope, {
        command_id: command.command_id,
        input,
        output: `/${modCommand.id} returned a prompt with showInTranscript: false. Hidden mod commands must return output or handled.`,
        success: false,
      });
      return;
    }

    const agentId = conversationRuntime.agentId;
    if (!agentId) {
      emitSlashCommandEnd(socket, conversationRuntime, scope, {
        command_id: command.command_id,
        input,
        output: `No agent available to run /${modCommand.id}.`,
        success: false,
      });
      return;
    }

    emitSlashCommandEnd(socket, conversationRuntime, scope, {
      command_id: command.command_id,
      input,
      output: `Running /${modCommand.id}...`,
      success: true,
    });

    await handleIncomingMessage(
      {
        type: "message",
        agentId,
        conversationId: conversationRuntime.conversationId,
        messages: [
          {
            type: "message",
            role: "user",
            content: [{ type: "text", text: buildModCommandPrompt(result) }],
          },
        ],
      },
      socket,
      conversationRuntime,
      opts.onStatusChange,
      opts.connectionId,
    );
    return;
  }

  emitSlashCommandEnd(socket, conversationRuntime, scope, {
    command_id: command.command_id,
    input,
    output: result.type === "output" ? result.output : "",
    success: result.type === "output" ? (result.success ?? true) : true,
  });
}

export async function handleReloadCommand(
  conversationRuntime: ConversationRuntime,
): Promise<string> {
  const { listener } = conversationRuntime;
  settingsManager.clearCaches();
  await settingsManager.loadProjectSettings();
  await settingsManager.loadLocalProjectSettings();

  try {
    refreshCustomCommands();
  } catch (error) {
    debugLog(
      "commands",
      "refreshCustomCommands failed during /reload:",
      error instanceof Error ? error.message : String(error),
    );
  }

  await reloadListenerModAdapter(listener, conversationRuntime.agentId);

  if (conversationRuntime.agentId) {
    invalidateSecretsCacheForAgent(listener, conversationRuntime.agentId);
    markSecretsReminderRefreshPending(listener, conversationRuntime.agentId);
    await ensureSecretsHydratedForAgent(listener, conversationRuntime.agentId);
  }

  return "Reloaded settings, local mods, and agent secrets";
}

function emitSlashCommandEnd(
  socket: WebSocket,
  runtime: ConversationRuntime,
  scope: { agent_id: string | null; conversation_id: string },
  fields: Pick<
    SlashCommandEndMessage,
    "command_id" | "input" | "output" | "success"
  >,
): void {
  const endDelta: SlashCommandEndMessage = {
    ...createLifecycleMessageBase("slash_command_end"),
    ...fields,
  };
  emitCanonicalMessageDelta(socket, runtime, endDelta as StreamDelta, scope);
}

function emitExecuteCommandResponse(
  socket: WebSocket,
  command: ExecuteCommandCommand,
  result: { success: boolean; output: string },
): void {
  socket.send(
    JSON.stringify({
      type: "execute_command_response",
      request_id: command.request_id,
      ...result,
    }),
  );
}

/**
 * `/compact` has no interactive channel here: a local conversation must name the
 * block to keep, and the block list comes from `/topic list`. The cloud backend keeps
 * its mode-based behaviour unchanged.
 */
async function compactLocalFromListener(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  agentId: string,
  backend: LocalBackend,
  request: { kind: "auto" } | { kind: "block"; index: number },
): Promise<string> {
  const conversationId = conversationRuntime.conversationId;
  const list = backend.listTopics(conversationId, agentId);
  if (request.kind === "block" && request.index > list.blocks.length) {
    const count = `${list.blocks.length} block${list.blocks.length === 1 ? "" : "s"}`;
    throw new Error(
      `There is no topic block ${request.index}: this context has ${count}. Run /topic list to list them, or /compact with no number to compress by the rate.`,
    );
  }
  // There is no interactive channel here, so a *choice* needs a number from
  // /topic list. When there is no choice to make — fewer than two blocks, exactly the
  // state bare `/compact` finds on the TUI — the compression rate decides, which is
  // the same decision the TUI would have made without asking (H-2).
  if (request.kind === "auto" && hasSelectableTopicBlocks(list)) {
    throw new Error(
      "Choosing a cut point needs a terminal. Run /topic list to list the blocks, then /compact <n> with the block to keep.",
    );
  }

  const outcome = await backend.trimConversationToTopic({
    conversationId,
    agentId,
    pick:
      request.kind === "block"
        ? { kind: "topic", index: request.index }
        : { kind: "ratio_suggestion" },
  });
  if (!outcome.executed) return formatTopicTrimReceipt(outcome);

  // F-03: this compaction is the trigger. Consume the pending flag so the
  // turn-end check does not launch a second reflection for it.
  consumePendingCompactionTrigger({
    reminderState: conversationRuntime.reminderState,
    contextTracker: conversationRuntime.contextTracker,
  });
  runPostCompactionTail({
    reminderState: conversationRuntime.reminderState,
    reflect: () => {
      const reflectionSettings = getReflectionSettings(
        agentId,
        getConversationWorkingDirectory(
          conversationRuntime.listener,
          agentId,
          conversationId,
        ),
      );
      if (
        !reflectionSettings.onCompaction ||
        !settingsManager.isMemfsEnabled(agentId)
      ) {
        return;
      }
      void buildMaybeLaunchReflectionSubagent({
        runtime: conversationRuntime,
        socket,
        agentId,
        conversationId,
        reflectionSettings,
      })("compaction", {
        timeoutMinutes: reflectionSettings.timeoutMinutes,
      });
    },
    regenerateDescription: () => {
      void regenerateConversationDescription(conversationId);
    },
  });
  return formatTopicTrimReceipt(outcome);
}

/** /compact — Summarize conversation history through the active Backend. */
async function handleCompactCommand(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  if (!agentId) {
    throw new Error("No agent ID available for /compact command");
  }

  const parsed = parseCompactCommandArgs(
    args?.trim() ? args.trim().split(/\s+/) : [],
  );
  if (parsed.kind === "help") return COMPACT_COMMAND_USAGE;
  if (parsed.kind === "invalid") {
    throw new Error(`${parsed.message}\n\n${COMPACT_COMMAND_USAGE}`);
  }

  const backend = getBackend();
  const local = backend instanceof LocalBackend;
  if (local) {
    if (parsed.kind === "mode") throw new Error(COMPACT_MODE_LOCAL_UNSUPPORTED);
  } else if (parsed.kind === "block") {
    throw new Error(
      "Picking a context cut point by number requires the local backend. Run /compact help.",
    );
  }

  const preCompactResult = await runPreCompactHooks(
    undefined,
    undefined,
    agentId,
    conversationRuntime.conversationId,
  );
  if (preCompactResult.blocked) {
    const feedback = preCompactResult.feedback.join("\n") || "Blocked by hook";
    throw new Error(`Compact blocked: ${feedback}`);
  }

  if (local) {
    return compactLocalFromListener(
      socket,
      conversationRuntime,
      agentId,
      backend as LocalBackend,
      parsed.kind === "block" ? parsed : { kind: "auto" },
    );
  }

  const modeArg = parsed.kind === "mode" ? parsed.mode : undefined;
  const modeDisplay = modeArg ? ` (mode: ${modeArg})` : "";

  try {
    let compactParams: ConversationMessageCompactBody | undefined;
    if (modeArg) {
      compactParams = {
        compaction_settings: {
          mode: modeArg,
        },
      } as ConversationMessageCompactBody;
    }

    const compactBody =
      conversationRuntime.conversationId === "default"
        ? ({
            agent_id: agentId,
            ...(compactParams ?? {}),
          } as ConversationMessageCompactBody)
        : compactParams;

    const result = await backend.compactConversationMessages(
      conversationRuntime.conversationId,
      compactBody,
    );
    // The same tail the TUI runs: reminders first, reflection best-effort, then a
    // fresh description. A cloud failure keeps its classified message (M-2).
    // F-03: consume the pending flag first — this compaction is the trigger.
    consumePendingCompactionTrigger({
      reminderState: conversationRuntime.reminderState,
      contextTracker: conversationRuntime.contextTracker,
    });
    runPostCompactionTail({
      reminderState: conversationRuntime.reminderState,
      reflect: () => {
        const reflectionSettings = getReflectionSettings(
          agentId,
          getConversationWorkingDirectory(
            conversationRuntime.listener,
            agentId,
            conversationRuntime.conversationId,
          ),
        );
        if (
          !reflectionSettings.onCompaction ||
          !settingsManager.isMemfsEnabled(agentId)
        ) {
          return;
        }
        void buildMaybeLaunchReflectionSubagent({
          runtime: conversationRuntime,
          socket,
          agentId,
          conversationId: conversationRuntime.conversationId,
          reflectionSettings,
        })("compaction", {
          timeoutMinutes: reflectionSettings.timeoutMinutes,
        });
      },
      regenerateDescription: () => {
        void regenerateConversationDescription(
          conversationRuntime.conversationId,
        );
      },
    });

    return [
      `Compaction completed${modeDisplay}. Message buffer length reduced from ${result.num_messages_before} to ${result.num_messages_after}.`,
      "",
      `Summary: ${result.summary}`,
    ].join("\n");
  } catch (error) {
    const apiError = error as {
      status?: number;
      error?: { detail?: string };
    };
    const detail = apiError?.error?.detail;
    if (
      apiError?.status === 400 &&
      detail?.includes("Summarization failed to reduce the number of messages")
    ) {
      return "Compaction run, but the number of messages is the same";
    }

    // This catch only ever sees cloud failures (the local branch returned above),
    // so it keeps the cloud taxonomy — quota, rate limit, Cloudflare, run links —
    // instead of the local planner's two-case translation (M-2).
    throw new Error(formatErrorDetails(error, agentId));
  }
}

/**
 * /clear — Reset agent messages and create a new conversation.
 *
 * Mirrors the CLI /clear logic:
 * 1. Reset agent messages (only for "default" conversation)
 * 2. Create a new conversation
 * 3. Clear the conversation runtime state
 *
 * Returns a human-readable success message.
 */
async function handleClearCommand(
  _socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
    /** Whether to reset the API agent's complete message history. */
    resetAllAgentMessages?: boolean;
  },
): Promise<string> {
  const backend = getBackend();
  const agentId = conversationRuntime.agentId;

  if (!agentId) {
    throw new Error("No agent ID available for /clear command");
  }

  if (opts.resetAllAgentMessages && backend.capabilities.localModelCatalog) {
    throw new Error("/messages clear is not supported by the local backend.");
  }

  // Hold detached results until this reset either commits or fails. A
  // successful clear changes their epoch; a failed clear releases them.
  const finishNotificationReset =
    beginExternalToolNotificationReset(conversationRuntime);
  try {
    // /messages clear always resets the API agent's message history.
    // /clear only resets when leaving the default API conversation.
    // Local/headless backends model /clear by switching to a fresh conversation.
    if (
      !backend.capabilities.localModelCatalog &&
      (opts.resetAllAgentMessages ||
        conversationRuntime.conversationId === "default")
    ) {
      const { getClient } = await import("@/backend/api/client");
      const client = await getClient();
      await client.agents.messages.reset(agentId, {
        add_default_initial_messages: false,
      });
      // The old message history is gone even if creating its replacement fails.
      invalidateExternalToolNotifications(conversationRuntime);
    }

    const conversation = await backend.createConversation({
      agent_id: agentId,
    });

    // Clear runtime state for the current conversation
    clearConversationRuntimeState(conversationRuntime);

    // Update the runtime's conversation ID to the new one
    conversationRuntime.conversationId = conversation.id;

    // Emit updated status so the web app picks up the new conversation
    emitListenerStatus(
      conversationRuntime.listener,
      opts.onStatusChange,
      opts.connectionId,
    );

    return opts.resetAllAgentMessages
      ? "All agent messages reset"
      : "Agent's in-context messages cleared & moved to conversation history";
  } finally {
    finishNotificationReset();
  }
}

/**
 * /memory init — Initialize (or re-init) agent memory.
 *
 * Builds the init system-reminder message (same as the CLI /memory init)
 * and feeds it through `handleIncomingMessage` so the agent runs a full
 * turn executing the `initializing-memory` skill.
 */
async function handleInitCommand(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const agentId = conversationRuntime.agentId;

  if (!agentId) {
    throw new Error("No agent ID available for /memory init command");
  }

  const { context: gitContext } = gatherInitGitContext();
  const memoryDir = settingsManager.isMemfsEnabled(agentId)
    ? getScopedMemoryFilesystemRoot(agentId)
    : undefined;

  const initMessage = buildInitMessage({ gitContext, memoryDir });

  // Feed the init prompt as a user message through the normal turn pipeline.
  // This triggers a full agent turn whose deltas stream back to the web UI.
  await handleIncomingMessage(
    {
      type: "message",
      agentId,
      conversationId: conversationRuntime.conversationId,
      messages: [
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: initMessage }],
        },
      ],
    },
    socket,
    conversationRuntime,
    opts.onStatusChange,
    opts.connectionId,
  );

  return "Memory initialization completed";
}

/** /context limit — Set or reset the active scope's max context window. */
async function handleSetMaxContextCommand(
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  if (!agentId) {
    throw new Error("No agent ID available for /context limit command");
  }

  const result = await applySetMaxContext({
    agentId,
    conversationId: conversationRuntime.conversationId,
    args,
  });
  return formatSetMaxContextResult(result);
}

/**
 * /channels — Manage external channel integrations.
 *
 * Subcommands (via WS), generic across all supported channels:
 *   /channels <channel> pair <code>    — Approve pairing + bind chat to this agent/conversation
 *   /channels <channel> enable --chat-id <id> — Bind a known chat to this agent/conversation
 *   /channels <channel> disable        — Unbind this agent/conversation
 *   /channels status                   — Show channel status
 */
async function handleChannelsCommand(
  _socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
  _opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  const conversationId = conversationRuntime.conversationId;
  if (!agentId) {
    return "Error: No agent ID in current context.";
  }
  const serviceCommandHandler =
    conversationRuntime.listener.serviceCommandHandler;
  if (!serviceCommandHandler) {
    return "Error: ChannelGateway service is not ready.";
  }
  const response = await serviceCommandHandler({
    kind: "slash_command",
    command: "channels",
    args,
    runtime: { agent_id: agentId, conversation_id: conversationId },
  });
  return response.kind === "text"
    ? response.text
    : "Error: ChannelGateway returned an invalid slash-command response.";
}

async function handleReflectCommand(
  _socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  args = "",
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  if (!agentId) throw new Error("No agent ID available for reflection.");
  const conversationId = conversationRuntime.conversationId;
  const output = await requestCloudReflectionRun(
    { agentId, conversationId },
    args,
  );
  if (output !== null) return output;
  // F-03: one parameter, always this conversation. Retired flags throw with the
  // current usage before any launch work happens.
  const parsed = parseReflectCommandArgs(`/reflect ${args}`);
  const reflectionSettings = getReflectionSettings(
    agentId,
    getConversationWorkingDirectory(
      conversationRuntime.listener,
      agentId,
      conversationId,
    ),
  );
  const result = await launchReflectionSubagent({
    agentId,
    conversationId,
    memfsEnabled: settingsManager.isMemfsEnabled(agentId),
    triggerSource: "manual",
    instruction: parsed.instruction,
    reflectionSettings: { timeoutMinutes: reflectionSettings.timeoutMinutes },
  });
  if (result.launched) {
    return "Started a reflection pass for this conversation.";
  }
  switch (result.reason) {
    case "memfs_disabled":
      return "Reflection needs the memory filesystem to be enabled for this agent.";
    case "lock_busy":
    case "already_active":
      return "A reflection agent is already running for this conversation.";
    case "retry_backoff":
      return "Reflection is backing off after a recent failure. Try again later.";
    case "configuration_error":
      return "Reflection is paused because of a configuration error.";
    case "fork_failed":
      return "Could not create the reflection session.";
    default:
      return `Failed to start reflection: ${result.reason}`;
  }
}
