/**
 * What the Usage screens and the rail read out of the ledger.
 *
 * The aggregation lives here, beside the ledger, rather than in the components
 * for one reason: these numbers are the ones a person checks against their bill,
 * and they are much easier to trust when they are a pure function over records
 * than when they are spread through a render. It also keeps **one** definition
 * of "today" — the rail and the page used to be able to tally it twice, which is
 * the drift this whole layer exists to prevent (docs/38 §6.5).
 *
 * Definitions the screens must not re-invent:
 * - **tokens** is all four billed buckets added up (miss + hit + write + out);
 * - **cost** is absent, not zero, when no record in scope carries one — the
 *   ledger omits it for models with no price (docs/38 §14.7 #1);
 * - **cache rate** is input-only: `cachedInput / (prompt + cachedInput)`, the
 *   same ratio the ledger stores per turn (§14.7 #3);
 * - **streak** counts consecutive days with at least one turn, ending today.
 *   A streak that would end *today* is not broken until today is over, so when
 *   today is empty the count starts from yesterday.
 */

import { type UsageRecord, usageDayKey } from "@/usage/ledger";
import {
  addUsageCost,
  emptyUsageCost,
  type UsageCost,
} from "@/utils/usage-cost";

/**
 * One scope's numbers, buckets kept apart.
 *
 * The four buckets are the ledger's own split and they are **mutually
 * exclusive** (§14.8), so they add up: `tokens` is their sum and a page that
 * shows a share per bucket can use one denominator. `prompt` is the *miss*
 * count here, not all input — the rail says `miss`, the detail screen says
 * `Input miss`, and neither means "input".
 */
export interface UsageTotalsView {
  tokens: number;
  turns: number;
  prompt: number;
  cachedInput: number;
  cacheWrite: number;
  completion: number;
  /** `undefined` when nothing in scope was priced. */
  cost?: number;
  costBreakdown: UsageCost;
}

export interface UsageSummary {
  totals: UsageTotalsView;
  today: UsageTotalsView & {
    /** `cachedInput / (prompt + cachedInput)` for today, when it has input. */
    cacheHitRate?: number;
  };
  /** Consecutive active days ending today (or yesterday, see above). */
  streakDays: number;
  /** `YYYY-MM-DD` of the first and last record; `undefined` when empty. */
  firstDay?: string;
  lastDay?: string;
  /** Records folded in; the screens say "no data yet" when this is 0. */
  recordCount: number;
}

const TOKEN_FIELDS = [
  "prompt",
  "cachedInput",
  "cacheWrite",
  "completion",
] as const;

interface Bucket {
  prompt: number;
  cachedInput: number;
  cacheWrite: number;
  completion: number;
}

function emptyBucket(): Bucket {
  return { prompt: 0, cachedInput: 0, cacheWrite: 0, completion: 0 };
}

function addToBucket(bucket: Bucket, record: UsageRecord): void {
  for (const field of TOKEN_FIELDS) bucket[field] += record[field];
}

function bucketTokens(bucket: Bucket): number {
  return TOKEN_FIELDS.reduce((total, field) => total + bucket[field], 0);
}

function totalsView(
  bucket: Bucket,
  turns: number,
  cost: UsageCost,
  priced: boolean,
): UsageTotalsView {
  return {
    tokens: bucketTokens(bucket),
    turns,
    prompt: bucket.prompt,
    cachedInput: bucket.cachedInput,
    cacheWrite: bucket.cacheWrite,
    completion: bucket.completion,
    cost: priced ? cost.total : undefined,
    costBreakdown: cost,
  };
}

/** Fold records into the totals the screens show. */
export function summarizeUsage(
  records: readonly UsageRecord[],
  now: Date = new Date(),
): UsageSummary {
  const all = emptyBucket();
  const todayBucket = emptyBucket();
  const allCost = emptyUsageCost();
  const todayCost = emptyUsageCost();
  let allTurns = 0;
  let todayTurns = 0;
  let sawCost = false;
  let sawTodayCost = false;
  const todayKey = usageDayKey(now);
  const activeDays = new Set<string>();

  for (const record of records) {
    addToBucket(all, record);
    allTurns += 1;
    activeDays.add(usageDayKey(record.tsHour));
    if (record.cost) {
      sawCost = true;
      addUsageCost(allCost, record.cost);
    }
    if (usageDayKey(record.tsHour) === todayKey) {
      addToBucket(todayBucket, record);
      todayTurns += 1;
      if (record.cost) {
        sawTodayCost = true;
        addUsageCost(todayCost, record.cost);
      }
    }
  }

  const todayInput = todayBucket.prompt + todayBucket.cachedInput;
  const summary: UsageSummary = {
    totals: totalsView(all, allTurns, allCost, sawCost),
    today: {
      ...totalsView(todayBucket, todayTurns, todayCost, sawTodayCost),
      cacheHitRate:
        todayInput > 0 ? todayBucket.cachedInput / todayInput : undefined,
    },
    streakDays: countStreak(activeDays, now),
    recordCount: records.length,
  };
  const days = [...activeDays].sort();
  if (days.length > 0) {
    summary.firstDay = days[0];
    summary.lastDay = days.at(-1);
  }
  return summary;
}

/** Consecutive active days ending today, or ending yesterday when today is quiet. */
export function countStreak(activeDays: Set<string>, now: Date): number {
  const cursor = new Date(now.getTime());
  cursor.setHours(0, 0, 0, 0);
  if (!activeDays.has(usageDayKey(cursor))) {
    // Today has not happened yet, so yesterday is still the streak's end.
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while (activeDays.has(usageDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
