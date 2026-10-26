import type { LocalMemoryFormat } from "@/agent/memory-format";
import reflectionV3TaskBody from "@/agent/subagents/builtin/reflection-v3.md";

export interface ReflectionTaskMessageInput {
  /** Stable id of this run; it also lands in the fork's conversation record. */
  runId: string;
  /** `/reflect --instruction` text, if the user supplied any. */
  instruction?: string;
  memoryFormat?: LocalMemoryFormat;
}

/** Path guidance that depends on which memory layout the repo uses. */
function memoryLayoutGuidance(memoryFormat: LocalMemoryFormat | undefined) {
  if (memoryFormat === "memfs-v2") {
    return "Root Markdown files are in-context memory. Root and child `MEMORY.md` files are frontmatter-free indexes of ordinary relative links; every other memory Markdown file carries exactly `name` and `description` frontmatter. A child directory is memory only when it contains `MEMORY.md`.";
  }
  return "In-context memory is stored in the `system/` folder: editing a file there edits the primary agent's system prompt. Deferred memory lives in child directories and is reached through their indexes.";
}

/**
 * The single user message appended to a reflection fork (F-03 §5.3).
 *
 * Persona, job and writing stance come from `reflection-v3.md`; this builder
 * adds only the per-run parts — the assignment, the memory-layout line, an
 * optional user instruction and the run id. It never touches the frozen prefix:
 * system prompt, skills block, `client_tools` and model settings are inherited
 * from the fork conversation (requirement §5.3.3, §5.4.2).
 */
export function buildReflectionTaskMessage(
  input: ReflectionTaskMessageInput,
): string {
  const lines: string[] = [reflectionV3TaskBody.trim(), ""];

  lines.push(
    "## This assignment",
    "",
    "Register what is worth keeping for the long term from the conversation above. The conversation is already in your context — there is no transcript file to read (`$TRANSCRIPT_PATH` is not set, and any path you remember from another subagent does not apply).",
    "",
    memoryLayoutGuidance(input.memoryFormat),
    "",
  );

  const instruction = input.instruction?.trim();
  if (instruction) {
    lines.push(
      "## Additional instruction from the user",
      "",
      instruction,
      "",
      "Use it to focus what you look for. It does not relax the rules above: still only persist durable, memory-worthy content, and never store transient task state or secrets.",
      "",
    );
  }

  lines.push(
    "## This run",
    "",
    `Run id: ${input.runId}`,
    "When you are finished, leave the memory repo committed and stop. Your final message is a short report for the user: what you remembered, what you changed, and what you deliberately left out.",
    "",
  );

  return lines.join("\n");
}
