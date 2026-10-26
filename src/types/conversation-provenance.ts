/**
 * Provenance fields recorded on a local conversation: where it came from and
 * what kind of context it inherited.
 *
 * Deliberately additive and display-only. Nothing here authorizes a write or a
 * delete — the hidden-session viewer deletes by conversation id and filters by
 * `hidden`, so a missing or wrong `origin` can never widen a delete.
 */
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import {
  type ReflectionRunMetadata,
  readReflectionRunMetadata,
} from "@/types/reflection-run-metadata";
import { isRecord } from "@/utils/type-guards";

export type ConversationOrigin =
  | "reflection"
  | "dream"
  | "background"
  | "external"
  | "unknown";

export type ConversationContextMode =
  | "inherited-context"
  | "inherited-history"
  | "standalone";

export interface ConversationProvenance {
  /** Producer of the conversation; unknown for records written before 0.4.1. */
  origin?: ConversationOrigin;
  /** Direct source of a fork; null for a conversation created on its own. */
  parent_conversation_id?: string | null;
  /** What a fork copied: full history, context only (F-03), or nothing. */
  context_mode?: ConversationContextMode;
  /** Projected (stored) messages a fork cloned; display fallback, not the cursor. */
  inherited_message_count?: number | null;
  /** Id of the last projected cloned message; the precise slice cursor. */
  inherited_through_message_id?: string | null;
  /**
   * Optional reflection-run record on the conversation itself (F-03 §5.3.4).
   * Present only on a conversation a reflection run forked; absent means "not a
   * reflection run", never "unknown status".
   */
  reflection?: ReflectionRunMetadata;
}

/**
 * What a fork caller may pass. The store turns this into the snake_case record
 * fields above (see `LocalStore.forkConversation`).
 */
export interface ConversationForkProvenance {
  origin?: ConversationOrigin;
  contextMode?: ConversationContextMode;
  parentConversationId?: string | null;
}

export type NormalizedConversationProvenance = ConversationProvenance & {
  /** Always present after `readConversationProvenance`; defaults to `unknown`. */
  origin: ConversationOrigin;
};

/**
 * One row of the hidden-session list or of `conversation_list`.
 *
 * The context size is optional here because a backend need not annotate it; the
 * viewer's own rows require it (`HiddenConversationSummary`). One shape, so the
 * backend, the protocol and the TUI cannot disagree about the fields.
 */
export interface ConversationListRow
  extends Conversation,
    ConversationProvenance {
  hidden?: boolean;
  /** Size of the current context (`in_context_message_ids`), not the log. */
  context_message_count?: number;
}

/**
 * One row of the hidden-session list. `hidden` stays optional because the
 * SDK's `Conversation` does not carry it and older callers never set it.
 */
export interface HiddenConversationSummary extends ConversationListRow {
  /** Size of the current context (`in_context_message_ids`), not the log. */
  context_message_count: number;
}

/**
 * Project a listed conversation onto a row: provenance and the context size are
 * attached by the backend at runtime but are not part of the SDK's
 * `Conversation`, so they are read through the readers above rather than cast.
 *
 * Shared by the local list, the app-server listener and the TUI: three copies of
 * this projection would drift the moment one of them learns a new field.
 */
export function toHiddenConversationSummary(
  conversation: Conversation & Partial<ConversationListRow>,
): HiddenConversationSummary {
  const annotated = typeof conversation.context_message_count === "number";
  return {
    ...conversation,
    ...readConversationProvenance(conversation),
    ...(conversation.hidden === true ? { hidden: true } : {}),
    context_message_count: annotated
      ? (conversation.context_message_count as number)
      : readContextMessageCount(conversation),
  };
}

const CONVERSATION_ORIGINS: readonly string[] = [
  "reflection",
  "dream",
  "background",
  "external",
  "unknown",
];

const CONVERSATION_CONTEXT_MODES: readonly string[] = [
  "inherited-context",
  "inherited-history",
  "standalone",
];

export function isConversationOrigin(
  value: unknown,
): value is ConversationOrigin {
  return typeof value === "string" && CONVERSATION_ORIGINS.includes(value);
}

export function isConversationContextMode(
  value: unknown,
): value is ConversationContextMode {
  return (
    typeof value === "string" && CONVERSATION_CONTEXT_MODES.includes(value)
  );
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return value === null ? null : undefined;
}

function optionalCount(value: unknown): number | null | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return value === null ? null : undefined;
}

/**
 * Read provenance off an arbitrary record: a `conversation.json` body, a list
 * item, a protocol payload.
 *
 * Unrecognized values are dropped rather than guessed, so a record written
 * before 0.4.1 reads exactly as `origin: "unknown"` plus nothing else.
 */
export function readConversationProvenance(
  record: unknown,
): NormalizedConversationProvenance {
  if (!isRecord(record)) return { origin: "unknown" };
  const origin = isConversationOrigin(record.origin)
    ? record.origin
    : "unknown";
  const contextMode = isConversationContextMode(record.context_mode)
    ? record.context_mode
    : undefined;
  const parentConversationId = optionalStringOrNull(
    record.parent_conversation_id,
  );
  const inheritedCount = optionalCount(record.inherited_message_count);
  const inheritedThrough = optionalStringOrNull(
    record.inherited_through_message_id,
  );
  const reflection = readReflectionRunMetadata(record.reflection);
  return {
    origin,
    ...(parentConversationId !== undefined
      ? { parent_conversation_id: parentConversationId }
      : {}),
    ...(contextMode !== undefined ? { context_mode: contextMode } : {}),
    ...(inheritedCount !== undefined
      ? { inherited_message_count: inheritedCount }
      : {}),
    ...(inheritedThrough !== undefined
      ? { inherited_through_message_id: inheritedThrough }
      : {}),
    ...(reflection !== undefined ? { reflection } : {}),
  };
}

/** `in_context_message_ids.length`; 0 when the record carries no such list. */
export function readContextMessageCount(record: unknown): number {
  if (!isRecord(record)) return 0;
  const ids = record.in_context_message_ids;
  return Array.isArray(ids) ? ids.length : 0;
}

/**
 * Record-body fields for a hidden conversation created on its own: no parent,
 * no inherited segment (§5.5.2). Local-only, so callers spread this into the
 * create body rather than through the SDK's create type.
 */
export function hiddenStandaloneProvenance(
  origin: ConversationOrigin,
): ConversationProvenance & { hidden: true } {
  return { hidden: true, origin, context_mode: "standalone" };
}
