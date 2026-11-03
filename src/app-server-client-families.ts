/**
 * Additive command-family wrappers for {@link AppServerClient} (M5-A + F-07).
 *
 * The entry module keeps the socket plumbing and the core protocol helpers; the
 * per-family wrappers live here and only name the discriminant and response
 * type. `AppServerClient` implements the abstract `requestCommand` seam, so the
 * public method surface is unchanged and this module stays free of socket
 * details.
 */
import type {
  AppServerCommandBody,
  AppServerFamilyCommandBody,
  AppServerFamilyCommandOptions,
} from "./app-server-client-shared";
import type {
  CompactionCancelCommand,
  CompactionCancelResponseMessage,
  CompactionCommitCommand,
  CompactionCommitResponseMessage,
  CompactionPrepareCommand,
  CompactionPrepareResponseMessage,
  CronAddCommand,
  CronAddResponseMessage,
  CronDeleteAllCommand,
  CronDeleteAllResponseMessage,
  CronDeleteCommand,
  CronDeleteResponseMessage,
  CronGetCommand,
  CronGetResponseMessage,
  CronListCommand,
  CronListResponseMessage,
  CronPauseCommand,
  CronPauseResponseMessage,
  CronResumeCommand,
  CronResumeResponseMessage,
  CronRunsCommand,
  CronRunsResponseMessage,
  CronTriggerCommand,
  CronTriggerResponseMessage,
  CronUpdateCommand,
  CronUpdateResponseMessage,
  DreamNoteAppendCommand,
  DreamNoteAppendResponseMessage,
  DreamNoteRemoveCommand,
  DreamNoteRemoveResponseMessage,
  DreamNotesListCommand,
  DreamNotesListResponseMessage,
  DreamRunCommand,
  DreamRunResponseMessage,
  DreamStatusCommand,
  DreamStatusResponseMessage,
  EmbeddingBuildCommand,
  EmbeddingBuildResponseMessage,
  EmbeddingCalibrateCommand,
  EmbeddingCalibrateResponseMessage,
  EmbeddingCancelCommand,
  EmbeddingCancelResponseMessage,
  EmbeddingConfigureCommand,
  EmbeddingConfigureResponseMessage,
  EmbeddingDisableCommand,
  EmbeddingDisableResponseMessage,
  EmbeddingEnableCommand,
  EmbeddingEnableResponseMessage,
  EmbeddingResetCommand,
  EmbeddingResetResponseMessage,
  EmbeddingStatusCommand,
  EmbeddingStatusResponseMessage,
  GetDreamSettingsCommand,
  GetDreamSettingsResponseMessage,
  SetDreamSettingsCommand,
  SetDreamSettingsResponseMessage,
  UsageAggregateCommand,
  UsageAggregateResponseMessage,
  WsProtocolMessage,
} from "./types/app-server-protocol";

export abstract class AppServerClientFamilies {
  /**
   * Typed request seam shared by every family wrapper. `AppServerClient`
   * implements it: it owns request-id allocation and response correlation, so
   * the wrappers below stay one discriminant each.
   */
  abstract requestCommand<TMessage extends WsProtocolMessage>(
    command: AppServerCommandBody,
    expectedType: TMessage["type"],
    options?: AppServerFamilyCommandOptions<TMessage>,
  ): Promise<TMessage>;

  // ── M5-A additive families: cron, dream, compaction, usage ─────────

  cronList(
    command: AppServerFamilyCommandBody<CronListCommand> = {},
    options: AppServerFamilyCommandOptions<CronListResponseMessage> = {},
  ): Promise<CronListResponseMessage> {
    return this.requestCommand<CronListResponseMessage>(
      { type: "cron_list", ...command },
      "cron_list_response",
      options,
    );
  }

  cronGet(
    command: AppServerFamilyCommandBody<CronGetCommand>,
    options: AppServerFamilyCommandOptions<CronGetResponseMessage> = {},
  ): Promise<CronGetResponseMessage> {
    return this.requestCommand<CronGetResponseMessage>(
      { type: "cron_get", ...command },
      "cron_get_response",
      options,
    );
  }

  cronAdd(
    command: AppServerFamilyCommandBody<CronAddCommand>,
    options: AppServerFamilyCommandOptions<CronAddResponseMessage> = {},
  ): Promise<CronAddResponseMessage> {
    return this.requestCommand<CronAddResponseMessage>(
      { type: "cron_add", ...command },
      "cron_add_response",
      options,
    );
  }

  cronUpdate(
    command: AppServerFamilyCommandBody<CronUpdateCommand>,
    options: AppServerFamilyCommandOptions<CronUpdateResponseMessage> = {},
  ): Promise<CronUpdateResponseMessage> {
    return this.requestCommand<CronUpdateResponseMessage>(
      { type: "cron_update", ...command },
      "cron_update_response",
      options,
    );
  }

  cronDelete(
    command: AppServerFamilyCommandBody<CronDeleteCommand>,
    options: AppServerFamilyCommandOptions<CronDeleteResponseMessage> = {},
  ): Promise<CronDeleteResponseMessage> {
    return this.requestCommand<CronDeleteResponseMessage>(
      { type: "cron_delete", ...command },
      "cron_delete_response",
      options,
    );
  }

  cronDeleteAll(
    command: AppServerFamilyCommandBody<CronDeleteAllCommand>,
    options: AppServerFamilyCommandOptions<CronDeleteAllResponseMessage> = {},
  ): Promise<CronDeleteAllResponseMessage> {
    return this.requestCommand<CronDeleteAllResponseMessage>(
      { type: "cron_delete_all", ...command },
      "cron_delete_all_response",
      options,
    );
  }

  cronRuns(
    command: AppServerFamilyCommandBody<CronRunsCommand>,
    options: AppServerFamilyCommandOptions<CronRunsResponseMessage> = {},
  ): Promise<CronRunsResponseMessage> {
    return this.requestCommand<CronRunsResponseMessage>(
      { type: "cron_runs", ...command },
      "cron_runs_response",
      options,
    );
  }

  cronTrigger(
    command: AppServerFamilyCommandBody<CronTriggerCommand>,
    options: AppServerFamilyCommandOptions<CronTriggerResponseMessage> = {},
  ): Promise<CronTriggerResponseMessage> {
    return this.requestCommand<CronTriggerResponseMessage>(
      { type: "cron_trigger", ...command },
      "cron_trigger_response",
      options,
    );
  }

  cronPause(
    command: AppServerFamilyCommandBody<CronPauseCommand>,
    options: AppServerFamilyCommandOptions<CronPauseResponseMessage> = {},
  ): Promise<CronPauseResponseMessage> {
    return this.requestCommand<CronPauseResponseMessage>(
      { type: "cron_pause", ...command },
      "cron_pause_response",
      options,
    );
  }

  cronResume(
    command: AppServerFamilyCommandBody<CronResumeCommand>,
    options: AppServerFamilyCommandOptions<CronResumeResponseMessage> = {},
  ): Promise<CronResumeResponseMessage> {
    return this.requestCommand<CronResumeResponseMessage>(
      { type: "cron_resume", ...command },
      "cron_resume_response",
      options,
    );
  }

  dreamStatus(
    command: AppServerFamilyCommandBody<DreamStatusCommand>,
    options: AppServerFamilyCommandOptions<DreamStatusResponseMessage> = {},
  ): Promise<DreamStatusResponseMessage> {
    return this.requestCommand<DreamStatusResponseMessage>(
      { type: "dream_status", ...command },
      "dream_status_response",
      options,
    );
  }

  dreamRun(
    command: AppServerFamilyCommandBody<DreamRunCommand>,
    options: AppServerFamilyCommandOptions<DreamRunResponseMessage> = {},
  ): Promise<DreamRunResponseMessage> {
    return this.requestCommand<DreamRunResponseMessage>(
      { type: "dream_run", ...command },
      "dream_run_response",
      options,
    );
  }

  getDreamSettings(
    command: AppServerFamilyCommandBody<GetDreamSettingsCommand>,
    options: AppServerFamilyCommandOptions<GetDreamSettingsResponseMessage> = {},
  ): Promise<GetDreamSettingsResponseMessage> {
    return this.requestCommand<GetDreamSettingsResponseMessage>(
      { type: "get_dream_settings", ...command },
      "get_dream_settings_response",
      options,
    );
  }

  setDreamSettings(
    command: AppServerFamilyCommandBody<SetDreamSettingsCommand>,
    options: AppServerFamilyCommandOptions<SetDreamSettingsResponseMessage> = {},
  ): Promise<SetDreamSettingsResponseMessage> {
    return this.requestCommand<SetDreamSettingsResponseMessage>(
      { type: "set_dream_settings", ...command },
      "set_dream_settings_response",
      options,
    );
  }

  dreamNoteAppend(
    command: AppServerFamilyCommandBody<DreamNoteAppendCommand>,
    options: AppServerFamilyCommandOptions<DreamNoteAppendResponseMessage> = {},
  ): Promise<DreamNoteAppendResponseMessage> {
    return this.requestCommand<DreamNoteAppendResponseMessage>(
      { type: "dream_note_append", ...command },
      "dream_note_append_response",
      options,
    );
  }

  dreamNotesList(
    command: AppServerFamilyCommandBody<DreamNotesListCommand>,
    options: AppServerFamilyCommandOptions<DreamNotesListResponseMessage> = {},
  ): Promise<DreamNotesListResponseMessage> {
    return this.requestCommand<DreamNotesListResponseMessage>(
      { type: "dream_notes_list", ...command },
      "dream_notes_list_response",
      options,
    );
  }

  dreamNoteRemove(
    command: AppServerFamilyCommandBody<DreamNoteRemoveCommand>,
    options: AppServerFamilyCommandOptions<DreamNoteRemoveResponseMessage> = {},
  ): Promise<DreamNoteRemoveResponseMessage> {
    return this.requestCommand<DreamNoteRemoveResponseMessage>(
      { type: "dream_note_remove", ...command },
      "dream_note_remove_response",
      options,
    );
  }

  compactionPrepare(
    command: AppServerFamilyCommandBody<CompactionPrepareCommand>,
    options: AppServerFamilyCommandOptions<CompactionPrepareResponseMessage> = {},
  ): Promise<CompactionPrepareResponseMessage> {
    return this.requestCommand<CompactionPrepareResponseMessage>(
      { type: "compaction_prepare", ...command },
      "compaction_prepare_response",
      options,
    );
  }

  compactionCommit(
    command: AppServerFamilyCommandBody<CompactionCommitCommand>,
    options: AppServerFamilyCommandOptions<CompactionCommitResponseMessage> = {},
  ): Promise<CompactionCommitResponseMessage> {
    return this.requestCommand<CompactionCommitResponseMessage>(
      { type: "compaction_commit", ...command },
      "compaction_commit_response",
      options,
    );
  }

  compactionCancel(
    command: AppServerFamilyCommandBody<CompactionCancelCommand>,
    options: AppServerFamilyCommandOptions<CompactionCancelResponseMessage> = {},
  ): Promise<CompactionCancelResponseMessage> {
    return this.requestCommand<CompactionCancelResponseMessage>(
      { type: "compaction_cancel", ...command },
      "compaction_cancel_response",
      options,
    );
  }

  usageAggregate(
    command: AppServerFamilyCommandBody<UsageAggregateCommand>,
    options: AppServerFamilyCommandOptions<UsageAggregateResponseMessage> = {},
  ): Promise<UsageAggregateResponseMessage> {
    return this.requestCommand<UsageAggregateResponseMessage>(
      { type: "usage_aggregate", ...command },
      "usage_aggregate_response",
      options,
    );
  }

  // ── F-07 embedding family (D1); the handler is the W2 D2 package ───

  embeddingStatus(
    command: AppServerFamilyCommandBody<EmbeddingStatusCommand>,
    options: AppServerFamilyCommandOptions<EmbeddingStatusResponseMessage> = {},
  ): Promise<EmbeddingStatusResponseMessage> {
    return this.requestCommand<EmbeddingStatusResponseMessage>(
      { type: "embedding_status", ...command },
      "embedding_status_response",
      options,
    );
  }

  embeddingConfigure(
    command: AppServerFamilyCommandBody<EmbeddingConfigureCommand>,
    options: AppServerFamilyCommandOptions<EmbeddingConfigureResponseMessage> = {},
  ): Promise<EmbeddingConfigureResponseMessage> {
    return this.requestCommand<EmbeddingConfigureResponseMessage>(
      { type: "embedding_configure", ...command },
      "embedding_configure_response",
      options,
    );
  }

  embeddingEnable(
    command: AppServerFamilyCommandBody<EmbeddingEnableCommand>,
    options: AppServerFamilyCommandOptions<EmbeddingEnableResponseMessage> = {},
  ): Promise<EmbeddingEnableResponseMessage> {
    return this.requestCommand<EmbeddingEnableResponseMessage>(
      { type: "embedding_enable", ...command },
      "embedding_enable_response",
      options,
    );
  }

  embeddingDisable(
    command: AppServerFamilyCommandBody<EmbeddingDisableCommand>,
    options: AppServerFamilyCommandOptions<EmbeddingDisableResponseMessage> = {},
  ): Promise<EmbeddingDisableResponseMessage> {
    return this.requestCommand<EmbeddingDisableResponseMessage>(
      { type: "embedding_disable", ...command },
      "embedding_disable_response",
      options,
    );
  }

  embeddingBuild(
    command: AppServerFamilyCommandBody<EmbeddingBuildCommand>,
    options: AppServerFamilyCommandOptions<EmbeddingBuildResponseMessage> = {},
  ): Promise<EmbeddingBuildResponseMessage> {
    return this.requestCommand<EmbeddingBuildResponseMessage>(
      { type: "embedding_build", ...command },
      "embedding_build_response",
      options,
    );
  }

  embeddingCancel(
    command: AppServerFamilyCommandBody<EmbeddingCancelCommand>,
    options: AppServerFamilyCommandOptions<EmbeddingCancelResponseMessage> = {},
  ): Promise<EmbeddingCancelResponseMessage> {
    return this.requestCommand<EmbeddingCancelResponseMessage>(
      { type: "embedding_cancel", ...command },
      "embedding_cancel_response",
      options,
    );
  }

  embeddingReset(
    command: AppServerFamilyCommandBody<EmbeddingResetCommand>,
    options: AppServerFamilyCommandOptions<EmbeddingResetResponseMessage> = {},
  ): Promise<EmbeddingResetResponseMessage> {
    return this.requestCommand<EmbeddingResetResponseMessage>(
      { type: "embedding_reset", ...command },
      "embedding_reset_response",
      options,
    );
  }

  embeddingCalibrate(
    command: AppServerFamilyCommandBody<EmbeddingCalibrateCommand>,
    options: AppServerFamilyCommandOptions<EmbeddingCalibrateResponseMessage> = {},
  ): Promise<EmbeddingCalibrateResponseMessage> {
    return this.requestCommand<EmbeddingCalibrateResponseMessage>(
      { type: "embedding_calibrate", ...command },
      "embedding_calibrate_response",
      options,
    );
  }
}
