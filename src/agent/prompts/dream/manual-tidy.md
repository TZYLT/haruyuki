# tidy — dream work manual
## 目标与边界

tidy is the only tier that tidies. Its job is to leave the memory repository measurably better: fewer dangling links,
complete indexes, no oversized files, and a written record of what changed and what is left. It is the highest-value tier
— most runs should finish tidy before spending budget elsewhere.

tidy may repair links and indexes, split oversized or append-style files, archive stale material, rewrite a contradictory
or sourceless statement after checking the evidence, and record per-file resume points. It may not restructure the whole
repository in one go, migrate v1 to v2, rename files (see 4.2), delete content without evidence, touch anything outside
the memory repository, or break the layout invariants.

**Unit** = one atomic change scope: the target file plus at most 5 closely related files, and at most 60k characters read
in the unit. One unit = one commit + one index update. Aim for 1–3 units per target; a bigger target is split into
segments with a `next:` resume point.

Read the layout block first: every index rule below depends on the runtime format and the core set. The rest of the seed
is ordered for reading — manifest, changes, decay, core cost, deferred plan, notes.

## 工作分级（各档自己的名字）

**L1 — mechanical repair** (low risk, high certainty): dangling links, missing `MEMORY.md` indexes, missing or invalid
frontmatter, duplicate headings, wiki-links that point at nothing. Do these first: they are cheap, verifiable, and never
need a judgement call.

**L2 — structural tidy** (medium risk, needs a link check): merging duplicate notes, moving or splitting directories,
rebuilding a timeline. Every move must update the indexes and links in the same unit.

**L3 — content disposal** (high risk, needs evidence): deleting or rewriting content, resolving a contradiction,
archiving. Evidence goes in the report and git history is the rollback point; check references before deleting anything.

## 工作流（S1…S5 或等价）

The decay table is a reading list, not a to-do list. Four columns: `path | decay | size | note`. `decay` is a sort key —
higher means staler and/or more important, so look there sooner, but do not follow it blindly. `size` is the character
count, for estimating effort. `note` holds the per-file `next` resume point: if the top-1 file has one, start from it
rather than from the top. Directory weights (core 1.5, `reference/` 1.0, other 0.5, `draft/` 0.3, `archive/` 0.1,
`skills/` 0, indexes 0.2; the report excluded) only explain the order — do not recompute them.

### S0 — entry (two doors, notes first)

1. **Pending notes come first.** If a note concerns tidy work, the target is the object the note names; reserve at most
   50% of the available budget for it. When a note names no file, match its text against index `description` fields and
   headings, take the best match, and report the mapping and why. Conflict order: layout invariants > notes > decay.
2. **Otherwise the decay top-1.** Do not filter by file size and do not require a number of previous attempts. If that
   file carries a `next` note, start from the resume point.
3. **Neither → report "no work".** End the tier with an honest empty report; do not invent work and do not move on to
   another tier.

### S1 — effort estimate (not an eligibility test)

- Available budget = 65% of the run budget (recommended target); 85% is tidy's soft ceiling.
- The target file's work should stay under 50% of what is available (roughly 1.3 × B thousand characters; B = 100k → about
  43k characters).
- A target bigger than that is **not skipped**: downgrade it to segmented processing — read a part, change a part, commit,
  record `next:`.
- Wrap-up first: when less than one complete unit remains (read + change + commit + index ≈ 8–10k tokens), open no new
  unit. If the budget cannot cover even one atomic change: partial commit + `next:` + report "budget insufficient for this
  unit" — a budget-setting problem; do not request more.

### S2 — index chain (repair only what is related)

- Scope = every level from the target file up to the root, plus the directories actually changed this turn. **No
  repository-wide scan**: a library-level invalidation caused by one change is not worth it.
- **v1 (legacy)**: indexes are optional. You may write a root `INDEX.md` (≤40 lines: clusters and when to enter); **never
  create a root `MEMORY.md`** — it flips the runtime format. Create a directory index only when the directory holds more
  than 5 files. Memory files carry `description` frontmatter only (legacy `limit` / `read_only` allowed); there is no
  `name`.
- **v2**: every directory needs its `MEMORY.md`; index files carry no frontmatter; directory indexes use plain relative
  markdown links; **build the index before the file**, and commit a new file together with its index line.
- Accept both link syntaxes: `[[path]]` (append `.md` and look it up) and `[text](path)` (resolve relative to the current
  file). A link is valid if either resolves.

### S3 — seven steps (each is a three-line card: detect / act / evidence)

**4.1 Archive** — Detect: last commit older than 90 days and the file is a one-off investigation or an environment
snapshot. Act: move it to `archive/YYYY/`, register it in the parent index, leave a pointer at the old location. Evidence:
move list + link check.

**4.2 Naming drift** — Detect: the file name no longer matches its `description`, one entity has several names, or the
content outgrew the name. Act: **do not rename** — split out a new file and leave a 3-line stub (original file name / date
+ pointer / index re-pointed at the new file). The stub does not participate in decay; delete it only when it has no
backlinks and no index entry. Evidence: stub + new index line.

**4.3 Core in / out** — Detect: only when the target is in the core set; read the core cost table first. Act: move detail,
evidence, long arguments and on-demand examples to `archive/core-<topic>.md`, leave a cue and a pointer in core, move
necessary cues/preferences/instructions back. Do not delete; never touch persona identity or user identity; never create
`human.md` / `human/` duplicates. Judge by the doctor's "~10% up or down" soft guide. Evidence: per item, "moved out /
moved in + new location".

**4.4 Length explosion / append-style** — Detect: over 20k characters (v2 hard limit) or over 10k (target), or several
sections of one file on the same topic. Act: split on topic boundaries (not by line count), each block targeting ≤10k
characters but not forced; every block stays logically complete. Evidence: character counts before/after + index.

**4.5 Contradiction / doubt** — Detect: the same entity with different values, unsourced assertions, clearly outdated
statements. Act: order the evidence — sourced over unsourced, original conversation findable over not, dated over undated,
newer over older. If none wins, keep both, mark `置信度: 低 / 待验证`, and add the date. Evidence: quoted source / conversation
id.

**4.6 Time and source** — Detect: event order unclear, or an as-of date is missing and changes the reading. Act: use
`SessionRead` / `TopicQuery` on the original conversation (≤1 call per unit); mark inferred order `（推测顺序：A 先于 B）`.
Evidence: source citation; if not found, mark it unresolved — do not guess.

**4.7 Grouping scattered notes + timeline** — Detect: the same topic lives in two or more files. Act: gather the directly
related content into one home (≤5 files per move), leave pointers elsewhere. Timeline lines read
`- YYYY-MM-DD event (source)`. Evidence: move list + link check.

### S4 — loop and stop

- After finishing a target, if less than 60% of the target's allowance was used and at least one unit remains, return to
  S0 for the next target. There is no limit on the number of targets.
- Three consecutive targets with no substantive change (<10 lines, or only indexes/the report touched) → stop and report
  "the repository shows no clear room for improvement; remaining budget unused".
- At 85% → wrap up only; at 100% → hard stop.
- The closing report must contain: utilization, the reason the tier ended, the three lists below, and per-unit evidence.

### next / deferred / blocked

- `next` is per file and lives beside `note` in the decay entry (shown in the table's `note` column). It records where the
  next run should resume for that file; `DreamReviewMark` clears it.
- `maintenance/dream-plan.md` holds the deferred plan (≤20 entries): **continue items** (referencing a per-file `next`),
  **blocked** items (three failed attempts → report and ask the user to decide), and **mechanical items** (do them when
  budget is spare).
- Every unconsumed entry gets `attempts + 1` each run. The report's three lists — `consumed` / `still-deferred` /
  `blocked` — are the only acceptance record.

### Mode discipline and invariants

Four invariants hold in every mode and against every note: (1) never create or delete a root `MEMORY.md`; (2) never write
`.memfs.config.json`; (3) never change `.git/letta-memory-layout-policy`; (4) when the policy and the format disagree,
report it and do not fix it.

v2 adds two: build the index before the file, and commit a new file together with its index line. `shared-memory` mode:
report only, do not restructure, until the conflict semantics are defined.

### Done definition (DoD)

- At least one commit this run (or an honest "no work" report), plus index updates and the report.
- The decay distribution improved: covered files' decay went down, or a `DreamReviewMark` with evidence was left.
- The report contains the three lists: `consumed` / `still-deferred` (with attempts + 1) / `blocked`.

## 检查清单

- [ ] The entry point was notes first, then decay top-1; I did not pick a file at random.
- [ ] The unit stayed within the target + 5 related files and 60k characters.
- [ ] Available budget was estimated at 65%, and the target's work stayed under 50% of it.
- [ ] Every changed file has its index and links updated in the same unit.
- [ ] v1: no root `MEMORY.md` was created; v2: every touched directory has its `MEMORY.md`.
- [ ] Both link syntaxes were checked, and no dangling link was left behind.
- [ ] No file was renamed; naming drift used the new-file + stub pattern.
- [ ] Deletions and rewrites have evidence in the report.
- [ ] `next` / `deferred` / `blocked` are recorded, and each unconsumed item got `attempts + 1`.

## 常见陷阱

- ❌ Batch-renaming files, which breaks every link at once. ✅ Do not rename: split out a new file and leave a stub, then
  update the index.
- ❌ Deleting a file without checking references. ✅ Search backlinks and index entries first.
- ❌ A commit reason like "update memory". ✅ Say what changed: "tidy: split system/human.md into cue + archive".
- ❌ Scanning only the root and missing subdirectories. ✅ Follow the target's index chain to the root.
- ❌ Treating the decay table as a to-do list and only ever fixing the top row. ✅ Use it as a reading order; review marks
  and `next` move the queue on.

## 示例

A short, competent run on a v1 repository: the decay top-1 is `system/human.md` with `note: "next: from 4.3"` and the seed
reports 2 dangling links and 3 files over 10k characters. S0 takes the file; S1 estimates 9k characters of work against a
43k-character allowance; S2 finds the root `INDEX.md` (24 lines) and `system/` (4 files, no directory index needed); S3
card 4.4 splits the file on topic boundaries into `system/human.md` (7.2k) and `archive/core-notes.md` (6.8k); S4 stops
after one unit. Report evidence: "system/human.md 14,100 → 7,200 chars; archive/core-notes.md added; both INDEX.md links
verified; dangling links 0/0".

## 本轮执行

This turn you handle **tidy only**. Start at S0 with the seed's pending notes; if there are none, take the decay top-1.
Estimate the effort before reading deeply (S1), repair only the index chain you touch (S2), and process one unit at a time
with the seven cards (S3). Commit each coherent unit as you go. When the budget or the loop rule says stop, wrap up (S4),
then write the report body with the three lists and the evidence. End the turn at the tier boundary; call `DreamDone` only
if the whole run must stop now.
