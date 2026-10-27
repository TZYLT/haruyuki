List the topics this agent has marked in its conversations, newest first.

Use this to answer "what did we work on", to find the conversation a decision was made in, or to confirm that a topic you just marked was recorded. Each row carries the topic title, when it was marked, which conversation it belongs to, who marked it (agent, user, or a compaction summarizer), and the first line of its section when one was written.

- `keyword` (optional) matches the title and the section, case-insensitively; separate words must all appear.
- `days` (optional) restricts to topics marked in the last N days.
- `session` (optional) restricts to one conversation. Conversations the user hid are excluded unless you name one here.
- `limit` (optional) keeps only the newest N matches.

The result set is capped at 4,000 characters. If it is truncated, the notice says how many topics were shown and how to narrow the query — narrow it rather than assuming the omitted ones do not exist.

Topics are metadata, not context: querying them changes nothing about the conversation. Markers only exist where someone called TopicMark or used /topic, so an empty result means nothing was marked, not that nothing happened in the conversation.
