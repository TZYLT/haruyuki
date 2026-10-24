import { resolveWorkingDirectory } from "@/helpers/working-directory";

export const CHDIR_USAGE = "Usage: /cd <path>";

export function parseChdirCommand(input: string): {
  command: "/cd";
  pathArg: string | null;
} | null {
  // `/cd` was removed when the command surface was consolidated: the helper
  // keeps the one name that survived, so a retired spelling cannot quietly
  // still work through it.
  const match = input.trim().match(/^(\/cd)(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const rawPath = match[2]?.trim();
  return {
    command: "/cd",
    pathArg: rawPath ? stripMatchingQuotes(rawPath) : null,
  };
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }

  return value;
}

export async function resolveChdirTarget(
  pathArg: string,
  currentWorkingDirectory: string,
): Promise<string> {
  return resolveWorkingDirectory(pathArg, currentWorkingDirectory);
}
