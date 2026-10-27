# Compaction summarizer · fixed template

This layer is the summarizer's **fixed template** (requirement §5.7 layer 1). It is
not sent as a system prompt: the summarizer's system prompt must stay byte-identical
to the conversation's frozen prefix (requirement §5.2.2), so this template travels as
the body of the **single** user instruction appended after the projected context.

Wording may change. Do not change the structure — the two products, the four
restricted fields, the boundary rules and the reply shape are the contract the parser
enforces; changing any of them means changing
`src/backend/local/compaction-summarizer.ts` too.

## Role

You are archiving a long-running companionship conversation. It may have been going
for a long time: work, moods, a relationship, a pile of unfinished things. You are
not writing a status report. What you leave behind has to be enough for the
conversation to continue tomorrow — what is still open, which roads are already
closed, where the relationship stands, and how the important things were actually
said.

Write the prose in the language the conversation uses. The four restricted headings
are rendered by the host; do not add headings of your own.

## One reply, two products

A single JSON object carrying:

1. **Topic boundaries** (`topics[]`) — where each topic of this conversation starts,
   plus a short section for each topic.
2. **An overview** (`overview`) — the four-field continuity record, plus one free
   narrative.

## Topic boundaries (`topics[]`)

- A topic is identified by its **first message**, `startMessageId`. It must be the id
  of a real message listed by the host below — never an index, never an invented id.
- The first topic starts at the **first message of the input**; every later topic
  starts **later** than the previous one. The topics therefore cover the whole input:
  contiguous, no hole, no overlap, nothing left off the end.
- A topic is a *single point* (its start). Its end is the next topic's start, or the
  last input message for the final topic.
- **Respect existing boundaries.** The host lists the existing topic markers below.
  Never define a topic across an existing boundary, and never re-mark a message id
  that already has a marker. Add boundaries only where one is missing.
- `title`: short, ≤ 60 characters, unique among the topics of this reply.
- `section`: non-empty, ≤ 600 characters. Enough to pick the topic up again later
  (the outcome, what is still open, the key detail) — not a second narrative.

## The overview

### Restricted sections (`overview.restricted`) — all four are required

Each field must be present and non-empty. They are this product's continuity
guarantees, not a summary of the work:

| field | what goes in it |
|---|---|
| `open` | What is unfinished, and what comes next. |
| `errors` | Approaches that failed or were ruled out, and what replaced them. |
| `relationship` | Where the relationship and the emotional line have moved, and how they got there. |
| `memoryIndex` | Memory-repository paths worth knowing about, one line each (work files belong here too). |

Key facts and standing preferences do **not** go here: the memory system owns them.
The overview only has to keep this conversation continuous.

### Free section (`overview.narrative`)

The story so far: how the topics connect, when the mood turned, which moments were
the forks. Target 500–800 words, no forced sub-structure; whatever budget is left
goes to what this conversation cared about most. It must not be empty.

## Reply shape

Reply with **exactly one JSON object** and nothing else — no prose before or after,
no code fence:

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
