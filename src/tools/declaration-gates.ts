/**
 * Gates on the *declared* tool payload (`client_tools`).
 *
 * Two optional built-in tool families are declared only under some conditions:
 * the worktree pair (a user setting) and the topic channel — the `TopicMark`
 * writer together with its `TopicQuery` reader (a user setting plus the local
 * backend). Both filters live here rather than in `tools/manager.ts` because that
 * file is pinned by the source-size ratchet, and because "which optional tools are
 * declared" is one responsibility worth reading in one place.
 *
 * Declaration is deliberately separate from execution: the declaration is frozen
 * into the conversation prefix (⑤), so a tool can vanish from the payload while
 * still being resolvable for a turn or two. A filter here must leave the tool in
 * the execution registry, or a stale declaration would fail with "Tool not
 * found" instead of a reasoned refusal.
 */
import { peekBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  shouldIncludeTopicMarking,
  shouldIncludeWorktreeTool,
} from "@/settings-tool-gates";
import type { ToolName } from "./tool-definitions";
import { WORKTREE_TOOL_NAMES } from "./toolset-catalog";

/**
 * The topic channel's model-facing surface: one writer, one reader.
 *
 * They are gated together because they are one feature. The switch means "this
 * conversation does not mark topics", and a query surface left declared without
 * it advertises half a feature — there is nothing new to find, and the reader
 * exists only to read what the writer recorded.
 */
const TOPIC_MARK_TOOL_NAMES = ["TopicMark", "TopicQuery"] as const;

export function filterWorktreeTools(toolNames: ToolName[]): ToolName[] {
  if (shouldIncludeWorktreeTool()) return toolNames;
  return toolNames.filter((name) => !WORKTREE_TOOL_NAMES.has(name));
}

/**
 * Whether the declared payload may carry the topic channel: the switch is on
 * *and* the backend is local. Markers are rows in the local transcript, and the
 * cloud backend manages context server-side, so declaring the tools there would
 * only add tools that cannot do anything.
 *
 * The check deliberately does not *create* a backend: this runs while a payload is
 * being built, so an already-created backend is classified directly, and an
 * absent one falls back to the configured mode — which is always local now, so
 * it counts as local (L-12).
 */
export function shouldDeclareTopicMarkingTool(): boolean {
  if (!shouldIncludeTopicMarking()) return false;
  const existing = peekBackend();
  return !existing || existing instanceof LocalBackend;
}

/**
 * Remove the topic channel's tools from a declared registry, not from execution.
 *
 * Every name that is present is deleted from a copy; the input map is never
 * mutated in place, and is returned unchanged (same identity) when nothing was
 * removed, so a caller's cache key cannot change for a no-op.
 */
export function filterDeclaredTopicMarkingTools<T>(
  registry: Map<string, T>,
): Map<string, T> {
  if (shouldDeclareTopicMarkingTool()) return registry;
  const declared = new Map(registry);
  let removed = false;
  for (const toolName of TOPIC_MARK_TOOL_NAMES) {
    // The registry is keyed by internal tool name, and a preset (`none`) or a
    // connected-tool setup may never have declared one of the two, so absence is
    // ordinary rather than an error.
    if (declared.delete(toolName)) removed = true;
  }
  return removed ? declared : registry;
}
