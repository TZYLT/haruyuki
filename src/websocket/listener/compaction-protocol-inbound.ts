import type {
  CompactionCancelCommand,
  CompactionCommitCommand,
  CompactionPrepareCommand,
} from "@/types/compaction-protocol";
import { isObjectRecord } from "./protocol-validation";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isCompactionPrepareCommand(
  value: unknown,
): value is CompactionPrepareCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "compaction_prepare" &&
    isNonEmptyString(value.request_id) &&
    isNonEmptyString(value.conversation_id) &&
    (value.body === undefined || isObjectRecord(value.body))
  );
}

export function isCompactionCommitCommand(
  value: unknown,
): value is CompactionCommitCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "compaction_commit" &&
    isNonEmptyString(value.request_id) &&
    isNonEmptyString(value.conversation_id) &&
    isNonEmptyString(value.prepare_id) &&
    (value.block_index === undefined ||
      (Number.isInteger(value.block_index) &&
        (value.block_index as number) > 0))
  );
}

export function isCompactionCancelCommand(
  value: unknown,
): value is CompactionCancelCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "compaction_cancel" &&
    isNonEmptyString(value.request_id) &&
    isNonEmptyString(value.conversation_id) &&
    isNonEmptyString(value.prepare_id)
  );
}
