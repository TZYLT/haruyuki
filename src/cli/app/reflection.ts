import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";

export function formatReflectionSettings(settings: ReflectionSettings): string {
  const triggers: string[] = [];
  if (settings.onCompaction) {
    triggers.push("on compaction");
  }
  if (settings.everyUserMessages > 0) {
    triggers.push(`every ${settings.everyUserMessages} user messages`);
  }
  const triggerText = triggers.length > 0 ? triggers.join(" + ") : "off";
  return `${triggerText}; timeout ${settings.timeoutMinutes} min; ${
    settings.deleteSessionOnSuccess
      ? "delete session on success"
      : "keep session on success"
  }`;
}
