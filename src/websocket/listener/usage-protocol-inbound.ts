import type { UsageAggregateCommand } from "@/types/usage-protocol";
import { isObjectRecord } from "./protocol-validation";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isUsageAggregateCommand(
  value: unknown,
): value is UsageAggregateCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "usage_aggregate" &&
    isNonEmptyString(value.request_id) &&
    isNonEmptyString(value.agent_id) &&
    (value.run_id === undefined || isNonEmptyString(value.run_id)) &&
    (value.session_id === undefined || isNonEmptyString(value.session_id)) &&
    (value.from === undefined || isIsoTimestamp(value.from)) &&
    (value.to === undefined || isIsoTimestamp(value.to))
  );
}
