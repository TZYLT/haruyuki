import { execFileSync } from "node:child_process";

/**
 * A memory repo diff can exceed `execFileSync`'s 1 MiB default: without a larger
 * buffer the call raises ENOBUFS and the caller loses data it already had.
 */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Run git in a memory repo, returning stdout. Callers own the failure policy
 * (every current caller is best-effort and swallows the error); stderr is
 * discarded so a missing revision never reaches the user as a raw git message.
 */
export function gitOutput(memoryDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: memoryDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
}
