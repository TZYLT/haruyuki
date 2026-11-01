# SessionRead

Read a conversation as cleaned visible text: the user's messages and the
assistant's replies, without reasoning, tool arguments, tool output, system
reminders or other harness plumbing. Use it to recall what was said in a
conversation — it is the supported replacement for opening a transcript.

`Read` is a different tool: it reads a **file** from disk. `SessionRead` reads a
**conversation** by id (or the current one when `conversation_id` is omitted).
Do not try to read transcripts with `Read`.

Usage:
- `conversation_id` defaults to the conversation you are in.
- **Hidden conversations are never readable.** Reflection, dream and subagent
  runs are refused with an error. Do not try to work around that refusal.
- Message numbers count only visible messages, starting at 1. A page reports
  which numbers it showed; quote those numbers when summarizing.
- `message_start` / `message_end` select an inclusive range. `query` then keeps
  only messages whose text contains the keyword. `offset` pages through the
  result: repeat the same range and query and pass the reported `next offset`.
- `roles` keeps only the listed roles: `user`, `assistant` and/or `summary`
  (compaction summaries). Omit it to read every role. A **user-only channel** —
  when you need the user's own words rather than the agent's replies — is
  `roles: ["user"]`; it also drops automated summaries. The user-only channel is
  meant to be cheap: narrow it with a keyword and a `since` bound and keep the
  page small (roughly 200 messages or 10k tokens, i.e. `max_chars` around
  25000/2.5 for the character budget) instead of reading the whole conversation.
- `since` / `until` keep messages by their stored creation time, both inclusive.
  Pass an ISO date/time (`2026-11-01`, `2026-11-01T12:00:00Z`) or epoch
  milliseconds. A message with no readable timestamp is excluded while a bound
  is active. An unparseable bound is a parameter error, not a silently ignored
  filter.
- Role and time filters are applied after the text is cleaned and before
  `message_start` / `query` / `offset`, so message numbers still refer to the
  cleaned conversation and paging continues the same way.
- The result is capped by `max_chars` (default 8000). If a page ends with
  `next offset=N`, call again with `offset: N` to continue; otherwise the
  result is complete.
- The tool is read-only. It does not write, summarize or send anything.
