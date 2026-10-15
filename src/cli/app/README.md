# CLI App Layout

`src/cli/App.tsx` is the public entrypoint. This directory holds the actual
implementation, split by responsibility so agents can open the smallest useful
file first.

- `App.tsx`: local entrypoint that re-exports the coordinator.
- `AppCoordinator.tsx`: Ink state, effects, overlay wiring, and render tree.
- `AppView.tsx`: render-only Ink tree for the coordinator. It takes the
  transcript region as a `transcript` component, so the two shells differ only by
  which region they inject.
- `shell/AppShell.tsx`: the single shell selector (append-style vs full-screen),
  resolved once per mount so a mode flip never remounts the transcript.
- `shell/LegacyShell.tsx`: append-style shell (terminal-title writer + AppView).
- `shell/V2Shell.tsx`: full-screen shell (ShellFrame + the viewport transcript).
- `shell/ShellFrame.tsx`: chrome both shells share — terminal title, the input
  router, and the overlay/modal input claims.
- `shell/types.ts`: the `AppShellProps` projection shared by every shell.
- **Transcript regions** (the shell's one difference):
  - `AppendTranscript.tsx`: append-style region — `<Static>` for committed items,
    live items and inline approvals under it.
  - `ViewportTranscript.tsx`: full-screen region — renders only the window that
    intersects the viewport, bottom-anchored, with bounded residency.
  - `TranscriptItem.tsx`: one committed item, shared by both regions so a line
    renders identically in each.
  - `live-items.ts`: which live `Line`s get a row (shared by both regions).
  - `chrome-height.ts`: measures the chrome below the transcript, which is what
    leaves the viewport its remaining rows.
- **Row model** (how tall an item is, without rendering it):
  - `row-model.ts`: item-level dispatch and the plain transcript lines.
  - `tool-call-rows.ts`, `approval-rows.ts`, `memory-result-rows.ts`: the branches
    whose height is a layout of their own.
  - `viewport-window.ts`, `viewport-scroll.ts`: window selection (row band,
    anchors) and the scroll position store.
- `useSubmitHandler.ts`: slash-command and user-submit router.
- `useConversationLoop.ts`: streaming turn loop, retry/recovery, tool execution,
  and reflection auto-launch.
- `useApprovalFlow.ts`: approval recovery and approve/deny batching.
- `useConversationSwitching.ts`: `/btw`, agent selection, and new-agent
  conversation switching flows.
- `useBashHandlers.ts`: bash-mode submit/interrupt handling.
- `useQueuedApprovalSubmit.ts`: stale approval recovery helpers used before
  slash-command sends.
- `useFeedbackHandler.ts`: `/feedback` submission and diagnostics payload.
- `useInterruptHandler.ts`: ESC interrupt, cancellation, and recovery cleanup.
- `useReasoningCycle.ts`: reasoning-tier tab cycling and debounced persistence.
- `useConfigurationHandlers.ts`: model/system/personality/toolset/experiment
  selectors and their queued overlay actions.
- `constants.ts`: timing, retry, provider fallback, and layout constants.
- `modelConfig.ts`: model handle, reasoning effort, and model error hint helpers.
- `commandRouting.ts`: slash command queue-bypass classification.
- `approvalDiffs.ts`, `approvalQuestions.ts`: approval helpers.
- `ids.ts`, `contentParts.ts`, `systemReminders.ts`: transcript and content utilities.
- `reflection.ts`, `retry.ts`, `session.ts`, `notifications.ts`, `errors.ts`: focused runtime helpers.
- `StaticTranscript.tsx`, `ExitStats.tsx`: render-only pieces extracted from the coordinator.
- `types.ts`: app props and static transcript item types.

The split intentionally mirrors the listener layout at a coarse level:
`useConversationLoop.ts` is the interactive analogue of listener `turn.ts`,
while `useSubmitHandler.ts` owns the command-routing surface that can converge
with listener command handling in a later PR.
