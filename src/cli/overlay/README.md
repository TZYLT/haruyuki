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
| `list-model.ts` | Pure list behaviour: cursor clamping, the visible window, filtering, multi-select ordering, reordering. No React, no Ink. |
| `list-view.tsx` | Rendering a window: rows, the "(current)" marker, the "↑/↓ N more" indicators, and the loading/empty/error states. |
| `list-bindings.ts` | Pure key data: arrows, `j`/`k`, PageUp/PageDown, Home/End, Enter, Escape, Space, ←/→. |
| `use-overlay-list.ts` | Wiring the model and the key table to the input router — including claiming the scope — and keeping the state in the leaf. |
| `pagination.ts` | Incremental page fetching: generation guard, identity de-duplication, the idle/loading/more/end/error machine. |
| `text-view.tsx` | The text sub-view — reuses `TextInput`/`PasteAwareTextInput` rather than growing a second editor. |
| `confirm.tsx` | Option-style and type-to-confirm confirmations. |
| `wizard.tsx` | Multi-step containers with a return stack. |
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

## Why the keys are data

Ink fans one stdin event out to every `useInput` listener and has no
stopPropagation, so "this key belongs to the overlay" can only be expressed by
the router, before the event is dispatched. The tables here are built per render
and read at event time by `useKeyBindings`, which is why the handlers close over
the current cursor without re-registering anything.
