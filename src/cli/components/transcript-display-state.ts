import {
  RECALL_DISPLAY_DEFAULT,
  type RecallDisplay,
} from "@/reminders/recall-display";

type DisplayKind = "system-reminders" | "thinking";

const expanded: Record<DisplayKind, boolean> = {
  "system-reminders": false,
  thinking: false,
};
let systemRemindersVisible = false;
/**
 * Feature ②'s display tier.
 *
 * It lives here with the rest of the transcript's display state rather than in the
 * settings record because two very different readers have to agree on it: the
 * renderer, and Ctrl+R's gate, which runs in the keyboard handler where no
 * component prop can reach. The writers are the same kind of caller that writes
 * `systemRemindersVisible` — the `/recall` command and the settings picker — and
 * the store is seeded from the saved setting when the app mounts.
 */
let recallDisplay: RecallDisplay = RECALL_DISPLAY_DEFAULT;
const listeners: Record<DisplayKind, Set<() => void>> = {
  "system-reminders": new Set(),
  thinking: new Set(),
};
const repaintListeners = new Set<() => void>();

function notifyDisplayChange(kind: DisplayKind): void {
  // Repaint listeners run first so Ink forgets the previous static transcript
  // before the changed display state remounts <Static>.
  for (const listener of repaintListeners) listener();
  for (const listener of listeners[kind]) listener();
}

export function getSystemRemindersExpanded(): boolean {
  return expanded["system-reminders"];
}

export function getSystemRemindersVisible(): boolean {
  return systemRemindersVisible;
}

/** The tier the transcript renders recall blocks with. */
export function getRecallDisplay(): RecallDisplay {
  return recallDisplay;
}

export function setRecallDisplay(tier: RecallDisplay): void {
  if (recallDisplay === tier) return;
  recallDisplay = tier;
  // A tier change alters what a committed row contains, so it needs the same
  // repaint the reminder toggle uses: the repaint listeners forget <Static>
  // before it remounts with the new text.
  notifyDisplayChange("system-reminders");
}

export function getThinkingExpanded(): boolean {
  return expanded.thinking;
}

export function subscribeToSystemReminderDisplay(
  listener: () => void,
): () => void {
  listeners["system-reminders"].add(listener);
  return () => listeners["system-reminders"].delete(listener);
}

export function subscribeToThinkingDisplay(listener: () => void): () => void {
  listeners.thinking.add(listener);
  return () => listeners.thinking.delete(listener);
}

export function subscribeToTranscriptDisplayRepaint(
  listener: () => void,
): () => void {
  repaintListeners.add(listener);
  return () => repaintListeners.delete(listener);
}

export function toggleSystemReminderDisplay(): void {
  // "Something is expandable" is not the same question as "reminders are visible":
  // a recall summary is shown by its own tier, and it must stay expandable while
  // every other reminder is hidden. Silent is the one tier with nothing to expand.
  if (!systemRemindersVisible && recallDisplay === "silent") return;
  expanded["system-reminders"] = !expanded["system-reminders"];
  notifyDisplayChange("system-reminders");
}

export function setSystemRemindersVisible(visible: boolean): void {
  if (systemRemindersVisible === visible) return;
  systemRemindersVisible = visible;
  if (!visible) expanded["system-reminders"] = false;
  notifyDisplayChange("system-reminders");
}

export function setThinkingExpanded(value: boolean): void {
  if (expanded.thinking === value) return;
  expanded.thinking = value;
  notifyDisplayChange("thinking");
}

export function toggleThinkingDisplay(): void {
  setThinkingExpanded(!expanded.thinking);
}

export function handleTranscriptDisplayShortcut(
  input: string,
  key: { ctrl: boolean },
): boolean {
  if (!key.ctrl) return false;
  if (input === "r") {
    toggleSystemReminderDisplay();
    return true;
  }
  if (input === "t") {
    toggleThinkingDisplay();
    return true;
  }
  return false;
}
