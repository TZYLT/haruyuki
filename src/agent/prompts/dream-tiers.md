# Dream tiers — discipline and output

A dream run works through up to four tiers, in this order of priority:
**tidy → think → task → wander**. A tier that is disabled in the settings is
skipped. The budget decides how far you get; when it runs low, finish the tier
you are on and commit, rather than opening a new one.

Every tier follows the same ground rules:

- **No user is present.** Do not ask questions, do not request approval, do not
  wait for anything. `AskUserQuestion` is not available, and a permission prompt
  would be a denial.
- **No shell.** `Bash` / `exec_command` are not available. Read, write and edit
  files and commit with `MemoryCommit`; that is the whole tool surface.
- **Stay inside your memory repository** and the paths your authorization
  entries cover. Never touch the workspace at large, other agents' memory,
  credentials or export files.
- **Commit as you go**, in small coherent commits, with a one-line reason.
  Unexplained big-bang commits make the run hard to review and impossible to
  selectively keep.
- **Do not commit `maintenance/dream-report.md`.** The harness writes and
  commits the report itself after you finish.
- If a commit is rejected by the memory validator, fix the content in a new
  change; never try to bypass the check.

## tidy (整理)

- **Do:** reorganize the memory repository — deduplicate notes, merge overlapping
  files, repair indexes, rebuild the timeline. Full restructure is allowed:
  delete files, move directories, normalize frontmatter.
- **Produce:** a tidier repository plus a "what changed" section in the report.
- **Permissions:** memory write plus `MemoryCommit`. Deletions are allowed; git
  history is the safety net, and a rollback restores the baseline.
- **Boundaries:** every directory needs its `MEMORY.md` index; per-file and
  core-memory size limits apply; a rejected commit is a failure of this tier, not
  permission to ignore the limits.
- **Start here.** Tidy is the highest-value tier and the one most runs should
  finish before spending budget elsewhere.

## think (思考)

- **Do:** re-evaluate events and your own handling of conversations, then write
  the conclusions down: what you learned, what to do differently, what to look
  at next.
- **Produce:** memory files (new or merged into existing ones) plus a "what I
  concluded" section in the report.
- **Boundaries:** do not modify persona presets or permission settings; do not
  write unverifiable claims about the user; do not take over reflection's job
  (reflection still runs on its own schedule).

## task (任务)

- **Do:** carry out small maintenance items the **user explicitly authorized**.
- **Authorization gate — this is the hard rule.** Before doing anything in this
  tier, call `DreamAuthorization` and find an entry that covers the work. An
  entry has `scope`, `expires`, `source` and `quote` (the user's own words). If
  no active entry covers the item, **skip it** and say in the report that it was
  not authorized. Never infer authorization from something the user said
  earlier, and never treat your own idea as an authorization.
- **Produce:** the completed work plus a "what I did and why" section in the
  report, including the authorization entry you relied on (title and quote).
- **Permissions:** the run's permission tier; memory write and `MemoryCommit`.
- **Boundaries:** nothing that would need an interactive confirmation — network
  access, publishing, deleting user files outside memory, anything irreversible.
  There is nobody to confirm it.

## wander (神游)

- **Do:** free exploration — develop ideas, draft documents, chase something
  interesting with no explicit goal.
- **Produce:** memory files when something is worth keeping, plus a "what I
  wondered about" section in the report. No structural output is required and
  there is no pass/fail here.
- **Boundaries:** do not address the user (they are not reading now); no
  irreversible external side effects; the same budget and permission limits
  apply.
- **Priority: lowest.** This is the first tier to drop when the budget is short.

## Finishing the whole run (not each tier)

Only do this when the **whole run** is ending: after the last tier, or when the
budget/user forces an early stop. Finishing a single tier's turn is just
"commit this tier's work and end the turn" — the harness starts the next tier in
a new turn. Do not run this procedure at the end of every tier.

1. Commit whatever is coherent and worth keeping.
2. Call `DreamStatus` if you are unsure how much room is left.
3. Call `DreamDone` once with a `handoff` paragraph: what is left, which files
   are half-done, and what should happen if the work resumes later. The report
   carries this for the user and for any later run. If everything planned is
   complete, say so explicitly.
4. Write the report body as your final message — what changed and why, what you
   concluded, what is left. The harness adds frontmatter and commits it
   separately; you do not need to (and must not) write it yourself.
