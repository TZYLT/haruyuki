/**
 * Report text for a personality swap on the local backend.
 *
 * `/agent personality` writes the new persona/human blocks into the memory repo and
 * commits them. Under strict prefix freeze that commit is only *registered*:
 * the conversation's applied snapshot keeps the old blocks until the next
 * application point (new conversation, compaction, `/recompile`).
 *
 * The wording therefore must not claim the swap already took effect, and the
 * handler must not recompile on the spot — doing so would apply a prefix change
 * from a non-application point and hide the registered state from
 * `/context pending` (R-08).
 */
export function formatPersonalitySwappedMessage(label: string): string {
  return [
    `Personality swapped to ${label}.`,
    "It is registered but not applied yet — run `/context pending` to review it, or `/recompile` to apply it now.",
    "It also applies at the next compaction or new conversation.",
  ].join(" ");
}
