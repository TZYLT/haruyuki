---
title: Commands
description: What each subcommand and slash command actually does, the defaults it applies, and what it writes.
applies_to:
  backends: [local]
  interfaces: [cli, desktop, sdk]
---

# Commands

This document covers behavior: what a command does, what it defaults to, and
what it touches on disk. The exact flag list and the verbatim `--help` text for
every subcommand live in the generated `reference-index` document — read that
one when you need a flag you cannot remember, and read this one to know what the
command will do to the machine.

## Entry points

- `haruyuki` with no arguments resumes the last conversation for the current
  directory, in the interactive terminal UI — `src/index.ts`.
- `haruyuki -p "..."` runs one turn without a TTY, and
  `--output-format json|stream-json` changes what it prints —
  `src/cli/args.ts:116-120`, `src/cli/args.ts:150-158`.
- `haruyuki <subcommand>` runs a maintenance command and exits. The subcommand
  table is in `src/cli/subcommands/router.ts:49-105`.

Order of startup operations matters when reasoning about flags:
`configureBackendMode("local")` runs first, then `--backend` is stripped, then
subcommand dispatch happens, and only for a non-subcommand invocation are
settings initialized and the rest of the flags parsed —
`src/index.ts:413-468`, `src/index.ts:474-502`.

## Flags worth knowing before the rest

- **`--backend` accepts `local` only.** `cloud` and `api` throw with
  "Haruyuki only runs the local backend" — `src/cli/args.ts:434-447`.
- **`--no-extensions` is an alias, not a separate flag.** It is rewritten to
  `--no-mods` during preprocessing — `src/cli/args.ts:405-411`. The same
  function rewrites `--conv` to `--conversation`.
- `--help` exits 0; `--version` prints `<version> (Haruyuki)`; `--info` prints
  the working directory, skills directory, and pinned agents —
  `src/cli/args.ts:27-41`, `src/index.ts:112-192`.
- `--name <name>` resumes a pinned agent by name, case-insensitively —
  `src/cli/args.ts:72-80`.
- `--skill-sources <csv>` takes `all,bundled,global,agent,project`, defaulting
  to `all` — `src/cli/args.ts:226-234`.
- `--no-memfs` and `--memfs-startup` are hidden compatibility no-ops retained
  for old parent processes — `src/cli/args.ts:257-280`.
- Unknown flags fail with a pointer to `haruyuki --help` —
  `src/index.ts:509-514`.

The full catalog is `CLI_FLAG_CATALOG`, and `--help` is generated from it —
`src/cli/args.ts:26`, `src/cli/args.ts:398-403`. A flag absent from that catalog
is not a flag, however plausible it sounds.

## Subcommands

### `haruyuki version`

Prints `getVersion() (Haruyuki)`. Reads nothing, writes nothing —
`src/cli/subcommands/router.ts:17-21`.

### `haruyuki memory` (alias `memfs`)

Actions: `status`, `diff`, `backup`, `backups`, `restore`, `export`, `pull`,
`tokens` — `src/cli/subcommands/memory.ts:20-29`. Everything except `tokens`
prints JSON; `tokens` prints text by default —
`src/cli/subcommands/memory.ts:32`, `src/cli/subcommands/memory-tokens.ts:113-117`.

- Agent resolution order is `--agent`, then `--agent-id`, then
  `$HARUYUKI_AGENT_ID` — `src/cli/subcommands/memory.ts:49-53`.
- `status` exits 2 when the repository is dirty or ahead of its remote —
  `src/cli/subcommands/memory.ts:184-186`.
- `pull` does not contact a remote on this backend; it returns a fixed
  `{ updated: false, ... }` result — `src/cli/subcommands/memory.ts:212-225`.
- `backup` copies the memory root to
  `<agentRoot>/memory-backup-YYYYMMDD-HHmmss` — `src/cli/subcommands/memory.ts:242-248`.
- **`restore` is destructive and requires `--force`**: it removes the memory
  root before copying the backup over it —
  `src/cli/subcommands/memory.ts:265-281`.
- `export` requires `--out` to be missing or empty —
  `src/cli/subcommands/memory.ts:297-312`.
- `tokens` defaults to the top 20 files, resolves the directory from
  `--memory-dir`, then `$MEMORY_DIR`, then the agent's memory directory, and
  uses exit code 64 for usage errors and 65 for I/O errors —
  `src/cli/subcommands/memory-tokens.ts:7-9`,
  `src/cli/subcommands/memory-tokens.ts:70-75`.

Every action reads and writes the local memory filesystem; none reaches a
remote — `src/cli/subcommands/memory.ts:77-79`.

### `haruyuki agents`

Actions `list` and `create`, JSON only — `src/cli/subcommands/agents.ts:44`.
`list` defaults to `limit=20` — `src/cli/subcommands/agents.ts:229`. `--shared`
accepts only `--query` and `--limit` and fails if combined with the name, tag,
or include-blocks filters — `src/cli/subcommands/agents.ts:202-211`.
`create` defaults to `memoryPromptMode: "memfs"`, enables MemFS for the new
agent, and `--pinned` writes to settings —
`src/cli/subcommands/agents.ts:142`,
`src/cli/subcommands/agents.ts:175-183`.

### `haruyuki model` (alias `models`)

Actions `get`, `list`, `set`; all output is JSON — `src/cli/subcommands/model.ts:50`.

- `set` without a handle requires `--reasoning` —
  `src/cli/subcommands/model.ts:109-119`.
- `--agent` and `--conversation`/`--conv` are mutually exclusive, as are
  `--default` and `--conversation` — `src/cli/subcommands/model.ts:434-439`.
- With neither, the target is inferred from `$HARUYUKI_AGENT_ID`/`$AGENT_ID`
  and `$HARUYUKI_CONVERSATION_ID`/`$CONVERSATION_ID` —
  `src/cli/subcommands/model.ts:453-459`.
- `--byok`, `--hosted`, and `--structured-outputs` apply to `list` only, and on
  the local backend `--hosted` returns an empty array —
  `src/cli/subcommands/model.ts:124-128`,
  `src/cli/subcommands/model.ts:146`.
- Secret-shaped fields in `model_settings` are redacted before printing —
  `src/cli/subcommands/model.ts:331-345`.

### `haruyuki messages`

Actions `search`, `list`, `transcript`; JSON only —
`src/cli/subcommands/messages.ts:94`. Defaults: `search --limit 10` with the
local search mode defaulting to `fts`, `list --limit 20` with conversation
`default`, `transcript --limit 100 --max-pages 200` —
`src/cli/subcommands/messages.ts:405-410`,
`src/cli/subcommands/messages.ts:435-447`,
`src/cli/subcommands/messages.ts:504-509`. `transcript --out` resolves relative
to the current working directory and writes the file —
`src/cli/subcommands/messages.ts:524`.

### `haruyuki steps`

One action: `steps trace --agent <id> --step <id>`, JSON output —
`src/cli/subcommands/steps.ts:35`. On the local backend it does not fetch
anything: it returns `status: "unsupported"` with the reason that local provider
traces are not recorded, and exits 0 —
`src/cli/subcommands/steps.ts:50-60`.

### `haruyuki mcp`

Actions `list`, `get`, `tools`, `schema`, `search`, `call`, with aliases
`list-tools`/`list_tools` and `run`/`run-tool`/`run_tool` —
`src/cli/subcommands/mcp.ts:854-872`.

- Agent resolution: `--agent`, `--agent-id`, `$HARUYUKI_AGENT_ID`, `$AGENT_ID`;
  otherwise it fails with `agent_id_required` —
  `src/cli/subcommands/mcp-io.ts:120-132`.
- Local servers come from settings (`getMcpServers(agentId)`), and the
  server-side MCP source is unavailable by default —
  `src/cli/subcommands/mcp.ts:165-174`.
- `tools`, `schema`, `search`, and `call` really do connect; a stdio server
  means starting a child process —
  `src/cli/subcommands/mcp.ts:376-379`,
  `src/cli/subcommands/mcp.ts:491-503`.
- `search` defaults to `mode=hybrid`, `limit=5` (valid range 1–100); `--mode
  vector` fails with `unsupported_search_mode` when no local embedding index
  exists — `src/cli/subcommands/mcp-search.ts:5`,
  `src/cli/subcommands/mcp-search.ts:68-78`,
  `src/cli/subcommands/mcp-search.ts:132-138`.
- `--args` and `--args-file` are mutually exclusive, and `--args-file -` reads
  stdin — `src/cli/subcommands/mcp-io.ts:142-151`.
- `call` exits 2 when the tool result carries an error —
  `src/cli/subcommands/mcp.ts:805`.

### `haruyuki mods`

Actions `list`, `package`, `update`, `enable`, `disable`, `remove` —
`src/cli/subcommands/mods.ts:66-72`. `list` prints human-readable text and is
the only action taking `--agent`/`--agent-id` —
`src/cli/subcommands/mods.ts:197-210`,
`src/cli/subcommands/mods.ts:268-272`. `package` requires `--name` —
`src/cli/subcommands/mods.ts:402-407`. The other actions operate on the global
mods root — `src/cli/subcommands/mods.ts:288-296` — which defaults to
`~/.haruyuki/mods`, overridden by `$HARUYUKI_MODS_DIR` or
`$HARUYUKI_EXTENSIONS_DIR`, falling back to `~/.haruyuki/extensions` when that
directory already exists — `src/mods/paths.ts:5-6`,
`src/mods/paths.ts:18-34`. Successful changes tell you to run `/reload` —
`src/cli/subcommands/mods.ts:60-61`.

### `haruyuki secret`

Actions `set KEY [--env VAR | --stdin | VALUE]`, `list`, and
`unset KEY` (aliases `delete`, `remove`, `rm`) —
`src/cli/subcommands/secret.ts:34-39`,
`src/cli/subcommands/secret.ts:227-230`. Keys are upper-cased
(`src/cli/subcommands/secret.ts:67-69`) and `list` prints names only, never
values (`src/cli/subcommands/secret.ts:129-137`). Storage falls back to
`<storage>/secrets/local-agent-secrets.json` —
`src/utils/secrets-store.ts:144-152`. Injection accepts literal `$NAME` only:
`${NAME}` is not expanded — `src/cli/subcommands/secret.ts:51-52`.

### `haruyuki server` (deprecated alias `app-server`)

Starts the local WebSocket App Server. The deprecated alias prints a warning
first — `src/cli/subcommands/router.ts:67-71`. Options are the App Server
options listed in the generated reference. `--listen` with no value binds an
available loopback port, may appear only once, and `--listen=` with an empty
value is an error — `src/cli/subcommands/server.ts:11-16`,
`src/cli/subcommands/server.ts:30-41`. The help states the server never
registers with or dials out to a remote environment service —
`src/cli/subcommands/app-server.ts:94-96`. With `--channels`, a channel gateway
supervisor is started as a child process —
`src/cli/subcommands/app-server.ts:271-288`.

### `haruyuki channel-gateway`

Internal process surface used with `--app-server-url` plus either `--channels`
or `--restore-enabled-channels` — `src/cli/subcommands/channel-gateway.ts:52-73`.
It reads `{type:"command",requestId,command}` lines from stdin and writes
prefixed response lines — `src/cli/subcommands/channel-gateway.ts:128-151` —
and prints `CHANNEL_GATEWAY_READY_SIGNAL` once ready —
`src/cli/subcommands/channel-gateway.ts:156`.

### `haruyuki connect`

`haruyuki connect <provider> [options]` connects a provider from the terminal —
`src/cli/subcommands/connect.ts:122-145`. The storage target is local whenever
`capabilities.localModelCatalog` is set, which it is here —
`src/providers/byok-providers.ts:539-545` — and the record is written to
`<storage>/providers/auth.json` —
`src/backend/local/local-provider-auth-store.ts:89-91`. On that path the API key
is stored without a live validation call — `src/cli/subcommands/connect.ts:513-519`.
`bedrock` accepts only `iam` or `profile`, each with its own required flags —
`src/cli/subcommands/connect.ts:402-420`. Without a TTY and without a key, it
fails rather than prompting — `src/cli/subcommands/connect.ts:495-505`.

### `haruyuki install` and `haruyuki skills`

`install` and `skills install` share one implementation —
`src/cli/subcommands/skills.ts:1144-1149`. Sources: an `npm:` prefix installs a
mod package (`src/cli/subcommands/skills.ts:1049-1063`), a `git:`/GitHub source
does the same (`src/cli/subcommands/skills.ts:1081-1095`), and a local directory
containing `package.json#letta` is installed from disk
(`src/cli/subcommands/skills.ts:1104-1115`). Agent-scoped mod packages are
rejected as not supported yet — `src/cli/subcommands/skills.ts:1050-1052`.
Installing a skill writes `<memoryDir>/skills/<name>` and commits it —
`src/cli/subcommands/skills.ts:727-745`,
`src/cli/subcommands/skills.ts:932-941`.

`skills list` prints `{agentId, skills}` as JSON —
`src/cli/subcommands/skills.ts:951-957`. `skills delete` requires an explicit
`--agent`/`--agent-id`, refuses names containing `/`, and commits the removal —
`src/cli/subcommands/skills.ts:1212-1225`,
`src/cli/subcommands/skills.ts:966-971`.

Installing a skill from the network contacts `github.com`, `clawhub.ai`, or the
npm registry — `src/cli/subcommands/skills.ts:306`,
`src/cli/subcommands/skills.ts:648-651`. A direct `SKILL.md` fetch is capped at
1 MiB — `src/cli/subcommands/skills.ts:30`,
`src/cli/subcommands/skills.ts:500-502`.

### `haruyuki cron`

Actions `add`, `list`, `get`, `runs`, `delete` (alias `remove`) —
`src/cli/subcommands/cron.ts:537-551`. State lives in
`~/.haruyuki/schedules.json`, a version-2 file holding `scheduler_owner`,
`scheduler_owners`, `signal_state.cursor`, and `tasks` —
`src/cron/cron-store.ts:56-59`, `src/cron/cron-types.ts:246-299`. On first read
after an upgrade a legacy `crons.json` is migrated: the v2 file is written
first, then the legacy file is renamed to the read-only `crons.v1.json` backup —
`src/cron/cron-store.ts:300`. A file written by a newer build is refused instead
of being read as an empty list — `src/cron/cron-store.ts:263`. Mutations take
the advisory `crons.lock` directory containing `owner.json` —
`src/cron/cron-lease.ts:40-47`, `src/cron/cron-lease.ts:105`.

Limits: 50 active-or-paused tasks per agent, finished tasks garbage-collected
after 24 hours, 5-second lock timeout — `src/cron/cron-file.ts:33`,
`src/cron/cron-file.ts:38`, `src/cron/cron-lease.ts:42`. Run logs go to
`<haruyuki>/runs/<task-id>.jsonl` with a default 2000-line / 2,000,000-byte cap,
and `runs` defaults to `--limit 50` — `src/cron/run-log.ts:78-79`,
`src/cron/run-log.ts:110`, `src/cli/subcommands/cron.ts:445-446`. Entries
written by a run carry the `runId` the log is grouped by; a missed or legacy
entry has no `runId` and stands alone — `src/cli/helpers/schedule-store.ts:378`.

Two behaviors are easy to get wrong:

- **`add` requires `--name` and `--description`, and the usage text does not say
  so.** Both are enforced in the handler —
  `src/cli/subcommands/cron.ts:156-167` — while the printed usage never lists
  either flag — `src/cli/subcommands/cron.ts:50-94`.
- `--computer` is not supported here and fails immediately —
  `src/cli/subcommands/cron.ts:242-247`.

`--every`, `--at`, and `--cron` are mutually exclusive, and `--once` cannot be
combined with `--cron` — `src/cli/subcommands/cron.ts:254-262`,
`src/cli/subcommands/cron.ts:297-301`. Omitting the conversation schedules a
fresh conversation per fire; `self` requires `$HARUYUKI_CONVERSATION_ID` —
`src/cli/subcommands/cron-scope.ts:8-22`.

`add` also takes the resident-scheduler fields: `--type prompt|command`, `--command
<compact|reflect>`, `--visible`/`--hidden`, `--permission
standard|acceptEdits|unrestricted`, `--catch-up`/`--no-catch-up`, `--timeout
<minutes>`, and `--wait <minutes>` — `src/cli/subcommands/cron.ts:57-94`. A
command task requires `--command`, cannot combine it with `--prompt`, and is
limited to `compact`/`reflect`; the whitelist is checked when the task is
created, not only at dispatch, so a typo is refused up front —
`src/cli/subcommands/cron.ts:176-199` — while `--visible`/`--hidden` only apply
to a fresh conversation — `src/cli/subcommands/cron.ts:200-213`. `--timeout`
accepts `0` (unlimited) and `--wait` accepts `0` too: instead of queueing the run
for a busy target conversation, a zero wait skips it immediately —
`src/cli/subcommands/cron.ts:249-252`. There is no `--tz` here: the timezone is
the process timezone captured at creation. A field left out gets the store
default (`prompt` type, `unrestricted` permission, no catch-up, 30-minute
timeout, 10-minute wait) — `src/cron/cron-store.ts:159-184`,
`src/cron/cron-types.ts:304-308`. This is the only scheduler in the build; there
is no hosted scheduling path — `src/cli/subcommands/cron.ts:20-24`.

### `haruyuki schedule` (internal)

`tick` and `status` only — `src/cli/subcommands/schedule.ts:276-304`. `tick` is
what the OS autostart entry wakes once a minute. The process entry
(`src/standalone-entry.ts`) dispatches `schedule` before the heavy application
index, so a tick reads the store and evaluates signals **without** importing the
backend, providers, tools, or listener — the process still loads a small startup
layer, so it is light rather than module-free —
`src/standalone-entry.ts:1-12`, `src/cli/subcommands/schedule.ts:134-202`,
`src/cron/preflight.ts:1-66`. It exits 0 when nothing is due or a long-lived host
already owns the scheduler. `tick` is an internal command, not part of the
interactive `/schedule` hub. `status` is read-only diagnostics: active / paused /
finished counts, whether a long-lived host is live, the next due instant, and the
store version and task count; a corrupt or newer store prints a diagnostic and
exits 1 instead of a stack trace — `src/cli/subcommands/schedule.ts:204-252`.

Both hosts call one scheduler core, which starts at most one task per tick and
leaves the rest for later ticks; the long-lived TUI or listener wins while it is
alive — `src/cron/scheduler-core.ts:1-8`,
`src/cron/scheduler-core.test.ts:182`.

### `haruyuki channels`

Actions `install`, `configure`, `status`, `route list|add|remove`, `bind`,
`pair` — `src/cli/subcommands/channels.ts:57-65`. State files are
`~/.haruyuki/channels/<channel>/accounts.json`, `pairing.yaml`, and
`routing.json` — `src/channels/config.ts:56-73`. Defaults come from
`$HARUYUKI_AGENT_ID` and `$HARUYUKI_CONVERSATION_ID`, the latter falling back to
`"default"` — `src/cli/subcommands/channels.ts:155-161`. Output is JSON —
`src/cli/subcommands/channels.ts:129`.

`route add/remove`, `pair`, and `bind` edit files but do **not** update a
running listener; live changes need the `/channels` app-server command or a
server restart — `src/cli/subcommands/channels.ts:86-88`. `channels install`
spawns a package manager in the channel's runtime directory —
`src/channels/runtime-deps.ts:47-50`,
`src/channels/runtime-deps.ts:248-252`.

### `haruyuki local-backend`

Only `migrate-transcripts [--storage-dir <path>] [--dry-run]` —
`src/cli/subcommands/local-backend.ts:23`. It rewrites `messages.jsonl` files
in place, backing up each one first, and `--dry-run` only reports —
`src/cli/subcommands/local-backend.ts:26-27`,
`src/cli/subcommands/local-backend.ts:66-69`. The default storage directory is
`$LETTA_LOCAL_BACKEND_DIR` or `~/.haruyuki/lc-local-backend` —
`src/utils/local-backend-paths.ts:9`,
`src/utils/local-backend-paths.ts:20-28`.

### `haruyuki trajectories` (alias `trajectory`)

Actions `export`, `detect`, `list`, `view`, `search` —
`src/cli/subcommands/trajectories.ts:24-29`. `--json` switches to JSON output;
without it the output is human-readable —
`src/cli/subcommands/trajectories.ts:112-126`. Only `user` and `assistant` are
accepted for `--role` — `src/cli/subcommands/trajectories.ts:188-191`. `--root`,
`--transcript`, and `--deepagents` must be written as `<source>:<path>` —
`src/cli/subcommands/trajectories.ts:83-95`. Export writes
`<out>/<source>/<startedAt>_<sessionId>.json` plus `manifest.json` —
`src/cli/subcommands/trajectories.ts:40`,
`src/cli/subcommands/trajectories.ts:334`.

### `haruyuki export` and `haruyuki import`

One package, both directions. `export [--out <package>]` writes a whole-machine
snapshot into a single `.hryk` file — a gzipped tar holding a root
`manifest.json`, the managed app-home tree (`home/`), the local backend storage
tree (`local-backend/`), an optional `project/` tree and `secrets.json`. Without
`--out` the package is written to `./haruyuki-<hostname>-<YYYYMMDD-HHmmss>.hryk`
in the current directory, with the hostname sanitized to a path-safe segment —
`src/cli/subcommands/snapshot/cli.ts:527`. `import --from <package>` restores it:
the package is validated first, then the managed data is replaced —
`src/cli/subcommands/snapshot/cli.ts:614`. `--dry-run` reports the scope without
writing anything, and `import --verify` validates the archive, manifest, schema
version and every entry's size and SHA-256 without writing —
`src/cli/subcommands/snapshot/cli.ts:116`,
`src/cli/subcommands/snapshot/cli.ts:171`.

Both commands read this machine's data roots, so the router selects the backend
mode early and dispatches them before the TUI starts —
`src/cli/subcommands/router.ts:45-46`,
`src/cli/subcommands/router.ts:119-122`. The roots are the ones this process
resolves (`HARUYUKI_HOME`, `LETTA_LOCAL_BACKEND_DIR`); neither command accepts a
`--home` override.

Neither command may hang waiting for input. `export` asks for the word `export`,
`import` for `overwrite`; `--yes` skips both, and a non-interactive shell
without `--yes` fails with exit code 2 instead of waiting —
`src/cli/subcommands/snapshot/cli.ts:318`,
`src/cli/subcommands/snapshot/cli.ts:560`. Import deliberately validates before
asking, through the `RequireConfirm` callback it hands to the import pipeline, so
a corrupt package never costs the user a confirmation word —
`src/cli/subcommands/snapshot/cli.ts:656`,
`src/cli/subcommands/snapshot/import.ts:33-40`.

What it touches: export writes exactly the `--out` path (plus its `.partial`
staging file, renamed on success) and never edits a source file. Import replaces
the managed trees, writes `backups/pre-import.hryk` first and restores it when a
later step fails; a failed restore keeps the backup and prints the manual
command — `src/cli/subcommands/snapshot/report.ts:124`. Neither command edits
`.gitignore`; the warning is printed instead.

`--json` prints one object. Multi-word keys are snake_case — `not_remapped`,
`failed_secrets`, `dry_run`, `duration_ms`, `backup_path` — and the per-entry
list appears only with `--verbose` — `src/cli/subcommands/snapshot/report.ts:264`.
Secret values are never printed, only names, not even in verbose output. There is
no progress bar and no timer: the human output is stage lines from the pipeline's
progress callback plus a summary — `src/cli/subcommands/snapshot/report.ts:156`.

The package is a key to this machine: it carries plaintext credentials and
private conversations, so treat it as sensitive, keep it out of git, and delete
it when done. After an import, restart haruyuki; compiled prompt snapshots and
recall indexes are rebuilt on first use, so the first conversation may be slower
— `src/cli/subcommands/snapshot/cli.ts:105`.

`--with-project` carries project-level harness data only, never the project
itself: `project/.haruyuki/settings.json`, `project/.haruyuki/settings.local.json`,
`project/.haruyukiignore`, `project/.commands/**`, `project/.agents/skills/**` and
the legacy `project/.skills/**` —
`src/cli/subcommands/snapshot/scope.ts:188`,
`src/cli/subcommands/snapshot/scope.ts:218`. Source files, `.env`, `.git` and
`node_modules` stay out of the package, and an import clears only those same six
paths. A package that carries `project/` but an import without `--with-project`
warns and skips the project tree instead of writing into the current directory —
`src/cli/subcommands/snapshot/import.ts:378`. Export packs `home/schedules.json`
and leaves the read-only `home/crons.v1.json` backup out of the package. Both
export and import clear the scheduler lease and the per-task leases
(`scheduler_owner` null, `scheduler_owners` empty, each task's `lease` null), so
the target machine never inherits the exporting machine's scheduler claim —
`src/cli/subcommands/snapshot/legacy-store.ts`,
`src/cli/subcommands/snapshot/machine-state.ts`.

Three schedule-store edges are visible to the user. A machine that has not run a
schedule command since the upgrade still keeps its tasks in `crons.json` and has
no `schedules.json`: export warns that those tasks were **not packed** and tells
the user to run a schedule command once (which migrates the store) and export
again. A `schedules.json` written by a newer build is refused instead of being
rewritten or packed. An import never restores the exporting machine's OS timer:
it warns when no autostart entry is registered here, and a successful v2 restore
retires a leftover live `crons.json` (moved to the read-only v1 name) while the
pre-import backup includes it, so a rollback can restore it —
`src/cli/subcommands/snapshot/legacy-store.ts`,
`src/cli/subcommands/snapshot/import-backup.ts`,
`src/cli/subcommands/snapshot/autostart-warning.ts`,
`src/cli/subcommands/snapshot/import.ts`.

## Slash commands

The interactive surface is organised as eight hubs plus a set of retained
top-level commands. The hub table — subcommands, arguments, and the retired
spellings — is `src/cli/commands/hubs.ts:48-391`; the registry they resolve into
is `src/cli/commands/registry.ts`, with the hub entries starting at `:87`. A
retired spelling is intercepted before dispatch and answered with the form that
replaced it — `resolveHubInput`, `src/cli/commands/hubs.ts:422-478`.

Exact argument hints and descriptions are in the generated reference; this
section covers what each command does and whether it takes over the screen.

### Hubs

| Hub | Subcommands | What it owns |
| --- | --- | --- |
| `/agent` | `list`, `pin [name]`, `unpin`, `pinned`, `rename <name>`, `describe <text>`, `system`, `personality`, `toolset`, `subagents`, `ade`, `profile <save\|load\|delete\|usage> [name]` | agent identity, prompts, tools, and the agent browser |
| `/session` | `id`, `rename <name>`, `logout` | the conversation's own id and name, and saved credentials |
| `/memory` | `recall`, `init`, `memfs`, `remote`, `palace`, `config` | memory view, initialisation, filesystem backend, git remote, palace, and reflection settings |
| `/messages` | `history`, `clear` | the message history and the destructive full reset |
| `/skill` | — or `list` | the available skills (the skills dialog) |
| `/skill skill-creator [description]` | | entering skill-creation mode |
| `/context` | `limit [tokens] [--override]`, `pending [full]` | the context window and unapplied prefix changes |
| `/config` | `connect`, `mcp`, `hooks`, `secret`, `experiments`, `mods`, `statusline`, `title`, `terminal`, `font-width`, `console-font`, `stream`, `reasoning-tab`, `system-reminders` | providers, MCP, hooks, secrets, terminal, and appearance |
| `/maintenance` | `feedback`, `bg`, `workflows`, `install-github-app` | low-frequency maintenance |

Bare `/agent`, `/memory`, and `/context` run a default action — the agent
browser, the memory view, and the context-usage display; the other hubs print
their subcommand list. `/agent rename <name>` renames the agent and
`/session rename <name>` renames the conversation; the old `/rename` command is
gone, replaced by those two forms.

Each subcommand runs an internal registry entry — `/agents` for `/agent list`,
`/memfs` for `/memory memfs`, `/topics` for `/topic list`, `/sleeptime` for
`/memory config` — so a missed rewrite degrades to a known command rather than
being sent to the model as chat text. Those entries are marked `internal` and
`hidden`, which keeps them out of autocomplete and out of the user-typed
surface — `src/cli/commands/registry.ts:700-760`. Typing one directly is
answered with the hub form, not executed.

### `/schedule`

`/schedule` is a hub-shaped top-level command rather than one of the eight in
the table above. It is registered at `src/cli/commands/registry.ts:565-578` and
parsed by `parseScheduleInvocation` (`src/cli/commands/schedule.ts:391`); the
nine names are `SCHEDULE_SUBCOMMANDS` (`src/cli/commands/schedule.ts:49-62`) and
the help text is `formatScheduleHelp` (`src/cli/commands/schedule.ts:68-98`).

| Subcommand | What it does |
| --- | --- |
| `list [--all]` | Tasks for the current agent, or every agent with `--all` |
| `show <id\|name>` | One task's details and next due time |
| `add [options]` | Create; one step outside the TUI when the required flags are present, otherwise the wizard |
| `run <id\|name>` | Run once now, without consuming the next scheduled occurrence |
| `pause <id\|name>` | Pause an active task |
| `resume <id\|name>` | Resume and clear the failure streak |
| `delete <id\|name>` | Delete the task |
| `logs <id\|name>` | Run history grouped by `runId` |
| `autostart on\|off\|status` | Register, remove, or report the OS wake-up entry |

The TUI claims `list`, `show`, `add`, `logs`, and `run` for its panels and
wizard; `pause`, `resume`, `delete`, and `autostart` answer in the command row.
A listener or headless channel gets the text form of the same subcommands;
`run` and the interactive log view need the TUI —
`src/cli/app/submit-schedule-commands.ts:1-17`. `run` executes through the TUI
host, so it shares the scheduler core with a timer-driven run; it sends a
completion notification and writes a run-log row. It does not consume the next
scheduled occurrence.

`add` is one step outside the TUI when every required flag is present; with a
missing flag it prints what is missing instead of creating anything — the check
is `missingAddFlags` (`src/cli/commands/schedule.ts:188-199`). In the TUI,
`/schedule add` opens the wizard and pre-fills it from whatever flags were
passed, starting at the first missing step —
`src/cli/components/ScheduleWizardSteps.tsx:231-261`.

| Requirement | Flag |
| --- | --- |
| Schedule (exactly one) | `--cron <5-field>` \| `--every <5m\|2h\|1d>` \| `--at <time>` |
| Content | `--prompt <text>` \| `--command <command>` |
| Target | `--target new\|default\|existing:<conversation-id>` |
| Visibility, for `--target new` | `--visible` \| `--hidden` |
| Permission | `--permission standard\|acceptEdits\|unrestricted` |
| Catch-up | `--catch-up` \| `--no-catch-up` |

Optional flags are `--type prompt|command` (default `prompt`; `--command`
implies `command`), `--timeout <minutes>` (default 30; `0` is unlimited),
`--wait <minutes>` (default 10), `--tz <IANA>` (default: this machine's
timezone at creation), and `--name <text>`. `--at` is one-shot; `--cron` and
`--every` are recurring, and `--every` compiles to a five-field expression —
`src/cli/commands/schedule.ts:201-382`.

A `command` task may only name `compact` or `reflect`; the payload is passed
through verbatim and anything else is refused before dispatch —
`src/cron/task-run.ts:48-51`, `src/cron/task-run.ts:282-285`.

Targets are a fresh conversation per fire (`new`, optionally hidden), the
agent's default conversation (`default`), or one specific conversation
(`existing:<conversation-id>`). `--visible`/`--hidden` only apply to `new` and
one of them is required there.

Scheduled runs are unattended, so every approval request is denied rather than
left pending — `src/cron/task-run.ts:138-152`. The tier decides what runs
without asking:

| Tier | Allows without asking | Needs approval (denied unattended) |
| --- | --- | --- |
| `standard` | Reading, searching, task-list and artifact bookkeeping, and the read-only `recall` subagent (the constrained `reflection`/`memory` subagents are auto-approved too) | Writing files, shell, and every other subagent type |
| `acceptEdits` | Reading and writing files | Shell, **unless an explicit permission allow rule matches**: allow rules are evaluated before the tier default, so a shell command the user allow-listed does run |
| `unrestricted` | Every tool | Nothing by tier; this build does not promise delete/network bans because the sandbox is process-level |

So `standard` is not "no subagents at all": the safe subagent types are
auto-approved, and a subagent that needs approval is denied. Likewise
`acceptEdits` is not "no shell at all": the tier refuses shell by default, and
explicit allow rules still apply —
`src/permissions/checker.ts:774-845`, `src/permissions/checker.ts:446-460`.

A `reflect` command task inherits the task's tier; with `standard` it cannot
write memory and the reflection fails.

`/schedule autostart on` registers a user-level OS entry that wakes
`haruyuki schedule tick` once a minute — Windows `schtasks`, macOS launchd (with
`bootout` + `bootstrap` reloading a rewritten plist immediately), or a Linux
systemd user timer with a marked crontab fallback —
`src/cron/autostart.ts:1-25`, `src/cron/autostart.ts:592`,
`src/cron/autostart.ts:698`. The entry points at a generated launcher that
carries `HARUYUKI_HOME`, not at the product binary directly. The wizard's last
step offers the same registration. `off` removes the entry. Deleting the last
task deliberately does **not** unregister autostart, so rebuilding a task does
not rewrite machine configuration every time —
`src/cron/autostart.ts:918`. A failed registration is reported with the task
kept in place.

`status` and `off` probe the machine's own artifacts (`systemctl --user
is-enabled`, the unit files and the enable symlink, the crontab line, the
registry/plist), never just `XDG_RUNTIME_DIR`: a timer registered from a desktop
session is still reported — and can still be removed — from an SSH shell with no
user manager — `src/cron/autostart.ts:491-505`,
`src/cron/autostart.ts:807`. When `HARUYUKI_HOME` or the install path changed
since registration, `status` marks the entry stale and reports the launcher it
actually references; `on` again rewrites the launcher and the entry —
`src/cron/autostart.ts:444-472`, `src/cron/autostart.ts:592`.

### Overlays

These open a selector instead of running in the transcript:

| Command | Opens | Source |
| --- | --- | --- |
| `/agent`, `/agent list`, `/agent pinned` | agent browser | `src/cli/app/submit-navigation-commands.ts` |
| `/model` | model selector | `src/cli/app/use-submit-handler.ts` |
| `/memory` | MemFS tree viewer, or the memory tab viewer | `src/cli/app/use-submit-handler.ts` |
| `/search` | message search | `src/cli/app/submit-navigation-commands.ts` |
| `/config connect` | provider selector | `src/cli/app/submit-connection-commands.ts` |
| `/skill list` | skills dialog (same as bare `/skill`) | `src/cli/app/use-submit-handler.ts` |
| `/config mcp` | MCP selector | `src/cli/app/submit-connection-commands.ts` |
| `/agent subagents` | subagent manager | `src/cli/app/use-submit-handler.ts` |
| `/config hooks`, `/config title`, `/config statusline`, `/agent toolset`, `/agent system`, `/agent personality`, `/memory config`, `/compact config` | their respective selectors | `src/cli/app/use-submit-handler.ts`, `src/cli/app/use-configuration-handlers.ts` |
| `/resume` with no argument | conversation selector | `src/cli/app/submit-navigation-commands.ts` |
| `/help` | help dialog | `src/cli/app/use-submit-handler.ts` |
| `/messages history` | message history (full-screen shell only) | `src/cli/app/shell-commands.ts:51-83` |

### Context and history

- `/context` shows window usage; `/usage` opens the Usage page (overview and
  breakdown) in the full-screen shell. There is no balance read behind it — see
  the `unsupported` document.
- `/context pending [full]` lists registered-but-unapplied prefix changes, and
  `/recompile` applies them. See the `context-and-compaction` document for the
  details, including why the prefix is frozen in the first place.
- `/compact [n|help]` compacts: it first runs the summarizer on the frozen
  prefix and shows the overview with the cut-point table — nothing is written
  before you pick. Bare `/compact` opens the topic picker when the preview has
  more than one block and otherwise trims by the compression rate; `/compact <n>`
  picks the block numbered by `/topic list`; Esc cancels with zero writes —
  `src/cli/app/submit-compact-commands.ts`.
- `/compact config` opens the mode panel, where the **Compression rate** row is
  editable — `src/cli/app/use-submit-handler.ts:718-729`.
- `/topic <title> [summary]` marks a boundary; `/topic list` opens one panel with
  three views — the blocks of the current context, `--context` for this
  conversation's markers in context order, `--all` for every marker this agent
  has recorded (Tab switches views, Enter opens a row). `/topic search <kw>`
  reads the derived index and never writes a marker; `/topic show <#n|title>`
  prints the conversation a marker covers. Registered in
  `src/cli/commands/registry.ts`.
- `/clear` empties the in-context transcript; `/messages clear` resets all of
  the agent's messages — `src/cli/commands/registry.ts:262-279`.
- `/memory memfs [enable|disable|sync|reset]` manages the filesystem backend,
  and `/context limit [tokens] [--override]` sets the max context window —
  `src/cli/commands/registry.ts:227-244`.

### Session and agent

`/new`, `/fork`, `/btw <question>`, `/resume [conversation_id]`, `/cd <path>`,
and `/exit` stay top-level. Agent identity and presentation moved into
`/agent`: `/agent pin [name]`, `/agent unpin`, `/agent rename <name>`,
`/agent describe <text>`, `/agent personality`, `/agent system`,
`/agent toolset`, and `/agent subagents`. The conversation's own name is
`/session rename <name>`; `/session logout` clears saved credentials and exits.
`/agent profile <save|load|delete|usage> [name]` manages local agent profiles.

### Reflection

`/dream` and `/reflect` take `[--instruction TEXT]` and require an active agent:
without one they throw `Reflection requires an active agent.` —
`src/cli/commands/registry.ts`. There is no `/reflection` alias any more, and the
old cross-conversation flags (`--recent`, `--conversation`, `--auto`) are gone:
passing one is an error that prints the current usage. Reflection only ever
runs on the current conversation.

Automatic triggers are two independent switches in `/memory config` (or the
settings page): `reflectionOnCompaction` (default on) and
`reflectionEveryUserMessages` (default 0 = off; 25 is the suggested threshold).
A run is capped by `reflectionTimeoutMinutes` (default 3, range 1–60), and a
successful run deletes its hidden fork when `reflectionDeleteSessionOnSuccess`
is on (the default). The run itself is a hidden `inherited-context` fork of the
conversation whose prefix is byte-identical to the parent turn; it writes the
memory repository directly, so there is no worktree or merge step any more —
`src/cli/helpers/reflection-launcher.ts`. See the `memory-filesystem` and
`settings-and-paths` documents, and the `unsupported` document for the retired
cloud reflection path.

### Settings and maintenance

`/reload` re-reads settings and local mods only — a busy agent refuses it —
`src/cli/app/use-submit-handler.ts`. `/config secret`, `/memory remote`,
`/config system-reminders`, and `/config mods` delegate to their command
modules — `src/cli/commands/registry.ts`. `/config terminal` installs a
Shift+Enter keybinding and records `shiftEnterKeybindingInstalled` in settings —
`src/cli/commands/config-commands.ts`. `/config statusline [request]` and
`/config title` adjust presentation, `/config reasoning-tab [on|off|status]`
toggles a shortcut, and `/config experiments` opens the experiments selector —
`src/cli/app/use-configuration-handlers.ts`, `src/cli/app/experiments-command.ts`.
`/config font-width auto|narrow|wide` and
`/config console-font auto|off|<face>` control terminal appearance —
`src/cli/commands/config-commands.ts`. `/maintenance feedback`,
`/maintenance bg`, `/maintenance workflows`, and
`/maintenance install-github-app` cover the low-frequency commands.

### Full-screen pages

`/usage`, `/tabs`, `/close`, `/settings`, and `/messages history` belong to the
full-screen shell. In the append shell they only print a line saying pages need
it — `src/cli/app/shell-commands.ts:51-83`.

### Removed names

Eight top-level names are gone; the surviving command does the job:
`/chdir` → `/cd <path>`, `/reflection` → `/reflect`,
`/set-max-context` → `/context limit`, `/profiles` → `/agent pinned`,
`/link` and `/unlink` → `/agent toolset`, `/conversations` → `/resume`, and
`/profile` → `/agent profile <save|load|delete|usage> [name]`.

### Argument handling

`noArgs` commands fail when given an argument, unknown commands report
`Unknown command`, and a handler that throws is wrapped as
`Error executing <command>: ...` — `src/cli/commands/registry.ts`. The registry's
`hidden` flag now marks internal hub targets and nothing a user types; `/help`
is an ordinary, visible command.

## What changes machine state

Useful when deciding whether a command is safe to run reflexively.

| Area | Commands | Where |
| --- | --- | --- |
| Scheduler state | `cron add`, `cron delete`, `cron delete --all`, `/schedule add`, `/schedule pause`, `/schedule resume`, `/schedule delete` | `~/.haruyuki/schedules.json` (version 2; `signal_state.cursor`), with a read-only `crons.v1.json` backup — `src/cron/cron-store.ts:56-72` |
| Scheduler autostart | `/schedule autostart on`, `/schedule autostart off` | a user-level OS entry (`schtasks`, launchd, systemd-user, or crontab) — `src/cron/autostart.ts:387`, `src/cron/autostart.ts:713` |
| Mods | `mods package/update/enable/disable/remove`, `install npm:…`, `install git:…` | the global mods root — `src/mods/paths.ts:18-34` |
| Channels | `channels install/configure/route/pair/bind` | `~/.haruyuki/channels/<channel>/` — `src/channels/config.ts:56-73` |
| Pins | `agents create --pinned`, `/agent pin`, `/agent unpin` | `~/.haruyuki/settings.json` — `src/cli/subcommands/agents.ts:181-183` |
| Provider credentials | `connect <provider>` | `<storage>/providers/auth.json` — `src/backend/local/local-provider-auth-store.ts:89-91` |
| Secrets | `secret set`, `secret unset` | `<storage>/secrets/local-agent-secrets.json` — `src/utils/secrets-store.ts:144-152` |
| Agent memory | `skills install/delete`, `memory backup/restore/export`, `/agent personality`, `/topic` | the memory repository — `src/cli/subcommands/skills.ts:932-941`, `src/agent/personality.ts:358-456` |
| Local store rewrite | `local-backend migrate-transcripts` | `<storage>/**/messages.jsonl`, each backed up first — `src/cli/subcommands/local-backend.ts:26-27` |
| Whole-machine snapshot | `export`, `import` | one `.hryk` package at `--out`; `import` replaces the managed trees after writing `backups/pre-import.hryk` — `src/cli/subcommands/snapshot/cli.ts:527`, `src/cli/subcommands/snapshot/cli.ts:614` |
| Background processes | `server`, `channel-gateway`, `mcp tools/schema/search/call`, `skills install` from git, `channels install` | `src/cli/subcommands/app-server.ts:239`, `src/cli/subcommands/mcp.ts:491-503`, `src/cli/subcommands/skills.ts:483-488` |

`memory restore` deserves its own warning: it deletes the memory root before
copying — `src/cli/subcommands/memory.ts:265-281`.
