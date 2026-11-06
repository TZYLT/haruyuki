Search this agent's own transcript and memory **by meaning**, using the vector index that passive recall builds. Use it when a keyword search would miss the point — "where did we discuss the retry backoff", "what did I decide about the cache key" — or when you want a passage you already know exists in an earlier conversation or a memory file.

Each hit carries its corpus (`transcript` or `memory`), its exact locator (a conversation and message number, or a memory path and line range), its cosine score, and the passage text. Results are sorted by score; the same 0.35 cosine safety floor passive recall uses applies, so an unrelated passage cannot be returned as a weak match.

- `query` (required) is the text to search for. It is embedded with the configured model, so a sentence or a question works better than a few keywords.
- `scope` (optional) is `transcript`, `memory`, or `both` (default). A scope with nothing indexed yet is an error that says so, not an empty result.
- `limit` (optional) is how many passages to return: 5 by default, at most 20.

**Every answer discloses the index's age.** The first line is `Index as of <time> · lag <duration> · <precision> · <units>, <chunks>`, where the as-of time is the **oldest** committed unit among the units searched — the point through which the whole searched corpus is guaranteed to be current. When the lag reaches 5 minutes the answer adds a line telling the user to run `/recall embedding build`. Treat a stale index as evidence of what was known then, not as the current state of the conversation or memory.

**This tool reads; it never writes.** It does not index, refresh, or repair anything, and it does not change the conversation. It excludes hidden conversations (reflection runs, dream sessions, subagent forks) by the same rule passive recall uses; it can never surface one or create one. The current conversation is included on purpose: an explicit lookup is you asking to see something again, so the in-context exclusion that governs passive injection does not apply here.

**There is no lexical fallback.** If vector recall is off, the embedding model is not installed, or the index has not been built, the tool returns an error that names the fix (`/recall embedding on`, `/recall embedding connect`, `/recall embedding build`). It will not quietly run a keyword search: an unavailable index must never be mistaken for "nothing matched". For plain keyword search over files, use Grep; for the conversation text itself, use SessionRead or TopicQuery.
