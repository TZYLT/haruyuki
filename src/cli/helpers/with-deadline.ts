// src/cli/helpers/with-deadline.ts

/**
 * Wait for `work`, but never longer than `ms`.
 *
 * `/context` used to await a hosted endpoint with an `AbortController` and a
 * `setTimeout` that called `abort()`. That is a deadline only if the transport
 * honours the signal: a request that is stuck before `fetch` (the config/secret
 * lookup it does first) or inside a retry wrapper that drops the signal leaves the
 * command row on "Fetching context breakdown…" with no result and no error — the
 * machine reported "no output" (2026-10-23), and it went away on its own, which is
 * what a hanging socket looks like from the outside.
 *
 * This is the deadline that cannot be ignored: whatever the promise does, this
 * resolves. `undefined` means "no answer in time", which every caller here already
 * treats as "proceed without it". Errors from `work` still propagate (a 404 is a
 * fact worth surfacing; a hang is not).
 *
 * `work` is not cancelled — a promise cannot be. The caller's `AbortController`
 * remains the way to stop the request itself.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
