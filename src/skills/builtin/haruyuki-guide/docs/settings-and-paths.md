---
title: Paths, settings, environment, and secrets
description: Where this build keeps its state, which file wins when settings disagree, and which environment variables actually change behavior.
applies_to:
  backends: [local]
  interfaces: [cli, desktop, sdk]
---

# Paths, settings, environment, and secrets

## Two roots, and only one of them is overridable

| Scope | Path | Resolver |
| --- | --- | --- |
| User-level | `~/.haruyuki/...` | `appHomeRoot()` / `appHomePath()` — `src/utils/app-paths.ts:88-93`, `src/utils/app-paths.ts:103-114` |
| Project-level | `<repo>/.haruyuki/...` | `projectAppHomePath()` — `src/utils/app-paths.ts:120-125` |

- `APP_DIR_NAME` is `".haruyuki"` — `src/utils/app-paths.ts:20`. Read it through
  `appHomeDirName()` where only the segment is needed —
  `src/utils/app-paths.ts:44-46`.
- Home resolution is `HOME`, then `USERPROFILE`, then `os.homedir()` —
  `src/utils/app-paths.ts:39-41`.
- **`HARUYUKI_HOME` replaces the user-level root outright**, and it is read on
  every call rather than captured once, so a runtime change is honored —
  `src/utils/app-paths.ts:78-82`, `src/utils/app-paths.ts:84-93`.
- **`projectAppHomePath` deliberately ignores `HARUYUKI_HOME`.** Its signature
  takes no environment at all — `src/utils/app-paths.ts:120-125` — because a
  project's own `.haruyuki/` belongs to the project. Passing a repository as the
  home argument to `appHomePath` would silently relocate project settings,
  permission rules, and managed worktrees.

### `HARUYUKI_HOME` does not cover everything

Some paths are built from the OS home directory directly and therefore do **not**
move when `HARUYUKI_HOME` is set. A grep for `join(homedir(), APP_DIR_NAME, …)`
finds these:

| Path | Source |
| --- | --- |
| `~/.haruyuki/logs/feedback.jsonl` | `src/telemetry/local-feedback-log.ts:20` |
| `~/.haruyuki/logs/boundary-errors.jsonl` | `src/telemetry/boundary-error-log.ts:18` |
| `~/.haruyuki/logs/debug/…` | `src/utils/debug.ts:69` |
| `~/.haruyuki/viewers/` | `src/web/generate-memory-viewer.ts:45`, `src/web/generate-diff-viewer.ts:20` |
| `~/.haruyuki/artifacts/` | `src/tools/impl/artifact-files.ts:48` (overridable with `HARUYUKI_ARTIFACTS_DIR`, `src/tools/impl/artifact-files.ts:46`) |
| `~/.haruyuki/channels/` | `src/channels/config.ts:36` |
| `~/.haruyuki/workflows/executions/` | `src/tools/workflow/journal.ts:41` |
| `~/.haruyuki/cache/` (model catalog) | `src/agent/remote-model-catalog.ts:49` |
| `~/.haruyuki/bin/` (fd, ripgrep) | `src/cli/helpers/file-autocomplete.ts:277`, `src/tools/impl/ripgrep-manager.ts:75` |
| `~/.haruyuki/settings.json` (second implementation) | `src/settings.ts:57` |

Several of those are module-level constants, so they are also resolved at import
time rather than per call. When a question is "where did this file go", check
both patterns before answering — the harness root alone is not the answer.

Transcripts are a third case: `LETTA_TRANSCRIPT_ROOT` overrides them, otherwise
`~/.haruyuki/transcripts` is built the same literal way —
`src/utils/transcript-paths.ts:6-22`.

## Inside the harness root

`APP_SUBDIRS` is the name list — `src/utils/app-paths.ts:49-70`:

| Key | Directory | Used for |
| --- | --- | --- |
| `agents` | `agents/` | per-agent memory and confinement root |
| `artifacts` | `artifacts/` | generated artifacts |
| `bin` | `bin/` | downloaded helper binaries |
| `cache` | `cache/` | model catalog cache |
| `channels` | `channels/` | channel runtime state and accounts |
| `commands` | `commands/` | custom slash commands |
| `extensions` | `extensions/` | legacy extensions |
| `logs` | `logs/` | feedback, boundary errors, debug output |
| `modCache` | `mod-cache/` | compiled mod cache |
| `mods` | `mods/` | user mods (preferred over `extensions`) |
| `plans` | `plans/` | declared but with no consumer in this repo |
| `skills` | `skills/` | global skills |
| `transcripts` | `transcripts/` | reflection transcripts |
| `viewers` | `viewers/` | generated HTML viewers |
| `workflows` | `workflows/` | workflow execution journal |
| `worktrees` | `worktrees/` | managed worktrees |
| `localBackend` | `lc-local-backend/` | the local backend storage root |
| `settingsFile` | `settings.json` | global settings |
| `localSettingsFile` | `settings.local.json` | project-local settings |
| `desktopPreferencesFile` | `desktop_preferences.json` | declared but with no consumer in this repo |

## Settings: three files, and what actually merges

| Level | File | Loader |
| --- | --- | --- |
| Global | `~/.haruyuki/settings.json` | `src/settings-manager.ts:976-979` |
| Project | `<repo>/.haruyuki/settings.json` | `src/settings-manager.ts:981-983` |
| Local | `<repo>/.haruyuki/settings.local.json` | `src/settings-manager.ts:994-996` |
| Legacy | `~/.haruyuki/settings.json` and `./.haruyuki/settings.local.json` via a second implementation | `src/settings.ts:57`, `src/settings.ts:127` |

The three files are **not** automatically merged into one object. What each
loader does:

- `initialize()` reads the global file only, writing defaults when it is absent —
  `src/settings-manager.ts:387-401` — and merges onto the defaults shallowly —
  `src/settings-manager.ts:428-431`. Writes persist the intersection of managed
  keys and dirty keys — `src/settings-manager.ts:906-924`.
- The project file is read through a **field whitelist**: only `hooks` and
  `windowTitle` are picked out of it —
  `src/settings-manager.ts:797-800`. Adding a project-scoped setting means
  extending that whitelist.
- The local file is read as-is — `src/settings-manager.ts:1001-1028`.
- Local-over-global precedence is applied by the caller, not by the manager —
  `src/settings-manager.ts:1411-1421`.
- The one place with a genuine ordered file chain is permission rules: legacy
  user, then user, then project, then local —
  `src/permissions/loader.ts:70-79`.

There is a guard for the case where the working directory *is* the home
directory, which would otherwise make the project and global settings files the
same path — `src/settings-manager.ts:985-992`.

Adding a configurable setting touches the `Settings` interface, the
`ProjectSettings` and `LocalProjectSettings` interfaces, the three default
objects, the project whitelist, and `updateSettings` collision routing — the
interfaces are at `src/settings-manager.ts:69-116`,
`src/settings-manager.ts:143-146`, and `src/settings-manager.ts:148-164`; the
defaults at `src/settings-manager.ts:175-198`.

## `Settings.env` is not the secret store

Two mechanisms use similar syntax and are easy to conflate:

- **`Settings.env`** is a plain environment table for child processes:
  `env?: Record<string,string>` — `src/settings-manager.ts:96`. It is injected
  when spawning shell tools (only `LETTA_API_KEY` and `LETTA_BASE_URL` —
  `src/tools/impl/shell-env.ts:496-509`), and in full for headless and mod
  subprocesses — `src/cli/commands/mods.ts:700-707`. **Subagents do not receive
  it**; they get only the two auth values —
  `src/agent/subagents/manager.ts:344-350`. An API key placed here is stripped
  from the file and kept in the secret store instead —
  `src/settings-manager.ts:657-668`.
- **Agent secrets** are a per-agent store reached by `$NAME` substitution in
  shell commands. The substitution scanner accepts the plain form **and braced
  shell forms** — `src/tools/secret-substitution.ts:10-19`:

  ```text
  $API_KEY   ${API_KEY}   ${API_KEY:-}   ${#API_KEY}   ${!API_KEY}
  ```

  The value is passed as an environment variable to the command rather than
  substituted into the command text —
  `src/tools/secret-substitution.ts:21-55`.

  `haruyuki secret set --env VAR` takes a *variable name*, not a `$NAME`
  reference, because writing the reference would make the harness expand it into
  the argument list — `src/cli/subcommands/secret.ts:51-52`.

Storage for secrets is the OS keychain when available, falling back to
`<storageDir>/secrets/local-agent-secrets.json` —
`src/utils/secrets-store.ts:47-58`,
`src/utils/secrets-store.ts:144-152`. Names are upper-cased and must match
`^[A-Z_][A-Z0-9_]*$` — `src/utils/secrets-store.ts:173`,
`src/utils/secrets-store.ts:196-204`. `haruyuki secret list` prints names only —
`src/cli/subcommands/secret.ts:129-137`.

## Environment variables

The prefix is `HARUYUKI_` for this build's own variables. The ones most likely
to matter when diagnosing behavior:

| Variable | Effect | Source |
| --- | --- | --- |
| `HARUYUKI_HOME` | Replaces the user-level harness root | `src/utils/app-paths.ts:23`, `src/utils/app-paths.ts:88-93` |
| `LETTA_LOCAL_BACKEND_DIR` | Local backend storage root, default `~/.haruyuki/lc-local-backend` | `src/utils/local-backend-paths.ts:9`, `src/utils/local-backend-paths.ts:20-28` |
| `HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL` | Namespace predicate: see below | `src/backend/local/paths.ts:14-25` |
| `HARUYUKI_FS_SANDBOX` | Filesystem sandbox switch | `src/permissions/sandbox-gate.ts:37` |
| `LETTA_SANDBOX` | Sandbox sentinel written into sandboxed children | `src/sandbox/policy.ts:47` |
| `HARUYUKI_AGENT_ID`, `HARUYUKI_CONVERSATION_ID` | Default agent and conversation for subcommands that do not take `--agent` | `src/utils/secrets-store.ts:335`, `src/tools/impl/shell-env.ts:492` |
| `LETTA_MEMORY_DIR`, `MEMORY_DIR` | Replace the computed memory root | `src/agent/memory-filesystem.ts:128` |
| `LETTA_TRANSCRIPT_ROOT` | Transcript root for reflection and memory subagents | `src/utils/transcript-paths.ts:6` |
| `HARUYUKI_MEMORY_CONSTRAINTS_UPDATE` | Required to change `.memfs.config.json` | `src/agent/memory-constraints.ts:31` |
| `HARUYUKI_MODS_DIR`, `HARUYUKI_EXTENSIONS_DIR` | Mods root overrides | `src/mods/paths.ts:5-6` |
| `HARUYUKI_DISABLE_MODS`, `HARUYUKI_DISABLE_EXTENSIONS` | Disable local mods / extensions | `src/mods/disable.ts:1-3` |
| `HARUYUKI_DEBUG` | Verbose debug output | `src/utils/debug.ts:32` |
| `HARUYUKI_DEBUG_FILE` | Redirect debug output to a file | `src/utils/debug.ts:43` |
| `HARUYUKI_CODE_TELEM` | Gates writing session debug logs at all | `src/utils/debug.ts:94-108` |
| `HARUYUKI_MEMFS_TREE_MAX_LINES` / `_CHARS` / `_CHILDREN_PER_DIR` | Memory tree render caps | `src/utils/directory-limits.ts:6-8` |
| `HARUYUKI_TEST_PARALLEL` | Unit-test worker count; `0` selects the serial runner | `scripts/run-unit-tests.cjs:132-145` |

That list is the diagnostic core, not the whole set. Names are constant-typed
throughout `src/`, so an unknown `HARUYUKI_*` name can be settled by grepping the
constant rather than the literal.

### `HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL` is a namespace predicate

It is **not** a backend switch — this build has one backend. It decides two
things and nothing else:

1. whether the settings bucket key is `local:<dir>` or the legacy
   `api.letta.com` form — `src/settings-manager.ts:228-234`,
   `src/settings-manager.ts:300-307`;
2. whether the memory root is `<storageDir>/memfs/<agentId>/memory` or
   `~/.haruyuki/agents/<agentId>/memory` —
   `src/backend/local/paths.ts:48-53`,
   `src/backend/backend.ts:356-372`.

`configureBackendMode("local")` is what sets it, and the CLI calls that on
startup — `src/backend/backend.ts:379-383`, `src/index.ts:410-413`. Clearing it
routes local pins, per-agent settings, and memory files into the legacy
namespace instead. It is also the only switch that decides whether
`LETTA_LOCAL_BACKEND_DIR` has any effect at all —
`src/agent/memory-filesystem.ts:83-89`.

### Eight names keep the `LETTA_` prefix on purpose

`LETTA_CLI_PATH` · `LETTA_LOCAL_BACKEND_DIR` · `LETTA_MEMORY_DIR` ·
`LETTA_TRANSCRIPT_ROOT` · `LETTA_SANDBOX` · `LETTA_API_KEY` ·
`LETTA_BASE_URL` · `LETTA_LOG`

`@letta-ai/letta-agent-sdk` reads these itself at runtime and `node_modules`
cannot be edited, so renaming only this side would make the SDK fall back to its
own bundled copy and compute the memory confinement writable roots from stale
names — the same silent divergence class the `.haruyuki` rename had to fix. The
reasoning and the per-name read coordinates are recorded in `CONTRIBUTING.md` §C
and `THIRD-PARTY-NOTICES.md` §5. Do not rename them.

Note that `LETTA_LOG` has no reader inside this repository's `src/`; it is a
dependency-side name.

## Local backend storage

- Default root: `~/.haruyuki/lc-local-backend`, overridable with
  `LETTA_LOCAL_BACKEND_DIR` — `src/utils/local-backend-paths.ts:5-9`.
- Settings bucket key: `` `local:${resolve(getLocalBackendStorageDir())}` `` —
  `src/settings-manager.ts:228-230`.
- Local agent ids look like `agent-local-<uuid>` —
  `src/backend/local/local-agent-record.ts:92`.
- Memory tree: `<storageDir>/memfs/<agentId>/memory` —
  `src/backend/local/paths.ts:48-53`; the cross-agent boundary is
  `<storageDir>/memfs` — `src/utils/local-backend-paths.ts:36-39`.
- Other records: `agents/<id>.json` — `src/backend/local/local-store.ts:484` —
  `conversations/<key>/conversation.json` —
  `src/backend/local/local-store.ts:2607` — and
  `conversations/<key>/messages.jsonl` —
  `src/backend/local/local-transcript.ts:87`.

## Where model and provider state lands

- Provider credentials: `<storageDir>/providers/auth.json`, mode `0700` on the
  directory and `0600` on the file —
  `src/backend/local/local-provider-auth-store.ts:88-92`,
  `src/backend/local/local-provider-auth-store.ts:113-121`.
- The agent's model and `model_settings` live in the local agent record, not in
  `settings.json` — `src/backend/local/local-agent-record.ts:76-77`. A
  conversation can override both —
  `src/backend/local/local-store.ts:831-847`.
- `settings.json` keeps presentation-level model state only:
  `preferredBackendMode` and `recentModels` (capped at 10) —
  `src/settings-manager.ts:80-82`, `src/settings-manager.ts:620-628`.
- A read-only `llm_config` shim is synthesized for compatibility; its endpoint
  is a placeholder and must not be treated as a real URL —
  `src/backend/local/local-agent-record.ts:210-225`.

## Logs

| Log | Path | Rotation |
| --- | --- | --- |
| Feedback reports | `~/.haruyuki/logs/feedback.jsonl` | 10 MB per file, 10 files — `src/telemetry/local-feedback-log.ts:23-26` |
| Boundary errors | `~/.haruyuki/logs/boundary-errors.jsonl` | same policy — `src/telemetry/boundary-error-log.ts:18-24` |
| Session debug | `~/.haruyuki/logs/debug/<agentId>/<sessionId>.log` | 10 MB per session, newest 5 sessions — `src/utils/debug.ts:7-9`, `src/utils/debug.ts:94-108` |
| Chunk logs | `~/.haruyuki/logs/chunk-logs/<agentId>/<sessionId>.jsonl` | 100 entries per file, 5 sessions per agent — `src/cli/helpers/chunk-log.ts:5-13` |
| Cron run logs | `<harness root>/runs/<jobId>.jsonl` | keeps the last 2000 lines past 2,000,000 bytes — `src/cron/run-log.ts:4-5`, `src/cron/run-log.ts:58-59` |

The rotation implementation is shared: it rotates only on reaching the cap,
renames the active file to `<basename>.1.jsonl`, shifts older files up, drops
the oldest, and never throws on a write failure —
`src/telemetry/jsonl-log.ts:58-92`.

Remember the caveat from the top of this document: the four `logs/` paths are
built from the OS home directory, so they do not follow `HARUYUKI_HOME`.
