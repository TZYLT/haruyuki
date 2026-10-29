/**
 * Import-side autostart reminder (R-5.13.5, M5 #1).
 *
 * A package carries the schedule store but never an OS timer registration: the
 * timer points at the importing machine's launcher. Without a reminder, an
 * imported task set looks active and never fires. The warning (not an error)
 * keeps the import non-fatal, and names the one command that fixes it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAutostartStatus } from "@/cron/autostart";

/** The small slice of `AutostartStatus` this reminder needs. */
export type AutostartProbe = () => Promise<{
  registered: boolean;
  stale?: boolean;
}>;

function restoredTaskCount(schedulePath: string): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(schedulePath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return 0;
    const tasks = (parsed as { tasks?: unknown }).tasks;
    return Array.isArray(tasks) ? tasks.length : 0;
  } catch {
    // The store's own readers report corruption; the reminder stays silent.
    return 0;
  }
}

/**
 * Warn when the import restored tasks but this machine has no usable timer
 * host: no registration at all, or one that still points at an older launcher.
 */
export async function warnScheduleHostMissing(
  home: string,
  warnings: string[],
  probe?: AutostartProbe,
): Promise<void> {
  const count = restoredTaskCount(join(home, "schedules.json"));
  if (count === 0) return;
  const tasks = `${count} scheduled task${count === 1 ? "" : "s"}`;
  try {
    const status = await (probe ?? getAutostartStatus)();
    if (status.registered && status.stale !== true) return;
    warnings.push(
      status.registered
        ? `restored ${tasks}, but the autostart registration points at an older launcher path; run \`haruyuki schedule autostart on\` to refresh it.`
        : `restored ${tasks}, but no autostart timer is registered on this machine, so they only fire while a Haruyuki session is running; run \`haruyuki schedule autostart on\` to install the timer.`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(
      `restored ${tasks}, but the autostart registration could not be checked (${detail}); run \`haruyuki schedule autostart status\` and re-register if needed.`,
    );
  }
}
