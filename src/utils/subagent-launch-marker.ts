/** Consumed by the child entrypoint; shell commands from that child must not inherit it. */
export const SUBAGENT_LAUNCH_ENV = "HARUYUKI_SUBAGENT_LAUNCH";
export const SUBAGENT_LAUNCH_PROFILE_ENV = "HARUYUKI_SUBAGENT_LAUNCH_PROFILE";
export const SUBAGENT_NAME_ENV = "HARUYUKI_SUBAGENT_NAME";

/**
 * The parent conversation a subagent was launched from.
 *
 * Read by the child to tag its own usage ledger row with `parentSessionId`
 * (F-03 §5.16). Deliberately a plain env var rather than a CLI argument: the
 * child already receives it, and adding a flag would change the spawn contract
 * for every subagent instead of only the ones that record usage.
 */
export const PARENT_CONVERSATION_ENV = "HARUYUKI_PARENT_CONVERSATION_ID";

/**
 * Automated-usage markers for a child whose spend must be recorded by the child
 * itself (reflection now, dream/cron later — F-03 §5.16.2).
 *
 * Set only by the harness launch path that knows the run; an ordinary subagent
 * has neither, and nested launches inherit neither (see `composeSubagentChildEnv`).
 */
export const USAGE_SOURCE_ENV = "HARUYUKI_USAGE_SOURCE";
export const USAGE_RUN_ID_ENV = "HARUYUKI_USAGE_RUN_ID";

export function consumeSubagentLaunch(env: NodeJS.ProcessEnv): boolean {
  const isLaunch = env[SUBAGENT_LAUNCH_ENV] === "1";
  delete env[SUBAGENT_LAUNCH_ENV];
  return isLaunch;
}
