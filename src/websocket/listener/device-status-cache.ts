import type { DreamDeviceSummary } from "@/types/dream-protocol";
import type { DeviceStatus } from "@/types/protocol_v2";
import { readDreamDeviceSummary } from "./dream-status";
import type { ListenerTransport } from "./transport";

type DeviceStatusScope = {
  agent_id?: string | null;
  conversation_id?: string | null;
};

/** Per-transport, per-scope cache naturally released with the transport. */
const lastDeviceStatusByTransport = new WeakMap<
  ListenerTransport,
  Map<string, string>
>();

export function recordDeviceStatus(
  transport: ListenerTransport,
  scope: DeviceStatusScope,
  status: DeviceStatus,
): void {
  shouldEmitDeviceStatus(transport, scope, status, true);
}

export function shouldEmitDeviceStatus(
  transport: ListenerTransport,
  scope: DeviceStatusScope,
  status: DeviceStatus,
  force = false,
): boolean {
  const statusJson = JSON.stringify(status);
  const cacheKey = `${scope.agent_id ?? ""}:${scope.conversation_id ?? ""}`;
  let scopeCache = lastDeviceStatusByTransport.get(transport);
  if (!scopeCache) {
    scopeCache = new Map();
    lastDeviceStatusByTransport.set(transport, scopeCache);
  }
  if (!force && scopeCache.get(cacheKey) === statusJson) {
    return false;
  }
  scopeCache.set(cacheKey, statusJson);
  return true;
}

/**
 * How long one agent's dream summary is reused by the status broadcast.
 *
 * `device_status` is emitted on most turn/status transitions, while a dream run
 * changes state a few times per hour. The summary therefore needs a cache, not
 * a fresh disk read per emit: five seconds keeps a started/finished run visible
 * well within one client render cycle without paying `readDreamSignalState` +
 * lease read + process probe on every emission.
 */
export const DREAM_DEVICE_SUMMARY_TTL_MS = 5_000;

/** One agent per entry; bounded because agents are few per listener. */
const DREAM_SUMMARY_CACHE_LIMIT = 64;

type CachedDreamSummary = {
  expiresAt: number;
  summary: DreamDeviceSummary | null;
};

const dreamSummaryByAgent = new Map<string, CachedDreamSummary>();

/**
 * The `device_status.dream` summary, cached per agent.
 *
 * `now` is injectable so tests can step past the TTL without waiting.
 */
export function getDreamDeviceSummary(
  agentId: string | null,
  now: number = Date.now(),
): DreamDeviceSummary | null {
  if (!agentId) return null;
  const cached = dreamSummaryByAgent.get(agentId);
  if (cached && cached.expiresAt > now) return cached.summary;

  const summary = readDreamDeviceSummary(agentId, new Date(now));
  if (
    dreamSummaryByAgent.size >= DREAM_SUMMARY_CACHE_LIMIT &&
    !dreamSummaryByAgent.has(agentId)
  ) {
    dreamSummaryByAgent.clear();
  }
  dreamSummaryByAgent.set(agentId, {
    expiresAt: now + DREAM_DEVICE_SUMMARY_TTL_MS,
    summary,
  });
  return summary;
}

/** Drop every cached summary; used by tests after changing dream state. */
export function resetDreamDeviceSummaryCache(): void {
  dreamSummaryByAgent.clear();
}
