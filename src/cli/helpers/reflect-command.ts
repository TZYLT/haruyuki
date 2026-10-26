import { parseModCommandArgv } from "@/cli/mods/command-runtime";

/**
 * `/reflect` (and its `/dream` and `/reflection` spellings) accepts one
 * parameter. F-03 removed the cross-conversation modes — reflection always
 * reflects the current conversation — so the retired flags fail loudly with
 * the current usage instead of silently reflecting the wrong thing.
 */
export interface ReflectCommandArgs {
  instruction?: string;
}

export const REFLECT_COMMAND_USAGE = "Usage: /reflect [--instruction TEXT]";

function isFlagToken(value: string): boolean {
  return (
    value === "--instruction" ||
    value === "-i" ||
    value.startsWith("--instruction=") ||
    value === "--auto" ||
    value === "--recent" ||
    value === "--conversation" ||
    value === "--instructions"
  );
}

function rejectRetiredFlag(flag: string): never {
  throw new Error(
    `${flag} is no longer supported: reflection always reflects the current conversation. ${REFLECT_COMMAND_USAGE}`,
  );
}

export function parseReflectCommandArgs(input: string): ReflectCommandArgs {
  const trimmed = input.trim();
  const command = trimmed.split(/\s+/, 1)[0] ?? "/reflect";
  const parts = parseModCommandArgv(trimmed.slice(command.length).trim());
  if (parts.length === 0) {
    return {};
  }

  const instructions: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part === "--instruction" || part === "-i") {
      // The instruction runs to the next flag, so it keeps spaces without
      // requiring quotes.
      let end = index + 1;
      while (end < parts.length) {
        const next = parts[end];
        if (!next || isFlagToken(next)) break;
        end += 1;
      }
      const instruction = parts
        .slice(index + 1, end)
        .join(" ")
        .trim();
      if (!instruction) {
        throw new Error(REFLECT_COMMAND_USAGE);
      }
      instructions.push(instruction);
      index = end - 1;
      continue;
    }
    if (part.startsWith("--instruction=")) {
      const instruction = part.slice("--instruction=".length).trim();
      if (!instruction) {
        throw new Error(REFLECT_COMMAND_USAGE);
      }
      instructions.push(instruction);
      continue;
    }
    if (
      part === "--auto" ||
      part === "--recent" ||
      part === "--conversation" ||
      part === "--instructions"
    ) {
      rejectRetiredFlag(part);
    }
    throw new Error(`Unexpected argument "${part}". ${REFLECT_COMMAND_USAGE}`);
  }

  const instruction = instructions.join("\n").trim() || undefined;
  return { instruction };
}
