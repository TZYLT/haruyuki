# DreamReviewMark

Record that **this turn reviewed one memory file properly**, and say what was
checked. Dream is the unattended memory-maintenance run; its decay ranking keeps
the least-recently-reviewed files at the top, and a file that is clean but only
read (never changed) would otherwise stay there forever. This mark is how a run
says "this file is not rotting — I looked at it, and this is the evidence" so
the next ledger update can drop it from the queue.

**This is not a todo tool, and it is not a progress marker.** Do not call it for
a file you are about to look at, or one you merely opened. Calling it **is** the
claim that this turn reviewed the file at the depth you name:

- `skim` — checked that the file's purpose, pointers and index row still hold;
- `structure` — checked frontmatter, headings, links and index placement;
- `content` — read the content and verified it against the current facts.

`evidence` is **required** and must be one line (at most 200 characters): which
links, index entries, sections or contradictions you actually checked. It goes
into the decay index and the run report, so a mark without evidence is not a
review.

What the mark does **not** do: it does not commit, edit or move anything (use
`MemoryCommit` for that), and it does not clean a file whose content is still
wrong — a mark only says the review happened. If the file needs work, do the
work first, then mark the result.

`path` is relative to the memory repository root (for example
`system/human.md` or `projects/acme.md`) and must name a file that exists.
Absolute paths, `..`, `.` and `.git` are refused. Call it once per file per run:
the harness reads the marks when the run ends and deletes them.
