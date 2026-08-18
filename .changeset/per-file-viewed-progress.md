---
"hunkdiff": minor
---

Add GitHub-PR-style per-file viewed state. Press `v` to toggle the selected file with a
sidebar `✓`, use `>` / `<` to jump between unviewed files, and follow `viewed n/m` progress
in the menu bar. Repo-backed reviews persist progress in `.hunk/review-state.json` and
automatically unview files whose diffs change. Agents can update viewed state with
`hunk session viewed` and read viewed fields from daemon v5 session snapshots.
