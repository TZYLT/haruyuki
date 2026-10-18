# Overlay Toolkit

The single implementation of an overlay's interaction: the frame, the list
model, the key table, the sub-views (text, confirm, wizard, preview), and the
adapters the pre-toolkit pickers were rewritten onto.

Thirty-one files under `src/cli` bound their own keys with Ink's `useInput`
before this existed, and `SingleSelectPicker`/`MultiSelectPicker` covered only
part of the need — so "list navigation + pagination + search" was written by
hand a dozen times, each copy with its own edge cases. Everything in this
directory exists to be the *one* copy.

## Ownership

| File | Owns |
|---|---|
| `frame.tsx` | The chrome: `> /command`, solid line, title, body, footer. The **only** place an overlay header is rendered. Claims the input scope for its container kind. |
| `list-model.ts` | Pure list behaviour: cursor clamping, the visible window (either anchor), filtering, multi-select ordering, reordering. No React, no Ink. |
| `list-view.tsx` | Rendering a window: rows, the "(current)" marker, the "↑/↓ N more" indicators, and the loading/empty/error states. |
| `list-bindings.ts` | Pure key data: arrows, `j`/`k`, PageUp/PageDown, Home/End, Enter, Escape, Space, ←/→. |
| `use-overlay-list.ts` | Wiring the model and the key table to the input router — including claiming the scope — and keeping the state in the leaf. |
| `pagination.ts` | Incremental page fetching as data: identity de-duplication, the cursor a full page hands on, the idle/loading/more/ready/error machine. |
| `use-pagination.ts` | The page machine's React half — the generation guard that makes a superseded response inert, and the rule that a first load wins while a further one waits. |
| `text-view.tsx` | The text sub-view: the labelled `> ` editor row, built on `PasteAwareTextInput` rather than growing a second editor. |
| `confirm.tsx` | Option-style and type-to-confirm confirmations. |
| `wizard.tsx` | Multi-step containers: the return stack as data, and the two keys that leave a step. |
| `preview.ts` | The one classification of an approval's preview body (command / diff / args). |
| `adapters.tsx` | `SingleSelectPicker`/`MultiSelectPicker`, rewritten as thin wrappers so their existing consumers did not have to change. |

## Rules

1. **One key owner.** Inside `overlay`/`modal`, list navigation keys may only be
   declared by `list-bindings.ts`. No overlay handles ↑↓/Enter/Escape/Space/←→
   through its own `useInput`. **One named exception**: the four inline
   approvals' shared option list (`@/cli/components/ApprovalOptions`) keeps Ink's
   `useInput`, because its custom-denial row is a live text editor — every
   printable key belongs to the editor while the cursor is on it, and a
   chord-less catch-all binding would decline the keys it does not want, which
   drops them on the composer behind the approval. Those keys are unchanged from
   the four copies they replaced and are pinned in that component's test.
2. **Decline, do not swallow.** A binding that does not apply right now (empty
   list, no query field, not in the confirm state) must return `declined` so the
   key continues down its normal path. `matchingBindings` exists for this; a
   binding that matches and consumes is a bug when it had nothing to do.
3. **Identity is the item's `key`, never its index.** Anything that outlives a
   render — a selection, a reorder, an anchor — is expressed as a key.
4. **Windowing is opt-in.** `rows: undefined` renders the whole list, which is
   what every overlay did before the toolkit; a caller asks for a window
   explicitly, so migrating one cannot silently change what a long list shows.
   The same rule covers the window's *shape*: `anchor` is `edge` unless a face
   asks for `center`, and `indicators` may be turned off by a face that prints the
   position itself (`/resume`, `/search`). A face picks what it already had. Two
   keys are opt-out for the same reason: `vimKeys` is off for a list beside a live
   field (its `j`/`k` are letters), and `edgeKeys` is off for one beside a live
   editor, whose Home/End are the caret's — a claim that has to be unconditional,
   because the editor re-registers behind the list whenever it remounts.
5. **State stays in the leaf.** Cursor and query state live in the overlay
   component, never in `AppCoordinator`/`AppView` (see `src/cli/AGENTS.md`) and
   never in a module-level store: an overlay is one component, and a store would
   leak across mounts and tests.
6. **Claim the scope you bind in.** The router consults only the owning scope plus
   `system`, so a list that binds `overlay` keys without claiming the `overlay`
   layer is wired correctly and receives nothing. `useOverlayList` claims it, and
   the frame declares its container's layer; both are ref-counted, so the app's
   shell can claim the same layer from the open route without either having to
   know about the other.
7. **A `disabled` row is the caller's policy, not the list's.** The key is always
   consumed, and `onConfirm`/`onToggle` are called for a blocked row too; whether
   that acts is decided where the row's meaning lives. The two pickers disagreed
   and both were right: a blocked row in the single-select confirmed nothing,
   while the multi-select confirmed its whole selection from wherever the cursor
   stood — which is what keeps a list of nothing but blocked rows closable.
8. **Escape belongs to the wizard, not to the step.** A multi-step overlay's
   Escape goes back one step and cancels at the root; Ctrl+C cancels from any
   step. Both are declared once (`wizard.tsx`), so a step that redefines Escape
   does it as a binding at the head of the table — ahead of the rule, declining
   when it had nothing to do. A step that merely has to clear its own field on
   the way out passes its own `onBack` instead, so the stack never learns about a
   step's state.

## Why the keys are data

Ink fans one stdin event out to every `useInput` listener and has no
stopPropagation, so "this key belongs to the overlay" can only be expressed by
the router, before the event is dispatched. The tables here are built per render
and read at event time by `useKeyBindings`, which is why the handlers close over
the current cursor without re-registering anything.

There is a second reason, measured while migrating `/hooks`: under React 19.2.8
with `react-reconciler` 0.33.0 (Ink 7.1.1), **a `memo`-wrapped component's
`useInput` handler keeps the state of its first render.** A `useState` counter
incremented from that handler reports `[0,0,0]` when the component is wrapped in
`memo` and `[0,1,2]` when the same component is not. The real face shows it too:
the pre-migration `/hooks` logs `screen=events index=0` on every dispatch — so
its six-step ladder can never leave the root step — while the identical file with
`memo(` removed walks all six screens under the same harness. Any face here that
both wraps itself in `memo` and *reads* its own state inside `useInput` is acting
on a stale ladder, which is why this rule is a check (`key-owner.test.ts`) rather
than a convention.
