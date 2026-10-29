/**
 * Frozen public surface of the schedule subsystem (F-05 M0).
 *
 * The P1 tracks (core, execution, TUI) import from here. M0 froze the names
 * below: a track fills a stub's body, and may add exports, but must not rename
 * or remove one — the other two tracks compile against them.
 */

// ── OS autostart (M4) ───────────────────────────────────────────────
export {
  getAutostartStatus,
  registerAutostart,
  unregisterAutostart,
} from "./autostart";
// ── Persisted record + CRUD facade ──────────────────────────────────
export {
  addTask,
  type CronStateChangeResult,
  deleteAllTasks,
  deleteTask,
  garbageCollect,
  getActiveTasks,
  getTask,
  legacyRunOutcomeFor,
  listTasks,
  pauseTask,
  recordTaskQueued,
  resumeTask,
  updateTask,
} from "./cron-file";
// ── Schedule math ───────────────────────────────────────────────────
export { computeJitter } from "./cron-jitter";

// ── Locking and leases ──────────────────────────────────────────────
export {
  claimSchedulerLease,
  claimTaskLease,
  hasLiveSchedulerOwner,
  heartbeatTaskLease,
  isTaskLeaseLive,
  type LockHandle,
  recoverExpiredTaskLease,
  refreshSchedulerLease,
  releaseSchedulerLease,
  releaseTaskLease,
  type TaskLeaseClaimInput,
  type TaskLeaseClaimResult,
  verifySchedulerLease,
  withLock,
} from "./cron-lease";
export {
  CRON_SIGNAL_SOURCE_ID,
  createCronSignalSource,
  ensureCronSignalSourceRegistered,
} from "./cron-signal";
// ── Storage, migration and the frozen-view adapters ─────────────────
export {
  applyScheduleTaskV2,
  emptyScheduleFile,
  getCronBackupFilePath,
  getCronFileMtime,
  getLegacyCronFilePath,
  getScheduleFileMtime,
  getScheduleFilePath,
  getScheduleTask,
  listScheduleTasks,
  type MigrationResult,
  migrateLegacyCronFile,
  normalizeScheduleTask,
  readCronFile,
  readScheduleFile,
  ScheduleStoreCorruptError,
  ScheduleStoreMigrationError,
  ScheduleStoreVersionError,
  toScheduleTaskV2,
  updateScheduleTask,
  writeScheduleFile,
} from "./cron-store";
// ── Frozen F-05 interface (M0; changes go through the Lead) ─────────
export type {
  AddTaskInput,
  AddTaskResult,
  AutostartStatus,
  CancelReason,
  CronRunOutcome,
  CronRunReason,
  CronSchedulerScope,
  CronTask,
  CronTaskStatus,
  DueOccurrence,
  FailureClass,
  PermissionTier,
  RunOutcome,
  ScheduleFileData,
  SchedulerOwner,
  ScheduleTaskV2,
  SignalEvaluation,
  SignalSource,
  SignalState,
  TaskLease,
  TaskRunnerPort,
  TaskTarget,
  TaskType,
} from "./cron-types";
export {
  cronMatchesTime,
  estimatePeriodMs,
  isValidCron,
  type ParsedAt,
  type ParsedInterval,
  parseAt,
  parseEvery,
  parseRfc3339Timestamp,
} from "./parse-interval";
export {
  runSchedulePreflight,
  type SchedulePreflightInput,
  type SchedulePreflightResult,
} from "./preflight";
export { isProcessAlive } from "./process-identity";
// ── Prompt formatting (owner: prompt.ts) ────────────────────────────
export {
  type CronPromptTiming,
  formatCronPrompt,
  formatTimezoneQualifiedIso,
  getIntendedCronOccurrence,
} from "./prompt";
// ── Run log ─────────────────────────────────────────────────────────
export {
  appendCronRunLog,
  appendCronRunLogForTask,
  type CronRunLogEntry,
  type CronRunLogPage,
  type CronRunLogStatus,
  DEFAULT_CRON_RUN_LOG_KEEP_LINES,
  DEFAULT_CRON_RUN_LOG_MAX_BYTES,
  getCronRunLogPath,
  readCronRunLogEntries,
  readCronRunLogEntriesPage,
  resolveCronRunLogPath,
  safeAppendCronRunLogForTask,
} from "./run-log";
// ── Startup summary (M1/M3) ─────────────────────────────────────────
export {
  appendRunSummaryEntry,
  markRunSummarySeen,
  type RunSummaryEntry,
  readPendingRunSummary,
} from "./run-summary";
// ── Process-local schedule events (Lead, M0.5) ──────────────────────
export {
  clearScheduleEventSubscribers,
  emitScheduleEvent,
  type ScheduleEvent,
  type ScheduleEventKind,
  type ScheduleEventListener,
  scheduleEventSubscriberCount,
  subscribeScheduleEvents,
} from "./schedule-events";
// ── Long-lived host adapter (M1) ────────────────────────────────────
export {
  CRON_SCHEDULER_SCOPE_ENV,
  isSchedulerRunning,
  resolveCronSchedulerScope,
  runCronTaskNow,
  setSchedulerTaskRunner,
  startScheduler,
  stopScheduler,
  taskMatchesCronSchedulerScope,
} from "./scheduler";
// ── Scheduler core + policy helpers (M1) ────────────────────────────
export {
  applyInvalidRecurringTask,
  classifyRunFailure,
  handleInvalidRecurringTask,
  handleMissedOneShot,
  handleTaskPreflight,
  minuteKey,
  runScheduledTaskNow,
  runSchedulerTick,
  type SchedulerTickInput,
  type SchedulerTickResult,
  shouldFireTask,
  wrapCronPrompt,
} from "./scheduler-core";
// ── Signal sources (M1) ─────────────────────────────────────────────
export {
  clearSignalSources,
  type EvaluateSignalsInput,
  type EvaluateSignalsResult,
  evaluateSignals,
  evaluateSignalsWithCursors,
  listSignalSources,
  nextSignalDueAt,
  registerSignalSource,
  unregisterSignalSource,
} from "./signal";
// ── Task execution (M2) ─────────────────────────────────────────────
export {
  isAllowedScheduledCommand,
  isScheduledTaskPreflightError,
  isTaskPermissionTier,
  type ParsedScheduledCommand,
  parseScheduledCommand,
  permissionModeForTier,
  type RunScheduledTaskInput,
  resolveTaskPermissionTier,
  resolveUnattendedApproval,
  runScheduledTask,
  runScheduledTaskWithHost,
  type ScheduledCommandContext,
  type ScheduledPromptRunResult,
  type ScheduledTaskHostPort,
  type ScheduledTaskPolicyInput,
  ScheduledTaskPreflightError,
  type ScheduledTaskRunResult,
  TARGET_BUSY_POLL_MS,
  TASK_COMMAND_WHITELIST,
} from "./task-run";
