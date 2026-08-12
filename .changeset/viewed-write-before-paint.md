---
"hunkdiff": patch
---

Persist per-file viewed state before the sidebar reports it, not after. Moving viewed writes
behind the review lock made them slow enough that the terminal showed `viewed n/m` while the
file was still being written, so a process that died in that window lost the toggle it had
already acknowledged.
