/**
 * Commands that can be dispatched by a remote client (e.g. letta-cloud desktop)
 * via the `execute_command` WebSocket message type.
 *
 * This list is advertised to clients as `device_status.supported_commands` and
 * gates the controls they render, so it must describe what the listener can
 * actually answer. Ids in this list are expected to be one of:
 *
 * - a `case` in `handleExecuteCommand` (`src/websocket/listener/commands.ts`),
 *   or
 * - a key of {@link REMOTE_COMMANDS_HANDLED_ELSEWHERE}, served through a
 *   dedicated WebSocket message type instead of `execute_command`.
 *
 * `commands-dispatch-parity.test.ts` pins that agreement, including the
 * reverse direction: a `case` that is intentionally not advertised must be a
 * documented legacy alias in {@link UNADVERTISED_REMOTE_COMMAND_ALIASES}.
 *
 * Kept in a standalone file to avoid circular imports between commands.ts
 * and protocol-outbound.ts.
 */
export const SUPPORTED_REMOTE_COMMANDS: readonly string[] = [
  "clear",
  // Wire id retained for desktop clients; the current TUI form is
  // `/messages clear` (see the hub mapping in `src/cli/commands/hubs.ts`).
  "clear-messages",
  "doctor",
  "dream",
  "reflect",
  // Wire id retained for desktop clients; the current TUI form is `/reflect`
  // (`/reflection` was retired into the `/reflect` command).
  "reflection",
  "init",
  "compact",
  "reload",
  "context-limit",
  "channels",
  // Desktop sends the dedicated `update_toolset` command for this control, not
  // an `execute_command` with this id; the entry keeps the control advertised.
  "toolset",
  // /secret opens the EditSecretsDialog and routes reads/writes through the
  // dedicated secret_list / secret_apply WS commands — not via
  // execute_command — so it has no case in handleExecuteCommand.
  "secret",
  "monitor_stop",
];

/**
 * Advertised ids that `handleExecuteCommand` does not dispatch itself.
 *
 * Each of these is served by a dedicated WebSocket message type handled in
 * `message-router.ts`. Advertising them still matters: clients render a control
 * for every advertised id, and an id that is advertised but unhandled would
 * fall through the `execute_command` switch into the mod-command path and be
 * answered with "Unknown command".
 *
 * The reason is required by the parity test, so an id cannot be excused here
 * without recording where it is actually served.
 */
export const REMOTE_COMMANDS_HANDLED_ELSEWHERE: Readonly<
  Record<string, string>
> = {
  toolset:
    "Handled by the dedicated `update_toolset` command " +
    "(handleModelToolsetCommand in commands/model-toolset.ts).",
  secret:
    "Handled by the dedicated `secret_list` / `secret_apply` commands " +
    "(handleSecretsCommand in commands/secrets.ts).",
  monitor_stop:
    "Handled as a top-level `monitor_stop` message " +
    "(handleMonitorStopCommand in commands/monitors.ts).",
};

/**
 * Wire ids that `handleExecuteCommand` still dispatches but deliberately does
 * not advertise.
 *
 * These are legacy aliases: an older desktop client may still send them, so
 * removing the `case` would break that client, but the advertised list names
 * the current command instead. Keeping them out of
 * {@link SUPPORTED_REMOTE_COMMANDS} means new clients never render a retired
 * name, and a client that only reads the advertised list can never learn them.
 *
 * The parity test requires every unadvertised `case` to be documented here with
 * a reason, and requires every key to remain a `case` in commands.ts.
 */
export const UNADVERTISED_REMOTE_COMMAND_ALIASES: Readonly<
  Record<string, string>
> = {
  "set-max-context":
    "Pre-rename wire id for `context-limit`; dispatch kept so clients that " +
    "still send it keep working, advertised as `context-limit` only. The " +
    "frozen advertised list is pinned by listen-client-protocol.test.ts.",
};
