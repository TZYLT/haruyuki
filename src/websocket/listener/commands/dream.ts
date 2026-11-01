import type WebSocket from "ws";
import { appendNote, listNotes, removeNote } from "@/agent/dream/dream-notes";
import {
  type StartDreamRunResult,
  startDreamRun,
} from "@/cli/helpers/dream-launcher";
import {
  type ResolvedDreamSettings,
  readDreamSettings,
  updateDreamSettings,
} from "@/dream-settings";
import type {
  DreamNoteAppendCommand,
  DreamNoteAppendResponseMessage,
  DreamNoteRemoveCommand,
  DreamNoteRemoveResponseMessage,
  DreamNotesListCommand,
  DreamNotesListResponseMessage,
  DreamRunCommand,
  DreamRunResponseMessage,
  DreamSettingsSnapshot,
  DreamStatusCommand,
  DreamStatusResponseMessage,
  DreamStatusSnapshot,
  GetDreamSettingsCommand,
  GetDreamSettingsResponseMessage,
  SetDreamSettingsCommand,
  SetDreamSettingsResponseMessage,
} from "@/types/dream-protocol";
import type { DreamRunStatus } from "@/types/dream-run-metadata";
import { getErrorMessage } from "@/utils/error";
import {
  isDreamNoteAppendCommand,
  isDreamNoteRemoveCommand,
  isDreamNotesListCommand,
  isDreamRunCommand,
  isDreamStatusCommand,
  isGetDreamSettingsCommand,
  isSetDreamSettingsCommand,
} from "@/websocket/listener/dream-protocol-inbound";
import { readDreamStatusSnapshot } from "@/websocket/listener/dream-status";
import type { ConversationRuntime } from "@/websocket/listener/types";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

/**
 * F-06 dream protocol handlers (M5-A stage 2, B2).
 *
 * Stage 1 froze the wire contract and the dispatch path; this module fills the
 * bodies. Everything answers from the same owners the TUI uses:
 *
 * - `dream_status` reads the resolved settings, the signal-state window rules,
 *   the lease/liveness pair and the hidden-conversation run records
 *   (`websocket/listener/dream-status.ts`);
 * - `dream_run` reuses S5 `startDreamRun`, exactly like `/dream run`, so the
 *   protocol and the TUI share one launcher (lock/settings checks included);
 * - the settings pair mirrors `readDreamSettings` / `updateDreamSettings` — no
 *   new storage, and the two layers are the ones that exist (`global` and this
 *   agent's override map);
 * - `execute_command "dream"` (below) is the text face: `status` and `run`
 *   only. `/dream config|on|off` moved to the structured settings commands and
 *   `dream` no longer aliases reflection (user ruling 3).
 *
 * `RunDetachedListenerTask` keeps the protocol reply off the router's await
 * path, matching every other command family.
 */
export type DreamProtocolCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

type DreamProtocolCommand =
  | DreamStatusCommand
  | DreamRunCommand
  | GetDreamSettingsCommand
  | SetDreamSettingsCommand
  | DreamNoteAppendCommand
  | DreamNotesListCommand
  | DreamNoteRemoveCommand;

/** What a command handler sends on the socket; injected so tests stay local. */
type DreamSend = (payload: unknown) => boolean;

function createDreamSend(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): DreamSend {
  return (payload) =>
    safeSocketSend(
      socket,
      payload,
      "listener_dream_send_failed",
      "listener_dream_protocol",
    );
}

/** The resolved knobs as the wire snapshot; the agent id is the resolution scope. */
export function toDreamSettingsSnapshot(
  agentId: string,
  settings: ResolvedDreamSettings,
): DreamSettingsSnapshot {
  return {
    agent_id: agentId,
    enabled: settings.enabled,
    permissionMode: settings.permissionMode,
    idleWindows: settings.idleWindows.map((window) => ({ ...window })),
    silenceMinutes: settings.silenceMinutes,
    pressureThreshold: settings.pressureThreshold,
    budgetFactor: settings.budgetFactor,
    maxPerRun: settings.maxPerRun,
    maxPerDay: settings.maxPerDay,
    timeLimitMinutes: settings.timeLimitMinutes,
    tiers: { ...settings.tiers },
    autoTrigger: settings.autoTrigger,
    overBudgetApprovals: settings.overBudgetApprovals,
  };
}

/** `dream_status`: enabled switch, live run, next window/cooldown, last run. */
export async function handleDreamStatusCommand(
  command: DreamStatusCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  readStatus: (
    agentId: string,
    now?: Date,
  ) => Promise<DreamStatusSnapshot> = readDreamStatusSnapshot,
): Promise<void> {
  const send = createDreamSend(socket, safeSocketSend);
  try {
    const status = await readStatus(command.runtime.agent_id);
    const response: DreamStatusResponseMessage = {
      type: "dream_status_response",
      request_id: command.request_id,
      success: true,
      status,
    };
    send(response);
  } catch (error) {
    const response: DreamStatusResponseMessage = {
      type: "dream_status_response",
      request_id: command.request_id,
      success: false,
      status: null,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/** `dream_run`: one manual run through the same launcher as `/dream run`. */
export async function handleDreamRunCommand(
  command: DreamRunCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  startRun: (input: {
    agentId: string;
  }) => Promise<StartDreamRunResult> = startDreamRun,
): Promise<void> {
  const send = createDreamSend(socket, safeSocketSend);
  try {
    const result = await startRun({ agentId: command.runtime.agent_id });
    const response: DreamRunResponseMessage = {
      type: "dream_run_response",
      request_id: command.request_id,
      success: true,
      started: result.started,
      ...(result.runId === null ? {} : { runId: result.runId }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
    send(response);
  } catch (error) {
    const response: DreamRunResponseMessage = {
      type: "dream_run_response",
      request_id: command.request_id,
      success: false,
      started: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/** `get_dream_settings`: the resolved snapshot for the command's agent. */
export function handleGetDreamSettingsCommand(
  command: GetDreamSettingsCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): void {
  const send = createDreamSend(socket, safeSocketSend);
  try {
    const agentId = command.runtime.agent_id;
    const response: GetDreamSettingsResponseMessage = {
      type: "get_dream_settings_response",
      request_id: command.request_id,
      success: true,
      settings: toDreamSettingsSnapshot(agentId, readDreamSettings(agentId)),
    };
    send(response);
  } catch (error) {
    const response: GetDreamSettingsResponseMessage = {
      type: "get_dream_settings_response",
      request_id: command.request_id,
      success: false,
      settings: null,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/**
 * `set_dream_settings`: a patch onto the global layer or this agent's override
 * map. `scope` is the two-layer vocabulary the frozen contract names; a value
 * outside it cannot reach here through the validator, but is rejected loudly
 * instead of silently writing a different layer.
 */
export function handleSetDreamSettingsCommand(
  command: SetDreamSettingsCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): void {
  const send = createDreamSend(socket, safeSocketSend);
  const agentId = command.runtime.agent_id;
  try {
    const scope = command.scope ?? "global";
    if (scope !== "global" && scope !== "agent") {
      throw new Error(`Unsupported dream settings scope: ${String(scope)}`);
    }
    if (scope === "agent") {
      updateDreamSettings(command.settings, agentId);
    } else {
      updateDreamSettings(command.settings);
    }
    const response: SetDreamSettingsResponseMessage = {
      type: "set_dream_settings_response",
      request_id: command.request_id,
      success: true,
      settings: toDreamSettingsSnapshot(agentId, readDreamSettings(agentId)),
    };
    send(response);
  } catch (error) {
    const response: SetDreamSettingsResponseMessage = {
      type: "set_dream_settings_response",
      request_id: command.request_id,
      success: false,
      settings: null,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

// ── Dream notes (F-06 §2.5) ──────────────────────────────────────────
//
// The queue's owner (`agent/dream/dream-notes`) decides what is acceptable:
// empty/over-long text and a full queue are refused with the reason the user
// must see, so the handler forwards that reason instead of flattening every
// refusal into "invalid command". The injected default is the real store;
// tests pass a fake only for the throw path.

/**
 * `dream_note_append`: queue one user note for this agent's next dream run.
 *
 * This is the user's own entrance (a desktop client), so the author is
 * `user` and the runtime's conversation id becomes the note's source.
 */
export async function handleDreamNoteAppendCommand(
  command: DreamNoteAppendCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  append: typeof appendNote = appendNote,
): Promise<void> {
  const send = createDreamSend(socket, safeSocketSend);
  try {
    const result = await append(command.runtime.agent_id, {
      text: command.text,
      author: "user",
      source: { conversationId: command.runtime.conversation_id },
    });
    const response: DreamNoteAppendResponseMessage = result.ok
      ? {
          type: "dream_note_append_response",
          request_id: command.request_id,
          success: true,
          note: result.note,
        }
      : {
          type: "dream_note_append_response",
          request_id: command.request_id,
          success: false,
          note: null,
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: DreamNoteAppendResponseMessage = {
      type: "dream_note_append_response",
      request_id: command.request_id,
      success: false,
      note: null,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/** `dream_notes_list`: the agent's queue, oldest first (corrupt lines skipped). */
export async function handleDreamNotesListCommand(
  command: DreamNotesListCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  list: typeof listNotes = listNotes,
): Promise<void> {
  const send = createDreamSend(socket, safeSocketSend);
  try {
    const notes = await list(command.runtime.agent_id);
    const response: DreamNotesListResponseMessage = {
      type: "dream_notes_list_response",
      request_id: command.request_id,
      success: true,
      notes,
    };
    send(response);
  } catch (error) {
    const response: DreamNotesListResponseMessage = {
      type: "dream_notes_list_response",
      request_id: command.request_id,
      success: false,
      notes: [],
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/**
 * `dream_note_remove`: drop one queued note. An unknown id is `deleted: false`
 * with `success: true` — the note the user wanted gone is already gone.
 */
export async function handleDreamNoteRemoveCommand(
  command: DreamNoteRemoveCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  remove: typeof removeNote = removeNote,
): Promise<void> {
  const send = createDreamSend(socket, safeSocketSend);
  try {
    const deleted = await remove(command.runtime.agent_id, command.note_id);
    const response: DreamNoteRemoveResponseMessage = {
      type: "dream_note_remove_response",
      request_id: command.request_id,
      success: true,
      deleted,
    };
    send(response);
  } catch (error) {
    const response: DreamNoteRemoveResponseMessage = {
      type: "dream_note_remove_response",
      request_id: command.request_id,
      success: false,
      deleted: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

async function handleDreamProtocolRequest(
  command: DreamProtocolCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<void> {
  switch (command.type) {
    case "dream_status":
      await handleDreamStatusCommand(command, socket, safeSocketSend);
      return;
    case "dream_run":
      await handleDreamRunCommand(command, socket, safeSocketSend);
      return;
    case "get_dream_settings":
      handleGetDreamSettingsCommand(command, socket, safeSocketSend);
      return;
    case "set_dream_settings":
      handleSetDreamSettingsCommand(command, socket, safeSocketSend);
      return;
    case "dream_note_append":
      await handleDreamNoteAppendCommand(command, socket, safeSocketSend);
      return;
    case "dream_notes_list":
      await handleDreamNotesListCommand(command, socket, safeSocketSend);
      return;
    case "dream_note_remove":
      await handleDreamNoteRemoveCommand(command, socket, safeSocketSend);
      return;
  }
}

export function handleDreamProtocolCommand(
  parsed: unknown,
  context: DreamProtocolCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;
  if (
    !isDreamStatusCommand(parsed) &&
    !isDreamRunCommand(parsed) &&
    !isGetDreamSettingsCommand(parsed) &&
    !isSetDreamSettingsCommand(parsed) &&
    !isDreamNoteAppendCommand(parsed) &&
    !isDreamNotesListCommand(parsed) &&
    !isDreamNoteRemoveCommand(parsed)
  ) {
    return false;
  }

  const command = parsed;
  runDetachedListenerTask("dream_protocol_command", async () => {
    await handleDreamProtocolRequest(command, socket, safeSocketSend);
  });
  return true;
}

// ── `execute_command "dream"` text entry (A-1) ──────────────────────

/**
 * The usage line a bad `/dream` argument answers with. `config` / `on` / `off`
 * are not retired features — they moved to `get_dream_settings` /
 * `set_dream_settings`, and a desktop text entry must say so rather than
 * silently doing nothing.
 */
export const DREAM_TEXT_USAGE =
  "Usage: /dream [status|run]. /dream config, /dream on and /dream off moved to the dream settings commands; /reflect runs reflection.";

const integerFormat = new Intl.NumberFormat("en-US");

function formatTokenCount(value: number): string {
  return integerFormat.format(Math.max(0, Math.trunc(value)));
}

/** A timestamp in the terms a status line reads in; `null` is unknown. */
export function formatDreamRelativeTime(
  at: number | null,
  now: number = Date.now(),
): string {
  if (at === null || !Number.isFinite(at)) return "unknown";
  const elapsed = Math.max(0, now - at);
  const minute = 60_000;
  if (elapsed < minute) return "just now";
  if (elapsed < 60 * minute) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < 24 * 60 * minute) {
    return `${Math.floor(elapsed / (60 * minute))}h ago`;
  }
  return `${Math.floor(elapsed / (24 * 60 * minute))}d ago`;
}

/** The persisted status as a status line reads it (`budget_exhausted` → words). */
export function formatDreamRunStatusLabel(status: DreamRunStatus): string {
  return status.replaceAll("_", " ");
}

/** The text `/dream status` shows; one line per fact, client-readable. */
export function formatDreamStatusText(
  status: DreamStatusSnapshot,
  now: number = Date.now(),
): string {
  const lines = [`dream: ${status.enabled ? "enabled" : "disabled"}`];
  if (status.running) {
    const tier = status.running.tier ?? "no tier reached yet";
    lines.push(
      `running: ${status.running.runId} · ${tier} · ${formatTokenCount(
        status.running.spentTokens,
      )} / ${formatTokenCount(status.running.budgetTokens)} tokens · started ${formatDreamRelativeTime(
        status.running.startedAt,
        now,
      )}`,
    );
  } else {
    lines.push("running: no active run");
  }
  lines.push(
    `next automatic run: ${
      status.nextEligibleAt === null ? "not scheduled" : status.nextEligibleAt
    }`,
  );
  if (status.lastRun) {
    lines.push(
      `last run: ${formatDreamRunStatusLabel(status.lastRun.status)} (${status.lastRun.triggerSource}) · started ${formatDreamRelativeTime(
        status.lastRun.startedAt,
        now,
      )}${
        status.lastRun.endedAt === null
          ? ""
          : ` · ended ${formatDreamRelativeTime(status.lastRun.endedAt, now)}`
      }`,
    );
  } else {
    lines.push("last run: none recorded");
  }
  return lines.join("\n");
}

/** Injectable edges for the text entry, so its tests never spawn a child. */
export type DreamTextCommandDeps = {
  readStatus?: (agentId: string, now?: Date) => Promise<DreamStatusSnapshot>;
  startRun?: (input: { agentId: string }) => Promise<StartDreamRunResult>;
  now?: () => Date;
};

/**
 * `/dream` as an `execute_command` text entry: `status` (the default) or `run`.
 *
 * User ruling 3 made this a breaking change: `dream` means the dream feature
 * now, and reflection is `/reflect`. Anything else is a usage error — an old
 * client sending `/dream on` must be told where the switch went instead of
 * being quietly routed to reflection.
 */
export async function handleDreamTextCommand(
  conversationRuntime: ConversationRuntime,
  args = "",
  deps: DreamTextCommandDeps = {},
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  if (!agentId) throw new Error("No agent ID available for the dream command.");
  const trimmed = args.trim();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const subcommand = tokens[0] ?? "status";
  if (tokens.length > 1) {
    throw new Error(
      `Unexpected /dream arguments: ${tokens.slice(1).join(" ")}. ${DREAM_TEXT_USAGE}`,
    );
  }
  if (subcommand === "status") {
    const status = await (deps.readStatus ?? readDreamStatusSnapshot)(agentId);
    return formatDreamStatusText(
      status,
      (deps.now ?? (() => new Date()))().getTime(),
    );
  }
  if (subcommand === "run") {
    const result = await (deps.startRun ?? startDreamRun)({ agentId });
    if (result.started) {
      return result.runId === null
        ? "Dream run started."
        : `Dream run started: ${result.runId}.`;
    }
    return `Dream run not started: ${result.reason ?? "reason unknown"}`;
  }
  throw new Error(
    `Unknown /dream subcommand "${subcommand}". ${DREAM_TEXT_USAGE}`,
  );
}
