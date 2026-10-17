import { execFileSync } from "node:child_process";

/**
 * Who the harness attributes its own git commits to.
 *
 * Memory repositories used to carry a harness-owned identity
 * (`<product name> <noreply@letta.com>`, and `<agentId>@letta.com` per agent).
 * That hardcoded domain belongs to a project this fork is not, and the identity
 * was never the operator's, so GitHub could not link the commits to anyone.
 *
 * Resolution order:
 *   1. the operator's global git config (`user.name` / `user.email`),
 *   2. a neutral fork-local fallback, so a machine with no git identity yet
 *      still produces commits instead of failing.
 *
 * An unset global identity is the common case on a fresh machine, which is why
 * the fallback exists rather than an error.
 */

/** Author/committer name used when the operator has no global `user.name`. */
export const HARNESS_GIT_FALLBACK_NAME = "Haruyuki Code";

/** Author/committer email used when the operator has no global `user.email`. */
export const HARNESS_GIT_FALLBACK_EMAIL = "noreply@haruyuki.local";

export interface HarnessGitIdentity {
  name: string;
  email: string;
}

/**
 * Read one key from the operator's global git config.
 *
 * Returns null when the key is unset (git exits 1) or git is unavailable, so
 * every failure mode degrades to the fallback rather than throwing.
 */
function readGlobalGitConfig(key: string): string | null {
  try {
    const value = execFileSync("git", ["config", "--global", "--get", key], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      // Hand the child the environment as it is *now*. Without this, Bun passes
      // the environment captured when the process started, so a caller that
      // repoints `GIT_CONFIG_GLOBAL` (or `HOME`/`USERPROFILE`) at runtime is
      // ignored and git reads the operator's real global config instead — which
      // is exactly what the cache key below exists to support. Node inherits the
      // live `process.env` by default, so this closes a Bun/Node divergence.
      env: { ...process.env },
    }).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

let cached: { key: string; identity: HarnessGitIdentity } | undefined;

/**
 * Everything that changes which file `git config --global` reads.
 *
 * Keying the memo on this keeps the common case (one identity per process) fast
 * without pinning a stale answer for tests and operators that repoint the global
 * config within a session.
 */
function globalConfigCacheKey(): string {
  return [
    process.env.GIT_CONFIG_GLOBAL,
    process.env.GIT_CONFIG_SYSTEM,
    process.env.XDG_CONFIG_HOME,
    process.env.HOME,
    process.env.USERPROFILE,
  ]
    .map((value) => value ?? "")
    .join("\u0000");
}

/**
 * Resolve the identity, shelling out to git only when the global config
 * location changed since the last call.
 */
export function harnessGitIdentity(): HarnessGitIdentity {
  const key = globalConfigCacheKey();
  if (cached?.key !== key) {
    cached = {
      key,
      identity: {
        name: readGlobalGitConfig("user.name") ?? HARNESS_GIT_FALLBACK_NAME,
        email: readGlobalGitConfig("user.email") ?? HARNESS_GIT_FALLBACK_EMAIL,
      },
    };
  }
  return cached.identity;
}

/** Drop the memoized identity. For tests that repoint the global git config. */
export function resetHarnessGitIdentityCache(): void {
  cached = undefined;
}
