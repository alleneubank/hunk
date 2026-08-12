---
"hunkdiff": patch
---

Fix headless commands silently truncating output larger than one pipe buffer. `hunk pager`,
`hunk session`, and `hunk review` exited as soon as they had queued their payload, so
anything past the first 64 KiB was dropped while the command still exited `0`.
