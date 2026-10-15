export type ExperimentId =
  | "artifacts"
  | "conversation_titles"
  | "desktop_conversation_bootstrap"
  | "diffs"
  | "memory_palace"
  | "tui_cron"
  | "ui_v2";

export type ExperimentSource = "override" | "env" | "default";

export interface ExperimentDefinition {
  id: ExperimentId;
  label: string;
  description: string;
  envVar?: string;
}

export interface ExperimentSnapshot extends ExperimentDefinition {
  enabled: boolean;
  source: ExperimentSource;
  override: boolean | null;
}
