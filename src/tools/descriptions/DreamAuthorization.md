# DreamAuthorization

Look up the user's explicit authorization entries before doing anything that
needs permission — the task tier exists only to carry out work the user wrote
down and authorized.

**No entry means no authorization.** Never infer permission from something the
user said earlier; if no entry covers the work, skip it and say so in the
report.

Entries live in the agent's memory repository, in `authorization.md` (or
`system/authorization.md` on legacy layouts). One entry starts at a `## ` heading
and has four required fields:

```markdown
## Tidy the projects folder
- scope: memory:projects/**
- expires: 2026-11-30
- source: local-conv-abc123
- quote: "整理一下 projects 下重复的笔记"
```

- `scope` — what the entry permits (`memory:projects/**`, a workspace path, or a
  short description);
- `expires` — `YYYY-MM-DD` (UTC, including that day) or `never`;
- `source` — the conversation the authorization came from;
- `quote` — the user's original words.

The tool reports each matching entry's title, scope, source conversation and
quote, and whether it is active. Expired entries are hidden unless
`include_expired` is true. Malformed entries are reported and ignored — they
authorize nothing.

This tool is read-only. It cannot create an authorization entry: the user (or
the main session recording the user's words) does that.
