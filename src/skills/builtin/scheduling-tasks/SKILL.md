---
name: scheduling-tasks
description: Manage resident scheduled tasks through the /schedule hub and the haruyuki cron CLI — conversation targets, permission tiers, catch-up, autostart, storage, and run history. Use Wake for an ordinary self-bound reminder in the current conversation.
---

# Scheduling Tasks

Scheduled tasks send a prompt to an agent, or run a whitelisted command, on a
timer. They are device-local: the schedule lives in this machine's harness root
and fires from a Haruyuki host on this machine. There is no remote or hosted
scheduler.

Use this skill when:

- the task should run in a fresh, default, or different conversation
- you need the newer controls — permission tier, catch-up, timeout, wait,
  visibility, or autostart
- you need run history, replacement, or broader schedule inspection
- Wake cannot see or manage the schedule you need

For an ordinary one-shot or recurring reminder bound to the current
conversation, Wake is still the shortest path: it is self-bound and covers
create, list, and cancel without routing choices.

## Storage

The live store is `~/.haruyuki/schedules.json` (or the same relative path under
`$HARUYUKI_HOME`). It is a version-2 file with four top-level parts:

| Field | Meaning |
| --- | --- |
| `scheduler_owner` / `scheduler_owners` | The process that currently owns the scheduler lease |
| `signal_state.cursor` | Per-signal-source cursor persisted with the tasks |
| `tasks` | The persisted task records |
| `version` | `2` |

On first read after an upgrade, a legacy `crons.json` is migrated: the v2 file
is written first, then the legacy file is renamed to the read-only
`crons.v1.json` backup. A parse failure leaves the legacy file untouched and
reports the error. The backup is never written again. A file whose `version` is
newer than this build is refused rather than read as an empty list, so a newer
build's tasks cannot be erased by a write.

Mutations still take the advisory `crons.lock` directory (containing
`owner.json`), with a 5-second acquisition timeout.

Limits:

- 50 active-or-paused tasks per agent
- terminal tasks (fired, missed, cancelled) are garbage-collected after 24 hours
- recurring tasks do not auto-expire; they stay active until deleted or paused

## Who runs schedules

Two hosts share the store and the lease:

- **Long-lived host** — the interactive TUI or the WebSocket listener. It owns
  the scheduler while it is alive.
- **Short-lived host** — `haruyuki schedule tick`, an internal command the OS
  timer wakes once a minute. It reads the store and evaluates signals before
  loading the backend, providers, tools, or listener; when nothing is due, or a
  long-lived host already owns the lease, it exits without doing any work.

The long-lived host wins whenever it is alive. At most **one** task is started
per tick; the rest of the due work is left for the following ticks.

### Occurred-once semantics

A due occurrence is the most recent scheduled slot that has not been consumed
yet — not every slot that went by. That single rule drives the catch-up policy:

- `--catch-up`: a late occurrence runs once, at its original intended time.
- `--no-catch-up`: a late occurrence is recorded as missed, `missed_count`
  grows, and it is not replayed.
- A slot more than 90 seconds late is treated as late. A one-shot that is late
  without catch-up is recorded as missed.
- A run skipped because the target conversation was busy does not count as a
  failure and does not pause the task.

Three consecutive pre-start or mid-run failures pause the task automatically.
`resume` clears the failure streak and the pause reason.

### Diagnostics

`haruyuki schedule status` is read-only. It prints the active / paused /
finished counts, whether a long-lived host is live, the next due instant, and
the store version and task count. `tick` is internal; neither is part of the
`/schedule` hub.

## The `/schedule` hub

`/schedule` is the interactive surface. It has nine subcommands:

| Subcommand | What it does |
| --- | --- |
| `list [--all]` | List tasks for the current agent, or every agent with `--all` |
| `show <id\|name>` | Show one task's details and next due time |
| `add [options]` | Create a task; one step outside the TUI when the required flags are present, otherwise the wizard |
| `run <id\|name>` | Run once now, without consuming the next scheduled occurrence |
| `pause <id\|name>` | Pause an active task |
| `resume <id\|name>` | Resume a paused task and clear its failure streak |
| `delete <id\|name>` | Delete the task |
| `logs <id\|name>` | Run history, grouped by `runId` |
| `autostart on\|off\|status` | Register, remove, or report the OS-level wake-up entry |

`list`, `show`, `add`, `logs`, and `run` open a panel or the wizard in the TUI.
`pause`, `resume`, `delete`, and `autostart` answer in the command row. In a
listener or headless channel the same subcommands answer in text; `run` and the
interactive log view need the TUI.

`run` executes through the TUI host, so it goes through the same scheduler core
as a timer-driven run. It sends a completion notification and writes a run-log
row. It does not consume the next scheduled occurrence.

### `/schedule add`

`add` creates the task in one step outside the TUI when every required flag is
present; with a flag missing it prints the missing flags instead of creating
anything. In the TUI, `/schedule add` opens the wizard, pre-filled from any
flags already passed, and starts at the first missing step. The wizard's last
step can register autostart.

Required:

| Requirement | Flag |
| --- | --- |
| Schedule (exactly one) | `--cron <5-field>` \| `--every <5m\|2h\|1d>` \| `--at <time>` |
| Content | `--prompt <text>` \| `--command <command>` |
| Target | `--target new\|default\|existing:<conversation-id>` |
| Visibility, when the target is `new` | `--visible` \| `--hidden` |
| Permission tier | `--permission standard\|acceptEdits\|unrestricted` |
| Catch-up | `--catch-up` \| `--no-catch-up` |

Optional:

| Flag | Meaning |
| --- | --- |
| `--type prompt\|command` | Task type; defaults to `prompt`, and `--command` implies `command` |
| `--timeout <minutes>` | Per-run timeout; `0` means unlimited (default 30) |
| `--wait <minutes>` | How long to wait for a busy target conversation (default 10) |
| `--tz <IANA>` | Timezone for the cron expression; defaults to this machine's timezone at creation |
| `--name <text>` | Task name; defaults to a short prefix of the prompt or command |

`--at` is one-shot; `--cron` and `--every` are recurring. `--every` compiles to
a five-field cron expression.

A `command` task is limited to the unattended-safe whitelist: `compact` and
`reflect`. The payload is passed through verbatim, so `--command "reflect"`
works and any other command is refused before dispatch.

Targets:

- `new` — a fresh conversation per fire. Add `--hidden` to keep that
  conversation out of the normal list, or `--visible` to show it.
- `default` — the agent's default conversation.
- `existing:<conversation-id>` — one specific conversation.

### Permission tiers

Scheduled runs are unattended: there is no human at the keyboard, so **every
approval request is denied** instead of waiting. The tier decides what can be
done without asking:

| Tier | Allows | Refuses |
| --- | --- | --- |
| `standard` | Reading files, searching | Writing files, shell, subagents |
| `acceptEdits` | Reading and writing files | Shell |
| `unrestricted` | Every tool | Nothing by tier; this build does not promise delete/network bans, because the sandbox is process-level |

A `reflect` command task inherits the task's tier. With `standard` it cannot
write memory, so the reflection fails; give a reflection task a tier that can
write.

## `haruyuki cron`

The scriptable CLI is still `haruyuki cron`. It writes the same
`schedules.json` and prints JSON.

```bash
haruyuki cron add --name <short-name> --description <text> \
  (--prompt <text> | --command <compact|reflect>) \
  (--every <interval> | --at <time> | --cron <expr>)
haruyuki cron list [--agent <id>] [--conversation <id>]
haruyuki cron get <id-or-name>
haruyuki cron runs --id <task-id> [--limit <n>] [--run-id <id>]
haruyuki cron delete <id-or-name>        # remove is an alias
haruyuki cron delete --all --agent <id>
```

- `add` requires `--name` and `--description` (the printed usage omits them,
  but the handler enforces them) and exactly one of `--prompt` or `--command`.
- Exactly one of `--every`, `--at`, `--cron` is required. `--once` is accepted
  with `--at` (already one-shot there) and rejected with `--cron`.
- `--agent` defaults to `$HARUYUKI_AGENT_ID`.
- `--conversation` accepts `self` (requires `$HARUYUKI_CONVERSATION_ID`),
  `default`, `new`, or a concrete conversation ID. Omitting it means `new`, so
  every fire gets a fresh conversation.
- `--computer` is accepted by the parser only so it can be rejected with a
  clear error. There is no way to run a schedule on another computer.
- `runs` defaults to `--limit 50`; `--run-id` selects one run.

The newer scheduling fields are available here too: `--type prompt|command`, `--command
<compact|reflect>`, `--visible`/`--hidden`, `--permission
standard|acceptEdits|unrestricted`, `--catch-up`/`--no-catch-up`, `--timeout
<minutes>`, and `--wait <minutes>`. A command task requires `--command`,
cannot be combined with `--prompt`, and is limited to `compact`/`reflect`;
`--visible`/`--hidden` only apply when `--conversation` is omitted or `new`.
`--timeout` accepts `0` (unlimited); `--wait` requires at least 1. There is no
`--tz` on this CLI: the timezone is the process timezone captured at creation.
A field left out gets the store default: `prompt` type, `unrestricted`
permission, no catch-up, a 30-minute timeout, and a 10-minute wait.

Use `/schedule add` when you need `--target existing:<conversation-id>` or
`--tz`; `haruyuki cron` expresses the target through `--conversation`.

`--at` accepts `"in 45m"`, `"3:00pm"`, or an RFC 3339 timestamp with an
explicit offset. `--every` accepts intervals such as `5m`, `2h`, `1d`.

## Autostart

Without autostart, schedules only run while a long-lived Haruyuki host is
running on this machine. `/schedule autostart on` registers a user-level OS
entry that wakes `haruyuki schedule tick` once a minute:

| Platform | Mechanism |
| --- | --- |
| Windows | `schtasks` |
| macOS | launchd LaunchAgent |
| Linux | systemd user timer, falling back to a marked crontab line |

The entry points at a generated launcher, not at the product binary, so it
survives a move of the binary and carries the `HARUYUKI_HOME` override. The
wizard's last step offers the same registration.

`/schedule autostart off` (or uninstalling) removes the entry. **Deleting the
last task does not unregister autostart** — that is deliberate, so rebuilding a
task does not rewrite machine configuration. A failed registration is reported
with the task kept in place; it can be retried from the wizard.

## Run history

Run logs are append-only JSONL files at `<haruyuki>/runs/<task-id>.jsonl`.
Entries written by a run carry the `runId` of that run, so `/schedule logs`
groups by `runId` and shows one row per run. A missed record or a legacy entry
has no `runId` and stands alone. The log is capped at 2,000 lines past
2,000,000 bytes.

## Timezones

Recurring expressions — `--cron`, and the expression `--every` compiles to —
are interpreted in the timezone captured when the task is created, or in the
timezone given with `/schedule add --tz`. Write the expression in the user's
own wall-clock time and do not convert to UTC: a user in California asking for
"9am daily" needs `--cron "0 9 * * *"`.

Because the timezone is captured at creation, a task keeps matching that same
wall-clock time. If the machine moves to another timezone and the user wants the
schedule to follow it, delete the task and create it again with the new
timezone.

For a one-shot calendar request such as "tomorrow at 9am," resolve the date in
the user's timezone and pass `--at` an RFC 3339 timestamp with an explicit
offset. Infer a reasonable timezone from available context instead of asking a
redundant follow-up. State the timezone you used in the confirmation (for
example, "Scheduled for 9:00 AM PT") so the user can correct the assumption. A
bare clock such as `--at "9:00am"` uses this machine's timezone and schedules
tomorrow if that time has already passed there. Relative values such as
`--at "in 45m"` do not need a timezone.

## Examples

### "Remind me every morning at 9am to walk the dog" (user in UTC−7)

```bash
haruyuki cron add \
  --name "dog-walk-reminder" \
  --description "Daily 9am (America/Los_Angeles) reminder to walk the dog" \
  --prompt "Hey! It's 9am — time to walk the dog." \
  --cron "0 9 * * *"
```

`--every 1d` also lands on midnight, so use `--cron` whenever the user names a
time of day.

### "Check on the deploy in 30 minutes, in this conversation"

```bash
haruyuki cron add \
  --name "deploy-check" \
  --description "One-time check on deployment status" \
  --prompt "Check the deployment status and report the result here." \
  --at "in 30m" \
  --agent "$HARUYUKI_AGENT_ID" \
  --conversation self
```

### "Every weekday at 5pm, remind me to submit my timesheet" (user in UTC−7)

```bash
haruyuki cron add \
  --name "timesheet-reminder" \
  --description "Weekday 5pm (America/Los_Angeles) timesheet reminder" \
  --prompt "Friendly reminder: don't forget to submit your timesheet before EOD!" \
  --cron "0 17 * * 1-5"
```

The day-of-week field is the user's own weekday because the expression is read
in the captured timezone, so no day shift is needed.

### A task in a fresh hidden conversation, with catch-up

```bash
/schedule add \
  --name "nightly-triage" \
  --prompt "Triage the overnight alerts and summarize them." \
  --cron "0 7 * * *" \
  --target new --hidden \
  --permission acceptEdits \
  --catch-up \
  --timeout 20 --wait 5
```

### "What reminders do I have?"

```bash
haruyuki cron list
```

If you need to confirm the exact conversation a task is bound to, list with
explicit filters instead:

```bash
haruyuki cron list --agent "$AGENT_ID" --conversation "$CONVERSATION_ID"
```

### "Cancel the dog walk reminder"

```bash
haruyuki cron delete dog-walk-reminder
```

## Writing good prompts

The prompt is what gets sent to the agent when the task fires. Write it as a
message that will make sense when it arrives later, with enough context to act
on:

- **Good**: "The user asked to be reminded to review the PR for the auth
  refactor. Check if it's still open and nudge them."
- **Bad**: "reminder"

Include context about what the user originally asked for, so the response is
useful when the prompt arrives.

## Snapshot

`haruyuki export` packs `home/schedules.json` and leaves the read-only
`home/crons.v1.json` backup out of the package. Both export and import clear the
scheduler lease and every task lease (`scheduler_owner` null,
`scheduler_owners` empty, each task's `lease` null), so a package never carries
the exporting machine's scheduler claim into the target machine.

## Important notes

- **Minimum granularity**: 1 minute. Intervals under 60 seconds are rounded up.
- **Creation failures are loud**: a failed create exits nonzero and prints the
  reason; no task is stored. Check the exit code instead of assuming the task
  exists.
- **Default binding**: `haruyuki cron add` uses `--agent` first, then
  `$HARUYUKI_AGENT_ID`. Omit `--conversation` for a fresh conversation per fire;
  use `--conversation self` to capture `$HARUYUKI_CONVERSATION_ID` explicitly.
- **The scheduler is local**: there is no runner selection flag and no remote
  target. A schedule cannot run on another computer or in a hosted sandbox.
- **Autostart is separate from task deletion**: deleting the last task leaves
  the OS entry in place until `/schedule autostart off`.

## Cron expression reference

For `--cron`, use numeric 5-field cron syntax (named days/months, seconds, `?`,
`L`, and `#` are not supported):

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sun=0)
│ │ │ │ │
* * * * *
```

Common patterns (read in the task's captured timezone):

- `*/5 * * * *` — every 5 minutes
- `0 */2 * * *` — every 2 hours
- `0 9 * * *` — daily at 9:00
- `0 9 * * 1-5` — weekdays at 9:00
- `30 8 1 * *` — 8:30 on the 1st of each month
