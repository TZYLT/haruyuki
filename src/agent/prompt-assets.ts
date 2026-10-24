// Additional system prompts for /system command

import approvalRecoveryAlert from "./prompts/approval_recovery_alert.txt";
import haruyukiMemfsPrompt from "./prompts/haruyuki.md";
import haruyukiLocalMemfsPrompt from "./prompts/haruyuki_local_memfs.md";
import haruyukiNoMemfsPrompt from "./prompts/haruyuki_no_memfs.md";
import haruyukiRootMemfsPrompt from "./prompts/haruyuki_root_memfs.md";
import haruyukiTopicMarkingPrompt from "./prompts/haruyuki_topic_marking.md";
import humanPrompt from "./prompts/human.mdx";
import humanCodingPrompt from "./prompts/human_coding.mdx";
import humanKawaiiPrompt from "./prompts/human_kawaii.mdx";
import humanLinusPrompt from "./prompts/human_linus.mdx";
import humanMemoPrompt from "./prompts/human_memo.mdx";
import humanTutorialPrompt from "./prompts/human_tutorial.mdx";
import interruptRecoveryAlert from "./prompts/interrupt_recovery_alert.txt";
import memoryFilesystemPrompt from "./prompts/memory_filesystem.mdx";
import onboardingPrompt from "./prompts/onboarding.mdx";
import onboardingLocalPrompt from "./prompts/onboarding_local.mdx";
import personaPrompt from "./prompts/persona.mdx";
import personaBlankPrompt from "./prompts/persona_blank.mdx";
import personaCodingPrompt from "./prompts/persona_coding.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import personaLinusPrompt from "./prompts/persona_linus.mdx";
import personaMemoPrompt from "./prompts/persona_memo.mdx";
import personaTutorialPrompt from "./prompts/persona_tutorial.mdx";
import projectPrompt from "./prompts/project.mdx";
import skillCreatorModePrompt from "./prompts/skill_creator_mode.md";
import sourceClaudePrompt from "./prompts/source_claude.md";
import sourceCodexPrompt from "./prompts/source_codex.md";
import sourceGeminiPrompt from "./prompts/source_gemini.md";

import stylePrompt from "./prompts/style.mdx";

export const SYSTEM_PROMPT = haruyukiNoMemfsPrompt;

export const SKILL_CREATOR_PROMPT = skillCreatorModePrompt;
export const APPROVAL_RECOVERY_PROMPT = approvalRecoveryAlert;
export const INTERRUPT_RECOVERY_ALERT = interruptRecoveryAlert;

/**
 * Appended by the local backend's compiler while agent topic marking is on, so
 * the guidance disappears with the tool declaration when it is switched off.
 */
export const TOPIC_MARKING_PROMPT = haruyukiTopicMarkingPrompt;

export const MEMORY_PROMPTS: Record<string, string> = {
  "persona.mdx": personaPrompt,
  "persona_blank.mdx": personaBlankPrompt,
  "persona_coding.mdx": personaCodingPrompt,
  "persona_kawaii.mdx": personaKawaiiPrompt,
  "persona_linus.mdx": personaLinusPrompt,
  "persona_memo.mdx": personaMemoPrompt,
  "persona_tutorial.mdx": personaTutorialPrompt,
  "human.mdx": humanPrompt,
  "human_coding.mdx": humanCodingPrompt,
  "human_kawaii.mdx": humanKawaiiPrompt,
  "human_linus.mdx": humanLinusPrompt,
  "human_memo.mdx": humanMemoPrompt,
  "human_tutorial.mdx": humanTutorialPrompt,
  "project.mdx": projectPrompt,

  "memory_filesystem.mdx": memoryFilesystemPrompt,
  "onboarding.mdx": onboardingPrompt,
  "onboarding_local.mdx": onboardingLocalPrompt,
  "style.mdx": stylePrompt,
};

// System prompt options for /system command
export interface SystemPromptOption {
  id: string;
  label: string;
  description: string;
  content: string;
  memfsContent?: string;
  rootMemfsContent?: string;
  localMemfsContent?: string;
  isDefault?: boolean;
  isFeatured?: boolean;
}

export const SYSTEM_PROMPTS: SystemPromptOption[] = [
  {
    id: "default",
    label: "Default",
    description: "Alias for haruyuki",
    content: haruyukiNoMemfsPrompt,
    memfsContent: haruyukiMemfsPrompt,
    rootMemfsContent: haruyukiRootMemfsPrompt,
    localMemfsContent: haruyukiLocalMemfsPrompt,
    isDefault: true,
    isFeatured: true,
  },
  {
    id: "letta",
    label: "Haruyuki",
    description: "Full Haruyuki system prompt",
    content: haruyukiNoMemfsPrompt,
    memfsContent: haruyukiMemfsPrompt,
    rootMemfsContent: haruyukiRootMemfsPrompt,
    localMemfsContent: haruyukiLocalMemfsPrompt,
    isFeatured: true,
  },
  {
    id: "source-claude",
    label: "Claude Code",
    description: "Source-faithful Claude Code prompt (for benchmarking)",
    content: sourceClaudePrompt,
  },
  {
    id: "source-codex",
    label: "Codex",
    description: "Source-faithful OpenAI Codex prompt (for benchmarking)",
    content: sourceCodexPrompt,
  },
  {
    id: "source-gemini",
    label: "Gemini CLI",
    description: "Source-faithful Gemini CLI prompt (for benchmarking)",
    content: sourceGeminiPrompt,
  },
];

export type MemoryPromptMode =
  | "standard"
  | "memfs"
  | "root-memfs"
  | "local-memfs";

export function getSystemPromptVariantContents(
  prompt: SystemPromptOption,
): string[] {
  return [
    prompt.content,
    prompt.memfsContent,
    prompt.rootMemfsContent,
    prompt.localMemfsContent,
  ].filter((content): content is string => typeof content === "string");
}

/**
 * Check if a preset ID exists in SYSTEM_PROMPTS.
 */
export function isKnownPreset(id: string): boolean {
  return SYSTEM_PROMPTS.some((p) => p.id === id);
}

/**
 * Deterministic rebuild of a system prompt from a known preset + memory mode.
 * Throws on unknown preset (prevents stale/renamed presets from silently rewriting prompts).
 */
export function buildSystemPrompt(
  presetId: string,
  memoryMode: MemoryPromptMode,
): string {
  const preset = SYSTEM_PROMPTS.find((p) => p.id === presetId);
  if (!preset) {
    throw new Error(
      `Unknown preset "${presetId}" — cannot rebuild system prompt`,
    );
  }
  if (memoryMode === "local-memfs") {
    return (
      preset.localMemfsContent ??
      preset.memfsContent ??
      preset.content
    ).trim();
  }
  if (memoryMode === "root-memfs") {
    return (
      preset.rootMemfsContent ??
      preset.memfsContent ??
      preset.content
    ).trim();
  }
  if (memoryMode === "memfs") {
    return (preset.memfsContent ?? preset.content).trim();
  }

  return preset.content.trim();
}

/**
 * Returns true if the agent is not on the current default preset
 * and would benefit from switching to `/system default`.
 */
export function shouldRecommendDefaultPrompt(
  currentPrompt: string,
  memoryMode: MemoryPromptMode,
): boolean {
  const defaultPrompt = buildSystemPrompt("default", memoryMode);
  return currentPrompt !== defaultPrompt;
}
