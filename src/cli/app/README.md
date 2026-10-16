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
- `shell/use-mouse-input.ts`: the full-screen shell's mouse layer — terminal mouse
  reporting (on while the shell is up, given back on unmount/suspend/exit), wheel
  scrolling, and the leader's mouse switch. The reports are decoded in
  `src/cli/helpers/mouse-sequence.ts` and dispatched by `mouse-router.ts`.
- `shell/use-terminal-selection.ts`: drag selection over the rendered rows and its
  highlight. It reads the frame Ink wrote
  (`src/cli/helpers/terminal-frame.ts`) instead of re-rendering the transcript,
  paints the highlight with terminal writes, and stores the selection in
  `viewport-selection.ts`.
- `shell/full-screen-terminal.ts`: the entry's terminal hand-over for the
  full-screen shell — the alternate screen decision plus the frame capture, which
  has to exist before Ink writes its first frame inside `render()`.
- `shell/types.ts`: the `AppShellProps` projection shared by every shell.
- **Transcript regions** (the shell's one difference):
  - `AppendTranscript.tsx`: append-style region — `<Static>` for committed items,
    live items and inline approvals under it.
  - `ViewportTranscript.tsx`: full-screen region — renders only the window that
    intersects the viewport, bottom-anchored, with bounded residency, and the
    panel (`ViewportPanel.tsx`) that sits under the band: running subagents, plus
    the focused approval when the band does not draw it.
  - `ViewportPanel.tsx`: that panel; its measured rows come out of the band.
  - `FocusedApproval.tsx`: the one focused approval surface both regions render
    through `ApprovalSwitch`.
  - `TranscriptItem.tsx`: one committed item, shared by both regions so a line
    renders identically in each.
  - `live-items.ts`: which live `Line`s get a row, the item list both regions
    render, and whether the focused approval has a row of its own (shared by both
    regions).
  - `chrome-height.ts`: measures the chrome below the transcript, which is what
    leaves the viewport its remaining rows.
- **Row model** (how tall an item is, without rendering it):
  - `row-model.ts`: item-level dispatch and the plain transcript lines.
  - `tool-call-rows.ts`, `approval-rows.ts`, `memory-result-rows.ts`: the branches
    whose height is a layout of their own.
  - `viewport-window.ts`, `viewport-scroll.ts`: window selection (row band,
    anchors) and the scroll position store.
  - `use-live-height.ts`: the append shell's live-area height estimate, which
    subscribes to the transcript display state (ctrl+t / ctrl+r) so an expanded
    body is measured as expanded.
  - `exit-summary.ts`: the exit-summary text both shells share, plus the
    registration a full-screen shell uses so the summary survives Ink's teardown
    of the alternate screen (`shell/use-exit-summary.ts`).
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
