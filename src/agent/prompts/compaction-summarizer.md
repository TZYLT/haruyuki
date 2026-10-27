<!-- WIP: 文案待用户替换 -->

# Compaction summarizer — fixed template (structure only)

This file is the **fixed template layer** of the compaction summarizer prompt
(requirement §5.7 layer 1). It is not sent as a system prompt: the summarizer's
system prompt must stay byte-identical to the conversation's frozen prefix
(requirement §5.2.2), so this template travels as the body of the single user
instruction the summarizer appends after the projected context.

The wording below is a **placeholder**. The structure — the two products, the
four restricted fields, the topic-boundary rules, and the reply shape — is the
contract the parser enforces; do not change it without changing
`src/backend/local/compaction-summarizer.ts`.

## Role

[Placeholder: who the summarizer is, in what voice it writes, and the reminder
that this is a long-running companionship conversation rather than a work log.]

## What one reply produces

One JSON object containing two things:

1. **Topic boundaries** — where each topic of this conversation starts, plus a
   short section for each topic.
2. **An overview** — a fixed four-field continuity record plus one free
   narrative.

## Topic boundaries (`topics[]`)

- A topic is identified by its **first message**, `startMessageId`. It must be
  the id of a real message from the input list the host appends below — never an
  index, never an invented id.
- The first topic starts at the **first message of the input**; every later
  topic starts **later** than the previous one. The topics therefore cover the
  whole input: contiguous, no hole, no overlap, nothing left off the end.
- A topic is a *single point* (its start). Its end is the next topic's start (or
  the last input message for the final topic).
- **Respect existing boundaries.** The host lists the existing topic markers
  below. Never define a topic across an existing boundary, and never re-mark a
  message id that already has a marker. Add boundaries only where one is missing.
- `title`: short, ≤ 60 characters, unique among the topics of this reply.
- `section`: non-empty, ≤ 600 characters. It should be enough to pick the topic
  up again later (outcome, what is still open, the key detail) — not a second
  narrative.

## The overview

### Restricted sections (`overview.restricted`) — all four are required

Each field must be present and non-empty. They are the product's continuity
guarantees, not a summary of the work:

| field | what goes in it |
|---|---|
| `open` | 未决与后续 — what is unfinished, and what comes next. |
| `errors` | 错误与修正 — approaches that failed or were ruled out, and what replaced them. |
| `relationship` | 关系与情绪线 — how the relationship and the emotional line have moved. |
| `memoryIndex` | 记忆文件索引 — memory-repository paths worth knowing about, one line each (work files belong here too). |

Key facts and standing preferences do **not** go here: the memory system owns
them. The overview only has to keep this conversation continuous.

### Free section (`overview.narrative`)

[Placeholder: the story so far — how the topics connect, how the mood turned,
which moments were pivotal. Target 500–800 words, no forced sub-structure, and
the remaining budget goes to whatever the conversation cared about most. It must
not be empty.]

## Reply shape

Reply with **exactly one JSON object** and nothing else — no prose before or
after, no code fence:

```json
{
  "topics": [
    {
      "title": "Short unique title",
      "startMessageId": "ui-msg-…",
      "section": "Section text for this topic (≤ 600 characters)."
    }
  ],
  "overview": {
    "restricted": {
      "open": "…",
      "errors": "…",
      "relationship": "…",
      "memoryIndex": "…"
    },
    "narrative": "…"
  }
}
```
