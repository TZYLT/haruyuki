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
  /**
   * What the experiment is when nothing has been decided: no stored override and
   * no env var. Absent means off, which is what every experiment was until
   * `ui_v2` became the shipped shell (2026-10-23).
   *
   * The env var, when it is **set at all**, beats this: `HARUYUKI_UI_V2=0` turns
   * the full-screen shell off on a build where it is the default, and a value that
   * is set but not an accepted spelling is still read as "off" (with a hint, see
   * `rejectedExperimentEnvToggles`).
   */
  defaultEnabled?: boolean;
}

export interface ExperimentSnapshot extends ExperimentDefinition {
  enabled: boolean;
  source: ExperimentSource;
  override: boolean | null;
}
