/**
 * Built-in cron signal source (F-05, R-5.4.1).
 *
 * M0 freeze: the signature and the source id are part of the barrel's frozen
 * export surface. M1 fills the body (occurrence = minute key / `scheduled_for`,
 * plus the "consumed" filter that makes an occurrence run at most once).
 */

import type { SignalSource } from "./cron-types";

export const CRON_SIGNAL_SOURCE_ID = "cron";

/**
 * M1 replaces the body. Kept as a factory (not a shared instance) so a tick can
 * construct the source with its own clock without mutating module state.
 */
export function createCronSignalSource(): SignalSource {
  throw new Error(
    "createCronSignalSource is not implemented yet (F-05 M1, route §3).",
  );
}
