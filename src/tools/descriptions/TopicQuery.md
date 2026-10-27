List the topics this agent has marked in its conversations, newest first — and, on request, the conversation a marker covers.

Use this to answer "what did we work on", to find the conversation a decision was made in, or to confirm that a topic you just marked was recorded. Each row carries the topic title, when it was marked, which conversation it belongs to, who marked it (agent, user, or a compaction summarizer), the first line of its section when one was written, and the topic's `topic_id`.

- `keyword` (optional) matches the title and the section, case-insensitively; separate words must all appear.
- `days` (optional) restricts to topics marked in the last N days.
- `session` (optional) restricts to one conversation. Conversations the user hid are excluded unless you name one here.
- `limit` (optional) keeps only the newest N matches.
- `topic_id` (optional) narrows the result to one topic; it is required by `include: "full"`.
- `include` (optional) picks how much comes back: `sections` (default), `excerpt`, or `full`.

**Two steps, like paging.** Start with the default listing. Then ask for the text:

- `include: "excerpt"` adds the first and last few messages of each matching topic, at most 1,000 characters per topic. This is the cheap way to recognise a topic you are not sure about.
- `include: "full"` prints one topic's messages, addressed by `topic_id`, capped at 8,000 characters. `keyword`, `days`, `session` and `limit` do not apply to it — it names one topic. Messages that do not fit are reported at the end; the count is never silently dropped.

The text is the conversation itself: user and assistant prose, with reasoning, tool calls, tool results and injected reminders removed. A compaction summary appears as its summary text, not as raw data. Images appear as `[image]`. You do not need — and cannot get — a file path or a message id to read a topic; ask for the tier you need instead.

The listing is capped at 4,000 characters. If it is truncated, the notice says how many topics were shown and how to narrow the query — narrow it rather than assuming the omitted ones do not exist.

Topics are metadata, not context: querying them changes nothing about the conversation. Markers only exist where someone called TopicMark or used /topic, so an empty result means nothing was marked, not that nothing happened in the conversation.
