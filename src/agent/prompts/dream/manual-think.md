# think — dream work manual
## 目标与边界

think is the productive tier: it produces judgements, questions and abstractions from what is already recorded.
It does not clean accounts — merging, deleting and migrating belong to tidy. "Conjecture" here is a confidence
state, not a softening word.

think may add an inline conjecture next to a fact, add or revise one question card in core, or write one
synthesis volume. It may not merge, delete or move files, restate what is already written, write about the user
something that cannot be verified, or write a fact as a conjecture (or the reverse).

Do not create draft files: a file you write is a file that is accepted.

## 工作分级（各档自己的名字）

**A — inline conjecture.** Lands in an existing fact file, right next to the fact it thinks about. Cheap; one
judgement, a second thought about one record.

**B — question card.** Lands in the core set (v1 `system/**`, v2 root `*.md`). For a problem that keeps coming
back and needs the main agent and the user to discuss it.

**C — synthesis volume.** A standalone file, location your call (recommended: beside the source files). For a
large abstraction across several materials (a timeline, a person or theme judgement).

## 工作流（S1…S5 或等价）

### S0 — materials and budget

Prefer files this run's tidy already read or changed: their content is already in this conversation. Read new
material only when needed, and keep new reading ≤30% of think's available budget. One run = one theme (one line,
one question card, or one volume).

### S1 — find the gap

List what the records already say and where the gap is: a fact with no judgement, a question that keeps
recurring, a contradiction the records do not resolve. The gap is what this run's output fills; do not restate
what is already there.

### S2 — produce

**A (inline):** place it after the corresponding fact line, as close as the structure allows. One conjecture
line per fact; revise in place, date it `(2026-11-01，11-05 修订)`, never stack new lines. No "evidence" section
(the fact is next to it); a closing "where this could go" sentence is optional. At most 3 lines, in the same
shape as the neighbouring entries.

**B (question card):** check core first — revise an existing similar rule, or append one (append, never delete).
Content = a problem description with a dated instance + a solution proposal derived from what you know (what you
infer the user wants). Not "please let the main agent decide"; the wording must be easy for the main agent to
change once the issue is resolved.

**C (synthesis volume):** the structure may be trimmed, but 总体印象 and 依据 are mandatory. Open with the fixed
statement and the material list:

```markdown
> 梦游数据总结（2026-11-01）：全文基于既有记录，经总结与猜测推演形成；除明确标注"事实"处外，文中任何内容都不应作为事实依据。本文更新较慢，内容可能过时，请仔细甄别。
> 材料：[[a]]、[[b]]……

## 总体印象（猜想）
## 时间线
## 矛盾与根源
## 我的适应
## 依据
```

One volume per run, ≤20k characters; over that, split by logic (topic first, then time) into volumes that each
read independently. Rewrite in place (git is the rollback point) and list in the report which old claims you
removed. Record only the writing date in the volume header — there is no automatic "needs refresh" mechanism.

### S3 — states and confidence

Three states only:
- **事实** — a record, a quote, a dated event. Usable as evidence (cite the path or date).
- **猜想** — a judgement derived from facts. Not evidence; it may feed a weaker next layer.
- **未解** — a known gap you cannot fill (asked but unanswered, record missing). Not evidence.

State markers run alongside the source marker: `**(2026-11-01) 梦游猜想**：……`. Never use certainty words like
"conclusion" or "proof" about a person. Confidence is optional and unmarked by default: mark it only as
`（置信度：高；理由：……）` with at least 2 factual points behind it; unmarked means medium or low.

### S4 — conversation channel (expensive, do last)

- Prefer quotes already in memory files; do not re-read conversations.
- When you must read, use the user-only channel: `SessionRead` with `roles: ["user"]`, a keyword filter and
  "since the last think" — ≤200 messages and ≤10k tokens (about 2.5 characters per token).
- Strip automatic synthesis: `<system-reminder>` injections, compaction summaries, automated notifications, note
  echoes, and "user" text inside tool results.
- Quote only the date and the original words; do not reconstruct the dialogue.

### S5 — method discipline

1. A conjecture must be specific — it points at the record it rests on; not "he may be sensitive".
2. It must be falsifiable: if you cannot imagine what would make it wrong, do not write it (check yourself; do
   not write this check into the file).
3. Introduce no new entities — no person, event or date that is not in the records.
4. The first link of a logical chain must be a fact; the chain must be plausible and must not contradict known
   facts — if it does, downgrade to 未解 or mark the conflict.
5. Analyse contradictions, do not just record them: ask about the source, the time, record reliability, and
   whether the other party's line is actually consistent; explain what you can (as conjecture), write 未解 for the
   rest.
6. Depth is unlimited, but every layer must trace back to the material below; the budget decides the layers.
7. Prefer an uncertain conjecture to a confident judgement you do not have.

### S6 — self-check and report

- DoD: at least one output (A, B or C).
- The report has four items: materials (what was read), outputs (what was written, with confidence
  marks), the `## 需要商讨` section (≤3 items with the original words and date), and the old claims
  deleted (if any).
- Division with tidy: think writes content only, never structure — no merge, no delete, no move. When you create
  a file, add one minimal index line (a mechanical action); structural tidy stays with tidy.
- think's output is tidy's input: tidy's 4.5 (contradiction) and 4.6 (time and source) can converge on it, but a
  conjecture must never be written into tidy as a fact.

## 检查清单

- [ ] The run has one theme and at least one output.
- [ ] Every conjecture points at the record it rests on.
- [ ] Facts, conjectures and unresolved gaps are marked as such; confidence only where 2+ facts back it.
- [ ] A synthesis volume opens with the fixed statement and the material list.
- [ ] No merge, delete or move was done (that is tidy), and new files have their minimal index line.
- [ ] Conversation reading went through the user-only channel, within 200 messages / 10k tokens.
- [ ] The report has the four items, including `## 需要商讨`.

## 常见陷阱

- ❌ Writing a guess as a fact. ✅ Mark it `梦游猜想` and keep the fact quotable.
- ❌ A conclusion with no source. ✅ Cite the record, date or conversation id.
- ❌ Repeating a note that already exists. ✅ Revise in place; one conjecture line per fact.
- ❌ Using "conclusion" or "proof" about a person. ✅ Use the three states and the optional confidence.
- ❌ Treating a feeling as a judgement. ✅ Use only facts, or a conjecture with a traceable first link.
- ❌ Doing tidy's cleanup while producing. ✅ Content only; structure stays with tidy.

## 示例

The seed's recent changes show that tidy edited `system/human.md` this run. Reading it, I find the fact
"2026-10-29: the user asked for shorter answers" with no judgement next to it. I add one inline line:
"**(2026-11-01) 梦游猜想**：short answers matter more when the user is mid-task than when they are thinking out loud;
the 2026-10-23 correction points the same way." One output, no new file, no structure change. Report: materials
= `system/human.md` (read this run); outputs = 1 inline conjecture; `## 需要商讨` = none; deleted old claims = none.

## 本轮执行

This turn you handle **think only**. Start from S0 with what tidy already read in this run; find one gap (S1)
and produce one output (S2) — an inline conjecture, a question card, or one synthesis volume. Mark the states
honestly (S3), and use the user-only conversation channel only if the records are not enough (S4). Apply the
seven method rules (S5), then write the four-item report and stop. End the turn at the tier boundary; call
`DreamDone` only if the whole run must stop now.
