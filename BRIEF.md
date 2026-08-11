# BRIEF — Local review contract

> Law doc for the local review contract (`.hunk/` review state, `hunk review export`, and
> the VS Code surface that consumes them), present-tense, no narrated history — git is the
> changelog. The Boundary and ratified Decisions amend only with human confirmation; the
> driver appends provisional Decisions, marked and dated. Floor waivers are dated Decisions
> below.

## Bar

A reviewer opens a local changeset outside the terminal, reads the agent's rationale
beside the code it explains, leaves comments, closes the editor, and comes back to find
every comment exactly where they left it or honestly marked outdated — with no daemon, no
session, and no terminal required.

## Dimensions

The few axes "good" decomposes into. When this document doesn't cover a decision, resolve
it in favor of these.

- **Durability** — review state written by any surface survives process exit, and is on
  disk before the user is told it was saved.
- **Anchor honesty** — a comment is shown against the content it was written against, or
  visibly marked outdated. Never a third option.
- **Single contract** — changeset normalization, file ordering, note matching, and viewed
  invalidation have exactly one implementation, shared by every surface.
- **Reachability** — the model is obtainable with no daemon, no registered session, and no
  TTY.
- **Non-fatality** — review metadata never ends a review. Derived state (viewed) degrades
  to empty; authored content (comments) is preserved and the failure reported.

## Floors

The minimum on each dimension, _with how it's measured_. The gate, not the ceiling.

| Dimension       | Floor (threshold + measurement)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durability      | A comment acknowledged to the user is readable from disk by a separate process. Measured: integration test writes via one process, reads via another. Two concurrent writers lose nothing — two-writer test.                                                                                                                                                                                                                                                                                          |
| Anchor honesty  | No generated edit sequence places a comment on non-matching content. Measured: property test over generated edits (insert/delete/move above, at, and below the anchor) asserting each comment is correctly anchored or `status: "outdated"`.                                                                                                                                                                                                                                                          |
| Single contract | Export payload is field-identical to `hunk session review --json` for file identity, order, and hunk ranges on the same changeset. Measured: differential test against a fixture repo. A second implementation of matching or ordering fails review outright.                                                                                                                                                                                                                                         |
| Reachability    | `hunk review export --json` succeeds with the daemon killed, no session registered, and stdin not a TTY. Measured: CLI contract test in `test/cli/`.                                                                                                                                                                                                                                                                                                                                                  |
| Non-fatality    | Viewed state: malformed, truncated, unreadable, and unwritable each degrade to empty without throwing. Comments: each of those reports unavailable and leaves the file byte-intact. Measured: unit tests per case, per store.                                                                                                                                                                                                                                                                         |
| Coexistence     | A binary without comment support reads and writes viewed state while leaving `.hunk/review-comments.json` untouched, and `.hunk/review-state.json` is byte-identical across a comment write/read cycle. Measured: fixture test against both stores.                                                                                                                                                                                                                                                   |
| Editor surface  | The extension activates, renders the export, creates a comment through `CommentController`, and the comment survives a reload. Measured: `bun run test:vscode` — real VS Code extension host via `@vscode/test-electron`.                                                                                                                                                                                                                                                                             |
| Repo gates      | `bun run typecheck`, `bun run lint`, `bun run check:docs`, `bun run test`, `bun run test:integration` — all green. Measured: a failure counts as pre-existing only once the same test is observed failing on a clean detached `upstream/main` in the same working copy; a separate worktree is not a valid baseline, because `bun install` there fails its `simple-git-hooks` postinstall and the whole PTY suite returns 0 pass. Never bare `bun test` — it also sweeps `test/pty` and `test/smoke`. |

## Oracle

- **Pre-ship (objective):** the repo harness runs the Floors. The anchor-honesty floor is a
  **property test over generated edits**, not example tests — the driver cannot tune it to
  flatter a chosen case, because the generator produces the cases. The single-contract
  floor is a **differential test** against the existing session projection, so drift is
  caught by construction rather than by discipline.
- **Pre-ship (judged):** each unit's review goes to a fresh-context reviewer carrying the
  unit's contract — intended outcome, invariants, acceptance evidence, and work explicitly
  deferred to a later unit. The driver never approves its own work. Severity floor: findings
  at or above **major** block.
- **Pre-ship (editor surface):** `bun run test:vscode` runs the real VS Code extension host
  through `@vscode/test-electron`, so behavioral claims about the extension are machine
  checked, not asserted. Behaviour is interior-verifiable; only **feel** — layout,
  ergonomics, whether the review reads well — needs the human, and that judgement is a
  Boundary item, not a floor.
- **Post-ship:** none. This is a local single-user tool with no telemetry.

## Never — instant fail

- A comment shown on a line whose content does not match any rung of the anchoring ladder.
- A comment acknowledged to the user but not on disk.
- Losing a persisted comment on merge, lock contention, export, or a read failure.
- Resetting, truncating, or overwriting `.hunk/review-comments.json` in response to a
  parse failure. Authored content is preserved and the failure reported.
- Bumping `.hunk/review-state.json` past v1 — an older binary discards the whole file.
- Export mutating `.hunk/`.
- A second implementation of changeset normalization, file ordering, note matching, or
  viewed invalidation — including inside the extension.
- The extension parsing git directly, or falling back to a partial model when export fails
  or its version does not match.
- Making the daemon, a registered session, or a TTY required to open a review.
- Committing `.hunk/` review artifacts.
- Weakening a floor, or removing a failing item without a dated waiver Decision and a
  replacement.
- Asking the human to lower the bar.

## Decisions

Calls already made, so the agent never re-asks. **This section grows.** Marked `ratified`
(human-confirmed) or `provisional` (driver call via the ladder — dated, ratified or
overturned at the boundary).

- **Priority / tradeoffs:** durability > reachability > liveness. Durability may force a
  redesign; a missing liveness feature may not. Correctness of anchoring outranks
  convenience of anchoring.
- **Assumptions:** single user, single machine, one workspace at a time. The `hunk` binary
  is installed and on PATH, or its path is configured.
- Daemon-backbone direction reversed in favor of durable disk + CLI export; daemon demoted
  to optional live-TUI attach. (2026-08-03, ratified — consult `agent-2026-08-03-acd51a`
  concurred.)
- Integrate by spawning the compiled binary, not by embedding the model in the Node
  extension host — the model path is Bun-shaped across 10 `src/core/` modules.
  (2026-08-03, provisional.)
- ~~Floor waiver — the VS Code surface has no automated oracle.~~ **Withdrawn 2026-08-03**:
  the waiver was wrong. `@vscode/test-electron` runs the real extension host, verified
  green in this repo at `editors/vscode` (4 passing against VS Code 1.131.0, including the
  `vscode.comments` capability the comment surface depends on). The Editor surface floor
  above replaces it; only feel remains with the human. (2026-08-03, ratified.)
- Comments persist in their own `.hunk/review-comments.json` under a strict-preserve
  policy; `.hunk/review-state.json` stays v1 and tolerant-reset. Why: measured against the
  current reader, a version bump makes an older binary discard the whole file and one
  corrupt entry already discards everything — derived state and authored content need
  opposite policies. (2026-08-03, ratified.)
- A sidebar filter hides rows but never changes what progress or unviewed navigation
  measure; both walk the whole review, and an active filter is named in the view header.
  Why: a reviewer who filters to one slice and walks it to the end would otherwise be told
  the review is finished while files outside the filter sit unviewed. The panel may hide
  rows; it may never make the review look smaller or more finished than it is.
  (2026-08-03, provisional.)
- Review badges ride a private `hunk-review-file://` scheme rather than the workspace file
  URI. Why: decorating the real file puts Hunk's badge on the explorer entry and the editor
  tab next to Git's decoration for the same file, saying something different. Review state
  belongs to the review. (2026-08-03, provisional.)
- The branch-comparison picker builds `<base>...HEAD`, three dots. Why: that is the diff a
  pull request shows — the branch against where it left its base, not against whatever the
  base has since become. (2026-08-03, provisional.)
- The picker's `main` prefill stays hard-coded. Why: detecting the default branch correctly
  across git, jj, and Sapling needs a new operation on the `ExtensionVcsAdapter` public
  contract, and shipping without it is good enough. Rejected on the way: reading
  `getDefaultBranch()` off the built-in `vscode.git` API — spawn-free and real, but git-only,
  and a colocated jj repo carries a real `.git`, so Hunk would review through the jujutsu
  backend while VS Code answered confidently about git. A plausible wrong default is worse
  than none. The adapter operation stays the correct fix if it is ever wanted; a `[review]
base` config key is the cheaper interim. (2026-08-04, ratified.)
- Agent-context auto-discovery is **target-keyed**: the conventional file is
  `.hunk/agent-context.<targetId>.json` for the current review target (working-tree,
  staged, range expression, show ref, or stash-show ref, plus sorted pathspecs). Bare
  `.hunk/agent-context.json` is never auto-loaded — only via explicit `--agent-context` or
  config. Why: a fixed bare path loads notes against the wrong changeset and can partially
  attach leftover ranges (modem-dev/hunk#540). (2026-08-11, provisional.)
- Agents obtain the conventional write path from `agentContextPath` on
  `hunk review export --json` — one machine-readable surface, not a second CLI command and
  not a memorized hash. (2026-08-11, provisional.)
- Interaction tests that assert pure viewport scroll set `initialCursorLine: "off"`. Why:
  the default marker mode remaps arrows to current-line movement, which is a different
  contract than step-scroll. (2026-08-11, provisional.)

## Boundary — requires the human

The loop never crosses these; they batch to the human handoff.

- **Publish:** any push, PR, merge, release, or npm/marketplace publish — per artifact, per
  ref. Nothing on this campaign is pushed by the loop.
- **Credentials:** live secrets, marketplace or registry tokens, biometric-gated actions.
  An auth failure is surfaced and stopped on, never routed around.
- **Judgement:** whether the review _reads well_ in VS Code — layout, ergonomics, density.
  The extension host harness proves behavior; it cannot judge feel.
