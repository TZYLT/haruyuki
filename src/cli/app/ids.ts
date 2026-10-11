import { randomUUID } from "node:crypto";
import type { Buffers } from "@/cli/helpers/accumulator";
import { isRecallReminderText } from "@/reminders/recall-reminder";

// tiny helper for unique ids (avoid overwriting prior user lines)
export function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// OTIDs are client-generated correlation ids, not canonical backend message ids.
// We use them to stitch together an optimistic local transcript row, the outbound
// request payload, and the echoed user_message chunk that later arrives from the
// server with the real message.id.
export function createClientOtid(): string {
  return randomUUID();
}

export function appendOptimisticUserLine(
  buffers: Buffers,
  text: string,
  otid: string,
): string | null {
  if (!text) {
    return null;
  }

  const userId = uid("user");
  buffers.byId.set(userId, {
    kind: "user",
    id: userId,
    text,
    otid,
  });
  buffers.userLineIdByOtid.set(otid, userId);
  buffers.order.push(userId);
  return userId;
}

/**
 * Append feature ②'s own row for a turn, when its reminders carry an injection.
 *
 * A row of its own rather than part of the user bubble: `appendOptimisticUserLine`
 * runs before any reminder is built, and `<Static>` never re-renders a row it has
 * printed, so the block cannot be folded into that row once the injection exists.
 * Appending here puts the row directly under the message it belongs to; on a later
 * restart the same block is read back from the message itself.
 */
export function appendRecallLine(
  buffers: Buffers,
  reminderParts: readonly { type: "text"; text: string }[],
): string | null {
  const block = reminderParts.find((part) =>
    isRecallReminderText(part.text),
  )?.text;
  if (block === undefined) {
    return null;
  }

  const id = uid("recall");
  buffers.byId.set(id, { kind: "recall", id, text: block });
  buffers.order.push(id);
  return id;
}
