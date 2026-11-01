# DreamAuthorization

Look up the user's explicit authorization entries before doing anything that
needs permission — the task tier exists only to carry out work the user wrote
down and authorized.

**No entry means no authorization.** An empty file authorizes nothing. Never
infer permission from something the user said earlier, never widen an entry by
assuming what it "must have meant", and if no entry covers the work, skip it and
say so in the report.

**Do not write or edit an authorization entry to cover your own work.** That
violates the task-tier discipline. An entry must quote the user's own words; the
tool does not verify the quote against the conversation it claims to come from,
and "not verified" does not mean "fair to invent". Entries are written by the
user (or the main session recording the user's words), never by the task tier.
If you cannot point at a real user quote, there is no authorization.

There is exactly one carrier per memory layout, and this tool reads only that
one:

- MemFS v2 (root `MEMORY.md` present): `authorization.md`
- MemFS v1 (legacy `system/` core): `system/authorization.md`

If that file does not exist, the answer is "no authorization" and the tool
reports the path it expected. It does not search other locations, and an entry
found somewhere else is not an authorization.

One entry starts at a `## ` heading and has two required fields plus two
optional ones:

```markdown
## Tidy the projects folder
- quote: "整理一下 projects 下重复的笔记"
- expires: 2026-11-30
- scope: memory:projects/**          (optional)
- source: local-conv-abc123          (optional)
```

- `quote` — required; the user's original words;
- `expires` — required; `YYYY-MM-DD` (UTC, including that day) or `never`;
- `scope` — optional context; not a gate, and the tool never matches work
  against it;
- `source` — optional; the conversation the authorization came from.

An entry authorizes only what its quote says. Do not infer a scope from the
title, from `scope`, or from what the user did before. The tool reports each
matching entry's title, quote, expiry and (when present) scope and source
conversation, and whether it is active. Expired entries are hidden unless
`include_expired` is true. Malformed or empty entries are reported and ignored —
they authorize nothing, and no entry is ever half-read.

This tool is read-only. It cannot create an authorization entry.
