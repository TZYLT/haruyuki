# TUI Guidance

These rules apply to Ink rendering, approvals, and interactive input under
`src/cli/`. Read `app/README.md` for the current ownership map before choosing a
file to change.

## Rendering

- `react-dom` is not a dependency and Ink does not use it.
- Ink does not automatically batch related state updates after an `await`. Apply
  updates that should paint together before the first awaited boundary.
- Items committed through `<Static>` do not re-render. Commit an item only after
  its displayed content is complete, keep its key stable, and change the static
  render epoch only for an intentional full transcript repaint.
- A transcript item may be live or static, never both. Filter committed IDs out
  of the live list before rendering.
- Isolate frequently changing input, timer, and stream state from tall transcript
  components. Memoize stable bodies rather than whole stateful trees.

## Approvals and Input

- Route every tool approval through `ApprovalSwitch`; do not add a second
  tool-specific approval branch in the transcript.
- Show one focused approval. Other parallel approvals remain compact pending or
  decided stubs until they become current.
- Keep `Input` mounted after startup. Use its visibility, enabled, and collapse
  props while approvals or overlays own focus so draft and terminal state survive.
- Bracketed paste and keyboard-protocol handling live in `PasteAwareTextInput`,
  which uses Ink's `usePaste` hook and the `kittyKeyboard` render option. The
  vendored Ink string patches were retired in the Ink 7 upgrade. Do not add
  competing raw stdin listeners.
- **A mouse report is not a key and must never become text.** Ink has no mouse
  API, so a report nobody claims is parsed as input and typed into the draft
  (`[<0;10;5M`). The input router claims the two encodings before the key path
  (`helpers/mouse-sequence.ts`), and `helpers/mouse-router.ts` dispatches them to
  the shell that knows what a wheel notch should do. The terminal modes live in
  `helpers/mouse-tracking.ts`: every enable is paired with a disable — unmount,
  process exit, and a `Ctrl+Z` hand-over all give the mouse back, because a
  terminal left in mouse mode prints escape garbage into the user's shell.
- **The selection copies the drag, and reads Ink's frame to do it.** Ink 7 writes
  a whole frame per write, and `helpers/terminal-frame.ts` captures it; the text a
  drag covers is read from those bytes at drag time, never from a second renderer
  of the transcript, and that text is what `Ctrl+X y` returns — the selection is
  what the user dragged over, and it survives the transcript moving underneath it
  (a scroll, rows arriving while the view follows the newest, the band losing a row
  to the leader's hint on the key press before the copy). The *highlight* cannot be
  remembered that way, so it is placed by following the layout and drawn only when
  those rows still read as the drag did: `app/viewport-selection.ts` owns the
  capture and the relocation, and the painter splices the inverse sequence into the
  rows' own bytes and writes it *outside* the frame bookkeeping, so it neither
  drops the row's colours nor becomes text a copy would read back. A drag made on a
  frame that cannot be placed is refused outright, the same refusal the painter
  makes. The capture is installed by the process entry
  (`app/shell/full-screen-terminal.ts`), because Ink writes its first frame inside
  `render()`, before any effect runs. Copying goes out over OSC 52 **and** the
  platform command (`helpers/terminal-clipboard.ts`): OSC 52 cannot report failure,
  so treating the local command as a fallback that waits for one would silently do
  nothing on terminals that block OSC 52.

## Verification

Run focused tests for the component or hook you changed. For render-sensitive
work, also exercise narrow and wide terminals, tall output, and parallel
approvals or paste input when those paths are affected.

**Judge a key path on the rendered frame when its purpose is to be seen.** Hints,
which-key lists, panes and panels can be wired perfectly and still paint nothing:
the handler runs, the state is exactly what the test asserts, and the screen is
empty because a later step in the same keystroke undid it (a store rearmed during
routing and then disarmed, a flag set and then reset). Router- or state-level
assertions cannot see that class of bug — one shipped through a test that pinned
the failure as expected behaviour. So for those paths, render the real component
against a fake TTY and assert on the frame (see
`src/cli/components/composer-leader.test.tsx`).
