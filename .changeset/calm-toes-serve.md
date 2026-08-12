---
"hunkdiff": minor
---

Add the `hunk review` command group: a headless JSON surface for editor clients. `review
export` emits a changeset snapshot with no daemon, session, or TTY, reusing the same
projection `hunk session review` serves; `review comment add/status/delete` and `review
viewed set` write review state through Hunk's own anchoring and strict-preserve store; and
`review file source` reads one side of a file through the VCS backend that loaded it.
Review comments persist to `.hunk/review-comments.json`, separate from viewed state, and
re-anchor to the code they were written against as the diff changes.
