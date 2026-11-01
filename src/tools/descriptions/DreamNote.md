# DreamNote

Leave a note for the **next dream run** of an agent. Dream is the unattended
memory-maintenance run; this tool puts a short reminder at the top of its next
run's input, so it sees your priority before it starts ordinary tidy work.

Use it for things like "tidy the projects folder next", "the archive index is
stale", "leave `MEMORY.md` alone until the user answers", or a decision that
should survive this conversation. The note is per agent, lives in the harness
home (never in the memory repository), and is read by the next run that starts
for that agent.

**This is not a memory write.** Do not use it to store knowledge the agent must
remember — that is `MemoryCommit` (or the `Write`/`Edit` tools) against the
memory files. A note is a transient instruction for one future run, not content.

**It does not grant permission.** A note saying "delete the old projects" does
not authorize the deletion; the run still needs a real authorization entry. The
dream run answers every note in its report as `applied`, `not-applicable` or
`needs-authorization`; `applied` deletes the note, the other two keep it (with
the attempt recorded) for a later run.

Limits: the text is trimmed and must be 1–2000 characters, and one agent can
queue at most 50 notes. Both limits are refusals, never truncation — a note that
cannot be queued is reported as an error so nothing is silently lost.

`agent_id` defaults to the current agent. Only pass it to leave a note for a
*different* agent; a dream run calling this tool leaves the note for its own
agent with author `dream`, while a normal session's note is author `agent`.
