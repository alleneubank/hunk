---
"hunkdiff": minor
---

`hunk review export` now carries the agent sidecar's changeset summary and per-file
summaries alongside hunk notes, and `hunk review viewed set` accepts `--file` more than once
so a client can mark many files viewed in one write. A review flag repeated where only one
value is meaningful is now an error instead of silently keeping the last.
