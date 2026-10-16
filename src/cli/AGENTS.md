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
