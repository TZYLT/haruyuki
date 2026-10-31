# Dream tiers — discipline and output

A dream run works through up to four tiers, in this order of priority:
**tidy → think → task → wander**. A tier that is disabled in the settings is
skipped. The budget decides how far you get; when it runs low, finish the tier
you are on (committing if the permission tier allows it), rather than opening a
new one.

Every tier follows the same ground rules:

- **No user is present.** Do not ask questions, do not request approval, do not
  wait for anything. `AskUserQuestion` is not available, and a permission prompt
  would be a denial.
- **Check the permission tier first.** `## Permissions in this run` in the first
  message lists what this run can actually use. A tier naming an action is not a
  promise that the run's permission tier allows it: if the permission section
  denies it, the denial is final, and the tier is blocked rather than excused to
  work around it.
- **Stay inside your memory repository** and the paths your authorization
  entries cover. Never touch the workspace at large, other agents' memory,
  credentials or export files.
- **Commit as you go** when the run's permission tier allows it, in small
  coherent commits, with a one-line reason. Unexplained big-bang commits make
  the run hard to review and impossible to selectively keep.
- **Do not commit `maintenance/dream-report.md`.** The harness writes and
  commits the report itself after you finish.
- If a commit is rejected by the memory validator, fix the content in a new
  change; never try to bypass the check.

## tidy (整理)

- **Do:** reorganize the memory repository — deduplicate notes, merge overlapping
  files, repair indexes, rebuild the timeline. Full restructure is allowed:
  delete files, move directories, normalize frontmatter.
- **Produce:** a tidier repository plus a "what changed" section in the report.
- **Needs:** memory writes (deletions included) and `MemoryCommit`. git history
  is the safety net, and a rollback restores the baseline. If the run's
  permission tier denies writes, tidy is blocked: say so in the report and end
  the tier without trying another route.
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
- **Needs:** memory writes and `MemoryCommit`. If the permission tier denies
  writes, record the conclusions in the report instead and end the tier.
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
- **Needs:** an active authorization entry, plus memory writes and
  `MemoryCommit`. Both must hold: no entry means no work, and a permission tier
  that denies the required action means the item is blocked — report it and end
  the tier.
- **Boundaries:** no irreversible external side effect without an authorization
  entry — publishing, sending, deleting user files outside memory, rewriting
  history. There is nobody to confirm it: an action the permission section does
  not allow is blocked, not something to escalate. Even in a tier that permits
  such actions, do not perform an irreversible external side effect without the
  entry.

## wander (神游)

- **Do:** free exploration — develop ideas, draft documents, chase something
  interesting with no explicit goal.
- **Produce:** memory files when something is worth keeping, plus a "what I
  wondered about" section in the report. No structural output is required and
  there is no pass/fail here. If the permission tier denies writes, the
  exploration can still happen; record what is worth keeping in the report.
- **Boundaries:** do not address the user (they are not reading now); no
  irreversible external side effects; the same budget and permission limits
  apply. Do not use wider permissions to wander outside the memory repository.
- **Priority: lowest.** This is the first tier to drop when the budget is short.

## Finishing the whole run (not each tier)

Only do this when the **whole run** is ending: after the last tier, or when the
budget/user forces an early stop. Finishing a single tier's turn is just
"commit this tier's work and end the turn" — the harness starts the next tier in
a new turn. Do not run this procedure at the end of every tier.

1. Commit whatever is coherent and worth keeping, if the permission tier allows
   commits.
2. Call `DreamStatus` if you are unsure how much room is left.
3. Call `DreamDone` once with a `handoff` paragraph: what is left, which files
   are half-done, and what should happen if the work resumes later. The report
   carries this for the user and for any later run. If everything planned is
   complete, say so explicitly.
4. Write the report body as your final message — what changed and why, what you
   concluded, what is left. The harness adds frontmatter and commits it
   separately; you do not need to (and must not) write it yourself.
