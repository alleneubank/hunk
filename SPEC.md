# SPEC — Local review contract

Scope: the durable review artifacts and the read model that let a non-terminal surface
(first: a VS Code extension) act as a local PR review tool over a Hunk changeset. This
spec covers `.hunk/` review state, the review export command, and what the extension may
assume. It does not retroactively specify the TUI, the extension system, or the session
daemon.

## Problem

Hunk normalizes a changeset from git/Sapling/Jujutsu, matches agent-authored rationale
onto its hunks, and tracks per-file review progress. That model is the fork's real asset.
Today it is reachable only from a terminal:

- Review comments are never persisted. `LiveComment` (`src/core/liveComments.ts:18-27`)
  exists only in a live session's memory; no module in `src/` writes it to disk. A review
  tool whose comments die with the window is not a review tool.
- A session exists only inside a live TUI: `createSessionRegistration` has one production
  caller, `src/ui/runInteractiveApp.tsx:41`, immediately before `createCliRenderer`.
- The daemon's consumer API is 12 request/response actions with no subscribe
  (`src/session/protocolSchemas.ts:49-109`), so any external surface must poll a process
  that must already exist.

So the blocker for an editor-first review tool is **durability and reachability of the
review model**, not transport.

## Solution

Three layers, in dependency order:

1. **Durable review state** — persist comments in a **new** `.hunk/review-comments.json`,
   with content anchors so a comment survives an edit or reports itself outdated rather
   than silently pointing at the wrong line. `.hunk/review-state.json` stays v1 and
   viewed-only.
2. **Review export** — a one-shot `hunk review export --json` that runs the existing model
   path headless and emits a versioned snapshot. No daemon, no session, no TTY.
3. **VS Code extension** — spawns the installed `hunk` binary, renders with VS Code's
   native diff editor and `CommentController`, and reads/writes the same `.hunk/` state.

The daemon keeps its current job (brokering live TUI sessions for agents) and is not on
this path.

### Why export rather than embedding the model in-process

The model path is Bun-shaped — `Bun.file`, `Bun.spawn`, `Bun.spawnSync`, `Bun.TOML`,
`Bun.semver`, `Bun.stdin` across 10 `src/core/` modules including every VCS adapter
(`src/core/loaders.ts:342-343`, `src/core/fileSource.ts:67`, `src/core/config.ts:916`,
`src/core/vcs/git.ts:444`). VS Code's extension host is Node. Spawning the compiled binary
sidesteps the runtime mismatch entirely.

## Domain model

`loadAppBootstrap` (`src/core/loaders.ts:445-513`) already runs with no TTY dependency and
already has a non-TUI caller (`src/ui/staticDiffPager.ts:390`). Both
`createSessionRegistration` and `createInitialSessionSnapshot`
(`src/session/app/registration.ts:54-73`, `:95-117`) are pure functions of `AppBootstrap`,
and `buildHunkSessionReview` (`src/session/broker/projections.ts:114`) takes a plain
`{registration, snapshot}` entry. Export therefore composes existing pure functions:

```text
CliInput -> loadAppBootstrap -> AppBootstrap
         -> { createSessionRegistration, createInitialSessionSnapshot }
         -> buildHunkSessionReview -> SessionReview (+ review state from disk)
```

### Two stores, because they need opposite durability policies

Viewed state today (`src/core/viewedState.ts:7-19`): `{ version: 1, files: Record<path,
{patchHash, viewedAt}> }`, sha256 over `file.patch`, 30-day retention, best-effort
read/write at mode `0o600`.

Its reader is **tolerant-reset**: any schema failure anywhere discards the whole file
(`src/core/viewedState.ts:48-55`). Measured against the current reader:

| input                              | result                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| v1 entry with an extra key         | preserved verbatim — extra keys already pass validation |
| `version` bumped to `2`            | **entire file discarded**, viewed state included        |
| one corrupt entry among valid ones | **entire file discarded**                               |

That policy is right for viewed — it is derived, disposable, and auto-pruned at 30 days.
It is unacceptable for comments, which are authored content. Two consequences follow, and
together they are the reason comments get their own file:

- **A version bump is actively destructive.** An older `hunk` binary reading a bumped file
  discards everything, including viewed state it understands perfectly. Installed binaries
  are compiled snapshots, so old and new coexist routinely.
- **One file cannot carry two policies.** A corrupt viewed entry must not be able to
  destroy a comment.

So comments live in `.hunk/review-comments.json` at its own `version: 1`, under a
**strict-preserve** policy: unparseable content is never silently discarded. A comment
carries a line anchor, content anchors captured at write time, and a lifecycle `status`.

## Requirements

### Durable review state

- **REQ-REVIEW-001** — `.hunk/review-comments.json` persists user review comments per
  file, at its own `version: 1`, independent of `.hunk/review-state.json`.
- **REQ-REVIEW-002** — `.hunk/review-state.json` keeps schema v1 and its viewed-only
  shape. No migration ships, so an older `hunk` binary keeps reading it correctly.
- **REQ-REVIEW-003** — The comment store is **strict-preserve**: unreadable or malformed
  content is reported and the file is left byte-intact, never silently reset or
  overwritten. A read failure degrades the review to "comments unavailable", never to
  "comments empty".
- **REQ-REVIEW-004** — Each comment records, at write time: `id`, `side`, `line`,
  `originalLine`, a hash of the trimmed anchor line's text, bounded before/after context,
  the hunk header, body, author, `createdAt`, `updatedAt`, and `status`.
- **REQ-REVIEW-005** — On load, each comment is re-anchored by a fixed ladder: unchanged
  `patchHash` keeps the line; else exact anchor-line-text match; else context match; else
  hunk-header plus relative offset; else `status: "outdated"` with the body and original
  location preserved.
- **REQ-REVIEW-006** — Re-anchoring never silently moves a comment to a line whose content
  does not match one of the ladder's rungs.
- **REQ-REVIEW-017** — Matching anchor-line text is necessary but not sufficient at any rung,
  including the same-line rung. Where an anchor recorded surrounding context, a candidate row
  must still share at least one recorded context line; a candidate sharing none resolves to
  `outdated`. Low-entropy lines — `}`, `});`, `return;`, `*/` — otherwise let a comment follow
  its own text into unrelated code and report itself active, satisfying REQ-REVIEW-006's
  letter while breaking its intent. An anchor that recorded no context is exempt, having
  nothing to corroborate against.
- **REQ-REVIEW-018** — A comment is either the **root** of a conversation or a **reply** to
  one, and the two shapes are exclusive on disk: a root carries an anchor and a status and
  never a `parentId`; a reply carries a `parentId` and never an anchor or a status. A reply is
  shown wherever its root re-anchored and shares its root's lifecycle, so giving it either
  field of its own would let one conversation disagree with itself. An entry carrying both, or
  neither, is an unsupported store under REQ-REVIEW-003 rather than a comment to interpret.
- **REQ-REVIEW-019** — `hunk review comment reply --file <path> --id <id>` answers the named
  comment. Replying to a reply is refused rather than re-pointed at its root, which bounds a
  conversation at exactly one level and spares every client the job of rendering a tree.
  Deleting a root deletes its replies; deleting a reply leaves the conversation intact. This
  holds of the file, not merely of one writer's intent: a reply a peer added between the
  deleting writer's read and its write is unioned back in by REQ-REVIEW-008 and is dropped
  when the store is reconciled, so no reply is ever left without the root it answers.
- **REQ-REVIEW-020** — `comment status` sets `active` as readily as `resolved`, so resolving is
  reversible. It targets roots only: a reply has no status, and asking for one is an error that
  names the comment that does.
- **REQ-REVIEW-021** — Every agent note carries a `noteKey`: a hash of its file, range, and
  text. `noteId` embeds the note's position in the changeset and moves when an unrelated file
  enters the review, so it names a note within one payload and nothing persisted is ever keyed
  on it. A note the agent rewrites gets a new key by design — a reply answers what the note
  said, and silently re-attaching it to different words is the misattachment REQ-REVIEW-006
  refuses for comments.
- **REQ-REVIEW-022** — The reviewer's half of an exchange with a note is an ordinary anchored
  comment tagged with that note's `noteKey`, not a parallel store of note state. `hunk review
note reply` and `note status` open that conversation on first use — the first thing said
  becomes it, and resolving with nothing said opens it with an empty body, because most notes
  are read and accepted and "I have dealt with this" must not cost a sentence. A note is never
  editable or deletable through this: its text is the agent's.
- **REQ-REVIEW-007** — Per-file viewed state keeps v1 semantics unchanged: keyed on
  `path + sha256(patch)`, auto-unviewed when the patch changes, entries pruned after 30
  days, tolerant-reset on any schema failure.
- **REQ-REVIEW-008** — A writer holds an exclusive lock across the whole read-modify-write,
  for both durable stores. The lock is required, not advisory: a writer that cannot take it
  within the bounded budget writes nothing and reports contention. Under the lock, the
  mutation still merges against a re-read — entries union by comment `id` (higher
  `updatedAt` wins per id, and ids the mutation intentionally removed stay removed); viewed
  state merges by writer intent, where a file the writer deliberately toggled takes the
  writer's value and a file it never touched keeps whatever is on disk with a matching
  `patchHash`. Intent rather than union, because a union would make un-viewing unwritable.
- **REQ-REVIEW-009** — Every filesystem interaction is bounded: explicit retry count and
  timeout on the lock, no unbounded wait.
- **REQ-REVIEW-011** — One lock implementation serves both stores. Two implementations
  would be two sets of reclaim rules, and two processes disagreeing about when a lock is
  abandoned is the failure the lock exists to prevent.
- **REQ-REVIEW-012** — A failed write is reported to whoever can act on it. The TUI treats
  viewed state as best-effort metadata and continues; a headless `hunk review` invocation
  exits non-zero rather than returning a success envelope for a write that never landed.
- **REQ-REVIEW-013** — Reclaiming an abandoned lock is bound to the exact lock that was
  judged abandoned, not to the path. Judging and acting are separate steps, so a reclaimer
  that acts on the path alone can carry off a successor's live lock and put two writers in
  the critical section.
- **REQ-REVIEW-014** — Contention and unavailability are distinct outcomes, in both stores.
  A held lock resolves by retrying; a path that cannot be written (permissions, read-only, no
  space) never does, and reporting it as contention sends the client to retry what cannot
  succeed. The distinction is drawn on the errno: only `EEXIST` is contention, because
  `O_EXCL` reports `EEXIST` for an existing path of any type and the mere fact of failure
  says nothing about whether waiting would help.
- **REQ-REVIEW-010** — An older `hunk` binary that does not know about comments can read
  and write viewed state without destroying or altering `.hunk/review-comments.json`.

### Review export

- **REQ-EXPORT-001** — `hunk review export --json` emits a review snapshot for the
  requested range without a daemon, a registered session, or a TTY.
- **REQ-EXPORT-002** — The command accepts the same range selection as `hunk diff` /
  `hunk show` (working tree, `<ref>`, `base...head`), and an explicit repo root.
- **REQ-EXPORT-003** — The payload reuses `buildHunkSessionReview`, so file identity,
  ordering, hunk ranges, and agent-note matching are byte-identical to what
  `hunk session review --json` reports for the same changeset.
- **REQ-EXPORT-004** — The payload carries an explicit `exportVersion` distinct from
  `HUNK_SESSION_DAEMON_VERSION`, and a `reviewCommentsVersion`.
- **REQ-EXPORT-005** — Raw patch text is opt-in via `--include-patch`, matching
  `serializeReviewFile` (`src/session/broker/projections.ts:54`).
- **REQ-EXPORT-006** — The payload includes viewed state resolved from
  `.hunk/review-state.json` and comments resolved from `.hunk/review-comments.json`, each
  comment carrying its post-ladder `status`. An unreadable comment store is reported as
  `commentsAvailable: false`, never as an empty comment set.
- **REQ-EXPORT-007** — Export never mutates review state.
- **REQ-EXPORT-008** — Each file carries its `changeType`, so a client knows which sides of
  the diff exist without inferring it. A payload from a Hunk that predates the field is read
  as `change`, which is the behavior clients had before it.
- **REQ-EXPORT-009** — Failure is a non-zero exit with a structured error on stderr, never
  a partial or silently empty payload.
- **REQ-EXPORT-010** — A comment's lifecycle (`active` / `resolved`) and its anchor validity
  (`outdated`) are separate fields, because a comment can be both resolved and outdated.
  Reporting one through the other lets a stale placement hide behind a lifecycle value.
- **REQ-EXPORT-011** — `hunk review file source --file <path> --side <old|new>` reads full
  text through the file's own source fetcher, so each VCS backend keeps owning object reads.
  `text: null` is reserved for the side the file's `changeType` says does not exist — an
  added file's old side, a deleted file's new side. Every other null is a failed read and
  fails the command: a review with no fetcher at all, and a fetcher returning null for a side
  that should have content. Folding those into `null` would let a client render a
  confidently blank document in place of source it never received.
- **REQ-EXPORT-013** — The payload carries the sidecar's changeset summary and each file's
  summary alongside the hunk-level notes. They answer different questions — what the change
  does, why this file is in it, what this passage means — and a client given only the third
  has nothing to show before a hunk is open. Both are absent when no sidecar describes them,
  and both are bounded when they cross the session wire.
- **REQ-EXPORT-012** — A payload is written in full before the process exits, however large
  it is. A pipe accepts one buffer at a time, so a command that exits straight after `write`
  loses the remainder while still exiting `0` — the failure a client sees is unparseable
  JSON, with nothing in the exit code or stderr to explain it. This binds every headless
  command, not only export: the same entrypoint prints session snapshots and pager
  passthrough.

### Review write commands

The write half of the same headless surface. It exists because the anchoring ladder and
the strict-preserve store are Hunk's, not a client's: an editor that wrote
`.hunk/review-comments.json` itself would own a second implementation of REQ-REVIEW-004's
capture and REQ-REVIEW-008's merge.

- **REQ-WRITE-001** — `hunk review comment add --file <path> --side <old|new> --line <n>`
  captures the anchor from the current patch and appends one comment, printing the new
  comment id.
- **REQ-WRITE-002** — A comment body comes from `--body <text>` or, with `--stdin`, from
  standard input, so multi-line bodies never pass through argv.
- **REQ-WRITE-003** — `hunk review comment status --id <id> --status <active|resolved>` and
  `hunk review comment delete --id <id>` mutate one comment by id.
- **REQ-WRITE-004** — `hunk review viewed set --file <path> (--viewed | --unviewed)` toggles
  one file's viewed entry and leaves every other file's entry untouched.
- **REQ-WRITE-005** — A write against a file the review does not contain, or a line the
  diff does not contain, fails rather than persisting an entry nothing can resolve.
- **REQ-WRITE-006** — A write refuses when the comment store cannot be read, and the file
  is left byte-intact (REQ-REVIEW-003).
- **REQ-WRITE-007** — Every write returns the post-write review in the same payload shape
  export emits, so a client never has to re-query to learn what its write produced.
- **REQ-WRITE-008** — Every `hunk review` failure, including argument errors raised before
  the command runs, is JSON on stderr with an empty stdout.
- **REQ-WRITE-009** — `viewed set` takes `--file` more than once and applies the whole set
  in one write, refusing the batch if any path is outside the review rather than
  half-applying it. A flag repeated where the operation can only act on one value is an
  error: silently keeping the last value made a request half-vanish while reporting success.
- **REQ-REVIEW-015** — `hunk review focus set|get|clear` records where an agent points its
  human partner: a changeset, and optionally a file, side, and line within it. The target is
  named the same way every other review operation names one, and a range is stored as its
  expression rather than resolved, so the pointer still means the branch after it moves. A
  file outside the named changeset is refused, never recorded — a pointer to a file that is
  not under review would silently do nothing.
- **REQ-REVIEW-016** — Focus is derived state and follows `REVIEW_STATE_FILENAME`'s policy,
  not the comment store's: a corrupt or unrecognized focus reads as none and the reviewer
  keeps whatever they were reading. It is written by temp file and rename, so a client woken
  by the change never parses a half-written pointer, and it carries a monotonic `revision`
  so a repeated instruction is distinguishable from a re-read of the same one.

### VS Code extension

- **REQ-VSCODE-001** — The extension resolves a `hunk` binary, calls `review export`, and
  renders the changeset in VS Code's native diff editor.
- **REQ-VSCODE-002** — Agent annotations render as read-only threads or decorations
  attached to the hunks they matched, preserving sidecar file order.
- **REQ-VSCODE-003** — User comments are created through `vscode.CommentController` and
  persisted to `.hunk/review-comments.json` through `hunk review comment`, never by the
  extension writing the store itself.
- **REQ-VSCODE-004** — Per-file viewed state is togglable and shares the invalidation rule
  in REQ-REVIEW-007.
- **REQ-VSCODE-005** — Refresh re-runs export and re-resolves anchors; outdated comments
  are visibly marked, never hidden.
- **REQ-VSCODE-006** — On `exportVersion` mismatch or a missing binary, the extension
  fails with an actionable message. It never falls back to parsing git itself.
- **REQ-VSCODE-007** — The extension never reimplements changeset normalization, agent
  note matching, or viewed invalidation. Those come from export only.
- **REQ-VSCODE-008** — Anything anchored to a line is placed on the side it was resolved
  against: an old-side comment, and an agent note carrying only an old range, appear in the
  pre-image document. The same line number on the other side is a different line.
- **REQ-VSCODE-009** — Both sides of the diff are served from Hunk when they have no
  working-tree document — the old side always, and the new side of a deleted file. Only a
  live file's new side is the real editable workspace document.
- **REQ-VSCODE-010** — Reviewed paths resolve against the repo root the export reports, not
  the folder VS Code has open, so reviewing from a subdirectory of a repository works.
- **REQ-VSCODE-012** — The reviewer chooses which changeset is under review — working tree,
  staged, a branch against where it left its base, or any target `hunk diff` accepts — and
  the choice persists and is visible in the view. Every invocation for that review names the
  same target, reads and writes alike, so a comment is anchored against the changeset on
  screen. The extension never enumerates refs itself; it passes an expression to Hunk.
- **REQ-VSCODE-011** — The sidebar arranges the review as a flat list or a directory tree,
  and the reviewer's choice persists. List order is the export's order, which is the
  sidecar's authored order and is never sorted or grouped away; tree mode groups by
  directory, collapses chains of single-child directories, and keeps review order within
  each level. A file's identity, viewed state, and actions are the same row in both.
- **REQ-VSCODE-013** — The agent's account of the change leads the sidebar, rendered as
  formatted text rather than markdown source: it is authored prose, and showing its syntax
  makes the one paragraph in the panel its least readable element. It carries no scripts and
  escapes repository content before rendering it. A file's own summary is its row's tooltip.
  The summary appears only when there are files for it to describe: a sidebar with no rows to
  show shows none at all, and states which of the three emptinesses it is — no review open, a
  target with no changes, or a filter hiding every file — each offering the action that
  resolves it. An unexplained empty panel reads as a broken extension.
- **REQ-VSCODE-018** — A command contributed to a tree row's menu accepts the row VS Code
  hands it. VS Code types that argument as `any`, so a handler expecting a different shape
  compiles and fails only in the user's hands; every such command resolves its target through
  one function, and the suite invokes each with a real tree item.
- **REQ-VSCODE-014** — The sidebar filters to unviewed files, files carrying an unresolved
  comment, or files an agent annotated. An active filter is named in the view, and progress
  and unviewed navigation are still measured against the whole review, so a filter never
  makes the review look finished or smaller than it is.
- **REQ-VSCODE-015** — Review state is badged onto the sidebar rows and only onto them:
  the count of unresolved comments where there are any, otherwise a mark for viewed. The
  badge never lands on the workspace file, where it would sit beside Git's own decoration
  for the same file saying something else.
- **REQ-VSCODE-016** — Viewed state is settable over a whole directory subtree or the whole
  review in one write, through the same batching contract as REQ-REVIEW-011.
- **REQ-VSCODE-017** — The extension follows the focus recorded by REQ-REVIEW-015, both when
  a review is opened and whenever the focus changes while one is open, so an agent can set up
  its partner's review without the human re-deriving the target from chat. A standing focus
  outranks the remembered target. Reading it goes through the CLI like every other read; the
  extension only ever learns _where_ the file is, never its schema. A recorded line is
  revealed on the side it was named against, per REQ-VSCODE-008.
- **REQ-VSCODE-019** — One comment and its replies render as one `CommentThread`, in the order
  Hunk exported them. Typing into a thread's reply box writes a reply to that thread's root
  (REQ-REVIEW-019); the same box on a thread with no Hunk comment yet writes a new root at its
  line. A reply drawn as its own thread would sit on a line it was never written against and
  read as a second opinion rather than an answer.
- **REQ-VSCODE-021** — An agent note and the conversation answering it render as one thread,
  paired by `noteKey` and never by line number — two things at one line are not thereby about
  each other. The thread accepts replies and offers resolve/reopen, because an agent
  explaining itself is half a conversation and the reviewer needs somewhere to say the other
  half. An answer whose note has since been rewritten still renders, as the anchored comment
  it remains; dropping it would lose authored work to an edit the reviewer did not make.
- **REQ-VSCODE-020** — A conversation's resolved state is carried on `CommentThread.state`, not
  only in its label, and reopening is offered wherever resolving is. A surface that can close a
  conversation but never reopen one makes a misclick permanent and leaves deletion — which
  destroys the discussion — as the only way back.

## Invariants

- **One contract.** File identity, ordering, hunk ranges, and note matching have exactly
  one implementation, in `src/core` / `src/session/broker/projections.ts`, used by TUI,
  CLI, export, and extension. A second implementation is a defect.
- **Review state outlives the window.** Any comment acknowledged to the user is on disk
  before the acknowledgement.
- **A comment is never shown against content it was not written against.** It is either
  correctly anchored or marked outdated.
- **Derived state degrades; authored content does not.** A corrupt
  `.hunk/review-state.json` resets to empty, because viewed state is derived. A corrupt
  `.hunk/review-comments.json` is preserved and reported, because comments are authored.
  Neither ever ends a review.
- **Export is read-only** with respect to `.hunk/`.
- **No new required runtime.** Nothing on this path requires the daemon, a registered
  session, or a TTY.

## Non-goals

- The daemon as the backbone for non-terminal surfaces. It keeps brokering live TUI
  sessions for agents; it is not required to open a review.
- A headless session mode. Worth building for the agent skill, independently; it is not a
  prerequisite here and must not become one.
- Live two-way focus sync ("jump the TUI to this hunk"). Optional phase 2 at most.
- Extracting `useReviewController` into a framework-free model. It is React state for a
  terminal review stream; VS Code owns its own selection and diff UI.
- Multi-user merge, CRDTs, or conflict resolution beyond the single-writer rule.
- An agent marking files viewed, or moving the reviewer's cursor. Agent reach stops at
  target, file, and line. Viewed state is the human's record of what they have actually
  read; an agent writing it would turn the one signal a reviewer trusts about their own
  progress into a lie. (2026-08-03, ratified.)
- Publishing review comments to GitHub or any forge.
- STML / Pierre note geometry in VS Code. Comment bodies are markdown there.
- Publishing the `packages/session-broker*` packages.

## Decisions

- **Priority / tradeoffs:** durability > reachability > liveness. A missing sync feature is
  an inconvenience; a lost or mis-anchored comment destroys trust and is unshippable.
- **Assumption:** single user, single machine, one workspace at a time.
- Reverse the daemon-backbone direction; adopt durable disk + CLI export, daemon demoted
  to optional live-TUI attach — the original premise ("live sync is free through the
  daemon") is contradicted by `src/session/protocolSchemas.ts:49-109`,
  `src/ui/runInteractiveApp.tsx:41`, and the absence of any comment writer.
  (2026-08-03, ratified — independent consult `agent-2026-08-03-acd51a` concurred.)
- Integrate via spawning the compiled binary rather than embedding the model in the Node
  extension host, because the model path is Bun-shaped across 10 `src/core/` modules.
  (2026-08-03, provisional — consult recommended; revisit only if Bun→Node packaging is
  deliberately solved.)
- ~~Extend `.hunk/review-state.json` to v2 rather than adding a sibling comments file.~~
  **Overturned 2026-08-03.** Measured against the current reader: a `version: 2` file is
  discarded wholesale by an older binary, and a single corrupt entry already discards the
  whole file — so coupling authored comments to disposable viewed state risks losing the
  comments, while an extra key needs no version bump at all. Comments get their own file
  and their own strict-preserve policy. No migration ships. (2026-08-03, ratified.)
- Review state and comments stay git-ignored and local-only; sharing comments through the
  repo is out of scope. Follows the existing repo convention that local review artifacts
  are never committed. (2026-08-03, provisional.)
- The extension lives at `editors/vscode/`, not `packages/vscode/`. It is Node16 CommonJS
  against `@types/node` and `@types/vscode`, and every Bun-oriented glob in the repo
  targets `packages/**` — `bun test ./packages` picks up its host-only tests and
  `tsconfig.json` drags `@types/node` into the Bun program, shadowing bun-types. Keeping
  it outside `packages/` avoids all of that by construction rather than by three
  exclusions. `editors/` also leaves room for another editor client and does not collide
  with hunk's own extension system. (2026-08-03, provisional.)
- Comments need content anchors; viewed does not. Viewed is file-level and
  `path + patchHash` is sufficient; comments are line-level and pure line anchors rot.
  (2026-08-03, provisional — consult concurred.)
- This spec lives at the repo root because its contract spans `src/core`, the CLI, and a
  future extension package, and no single package owns it. A narrower `SPEC.md` may be
  colocated with the extension package when that package exists. (2026-08-03, provisional.)
- The editor writes review state by shelling out to `hunk review comment` /
  `hunk review viewed set`, never by writing `.hunk/` itself. Write-time anchor capture
  (REQ-REVIEW-004) and the id-union merge (REQ-REVIEW-008) belong to Hunk; a client that
  wrote the store would own a second implementation of both, and the extension host is Node
  while the store helpers reach `Bun.sleepSync`. The CLI is the API. (2026-08-03,
  provisional.)
- `hunk review` is one command group carrying a nested operation, rather than one
  `ParsedCliInput` kind per subcommand. Five subcommands otherwise mean five parse branches,
  five startup-plan kinds, and five dispatch arms for what is one surface. (2026-08-03,
  provisional.)
- Every `hunk review` failure is JSON on stderr with an empty stdout, including argument
  errors raised before the command runs. The consumer is a program, and having it parse
  prose for early failures and JSON for late ones is a contract with a seam in it.
  (2026-08-03, provisional.)
- The diff editor's pre-image comes from `hunk review file source`, not from the extension
  reading git objects. Each VCS backend owns its own object reads through
  `FileSourceFetcher`; reconstructing the old side in the client would work for Git and
  silently fail for jj and Sapling. (2026-08-03, provisional.)
- Agent review control rides `.hunk/review-focus.json` plus the CLI, not the daemon. The
  daemon needs a live TUI and its demotion is ratified above; durable state plus
  CLI-as-API works with any agent that can run a shell command. The focus expression is
  stored unresolved, the revision is monotonic, and the write lands by atomic rename.
  (2026-08-03, ratified.)
- Replies are a second comment shape in the same store, discriminated by `parentId`, rather
  than a nested array on the root or a grouping derived from `(file, side, line)`. Grouping
  by line conflates two people commenting on one line with a conversation, and splits a
  thread the moment the root re-anchors while a reply does not. A reply carries neither
  anchor nor status, so a thread cannot disagree with itself. `REVIEW_COMMENTS_VERSION`
  stays 1: the field is additive, so a v1 store keeps working in both directions until a
  reply is actually written, and an older binary that then meets one fails closed
  (unavailable, bytes preserved) rather than dropping content. (2026-08-04, provisional.)
- Conversations are exactly one level deep; replying to a reply is refused, not silently
  re-pointed at the root. The alternative is a tree every client must render and bound. The
  refusal names the comment that can be answered, so the correct call is one step away.
  (2026-08-04, provisional.)
- A note's persisted identity is a content hash (`noteKey`), never `noteId`. `noteId` is
  `${source}:${file.id}:${index}` and `file.id` is the file's index in the changeset —
  verified against the real binary, where adding one unrelated file moved a note from
  `:0:a.ts:0` to `:1:a.ts:0`. Keying a reply on that silently reattaches it to a different
  note. A rewritten note getting a new key is deliberate: the reply answers what the note
  said. (2026-08-04, provisional.)
- The reviewer's response to a note is an ordinary anchored comment tagged with the note's
  key, not a parallel note-state store. It inherits re-anchoring, resolution, replies, and
  the concurrent-write rules for free, and a note the agent later rewrites simply stops
  pairing instead of collecting answers to text it no longer contains. The conversation is
  created lazily, so an eighty-note review writes nothing until the reviewer says
  something. (2026-08-04, provisional.)

## Risk tags

- **MEDIUM — public contract.** `exportVersion` becomes a compatibility surface between
  the binary and an independently-shipped extension.
- **LOW — new persisted file.** `.hunk/review-comments.json` is additive with no existing
  data to migrate, and `.hunk/review-state.json` is not touched. The v1 → v2 migration
  that previously carried a HIGH tag was removed from the design; see Decisions.
- **LOW** — the extension package is additive and ships nothing on the TUI path.

## Open items

### The stale-lock reclaim race is real and unfixed

`src/core/fileLock.ts` can still admit two reclaimers. `reclaimStaleLock` releases its
marker in a `finally` that removes whatever sits at the marker path rather than the marker
that call created, and `clearStuckReclaimMarker` judges a marker dead and then removes it
unbound. A delayed cleaner can therefore delete a _live_ reclaimer's marker and readmit a
second reclaimer — restoring exactly the overlap the marker was introduced to prevent.

This is structural, not a missing guard. Three successive attempts each bound one
check-then-act more tightly, and the race reappeared one level up each time, because no
filesystem offers "remove or rename only if this object is still the one I judged" as a
single atomic step. Binding the marker by token has the same shape as binding the lock by
bytes and fails the same way.

The design that removes the race rather than relocating it is an OS advisory lock
(`flock` / `fcntl`), which the kernel releases on process death: no staleness, no reclaim,
nothing to race. Bun reaches it through `bun:ffi`; there is no stdlib binding.

**Decision needed:** adopt an FFI-backed advisory lock, accept a documented bounded window,
or take a dependency. Reaching the race requires a reclaimer to stall between two adjacent
filesystem calls while a peer completes a full reclaim-and-acquire — real and worth fixing,
not a reason to hold the surface.

## Acceptance criteria

- [x] `.hunk/review-state.json` is byte-identical before and after a full comment
      write/read cycle — `test/cli/review.test.ts` "does not disturb viewed state when
      writing a comment"
- [x] A binary built without comment support reads and writes viewed state while leaving
      `.hunk/review-comments.json` untouched — the two stores share no code path;
      `src/core/reviewComments.test.ts` covers the coexistence direction
- [x] Malformed, truncated, and unreadable comment files report unavailable and leave the
      file byte-intact — never reset, never overwritten —
      `src/core/reviewCommentsWriter.test.ts`, `test/cli/review.test.ts`
- [x] Malformed viewed state still resolves to empty without throwing (unchanged v1
      behavior) — `src/core/viewedState.test.ts`
- [x] A comment survives an unrelated edit elsewhere in the file —
      `src/core/reviewCommentAnchor.test.ts` "an edit above the anchor follows the line"
- [x] A comment whose anchor line is deleted resolves to `status: "outdated"` with body and
      original location intact — same file, plus the end-to-end suite
- [x] No re-anchoring path can place a comment on non-matching content (property test over
      generated edits) — `src/core/reviewCommentAnchor.test.ts` "anchor honesty (property)"
- [x] Concurrent writers do not lose a comment (two-writer test) —
      `src/core/reviewCommentsWriter.test.ts` "two concurrent OS processes"
- [x] A writer that cannot take the lock writes nothing and says so —
      `src/core/reviewCommentsWriter.test.ts` "refuses to write while a live peer holds the
      lock", which asserts the store was never created and the peer's lock was not stolen
- [x] A headless viewed write that cannot land exits non-zero instead of reporting success —
      `test/cli/review.test.ts` "reports a failed viewed write"
- [x] A peer's viewed mark survives a concurrent TUI write and is adopted into the UI, while
      a deliberate local un-view still lands — `src/ui/hooks/useViewedStatePersistence.test.tsx`,
      `src/core/viewedState.test.ts` "merging one session's viewed toggles onto disk"
- [x] A reclaimer does not carry off the lock that replaced the one it judged abandoned —
      `src/core/fileLock.test.ts` "does not reclaim a lock that replaced the one it judged"
- [x] An unwritable lock path reports unavailable rather than contention —
      `src/core/fileLock.test.ts` "reports an unwritable lock path as unavailable"
- [x] A review that cannot read a file's full text fails instead of reporting empty source —
      `src/app/reviewCommand.test.ts` "refuses a file whose source this review cannot read"
- [x] A null read on a side the change kind says exists fails, while an added file's old side
      still reports null — `src/app/reviewCommand.test.ts` "refuses a null read on a side the
      change kind says exists", "reports a side that genuinely has no content as null"
- [x] The comment store reports an unwritable lock path as unavailable, not contention —
      `src/core/reviewCommentsWriter.test.ts` "reports an unwritable lock path as unavailable"
- [x] An old-side comment renders in the pre-image, and a deleted file diffs against
      Hunk-served documents on both sides —
      `editors/vscode/src/test/review.test.ts`
- [x] Reviewed paths resolve against the export's repo root, not the open folder —
      `editors/vscode/src/test/review.test.ts`
- [x] `hunk review export --json` succeeds with no daemon running and stdin not a TTY —
      `test/cli/review.test.ts`
- [x] Export payload for a fixture changeset is field-identical to
      `hunk session review --json` for file identity, order, and hunk ranges —
      `src/core/reviewExport.test.ts` differential test
- [x] Export exits non-zero with a structured error for an invalid range —
      `test/cli/review.test.ts` "exits non-zero with a structured error for an invalid range"
- [x] Export leaves `.hunk/review-state.json` byte-identical —
      `src/core/reviewExport.test.ts` "never writes to the review directory"
- [x] A payload several pipe buffers long reaches a reader that is a separate process
      intact, for both `review export` and pager passthrough —
      `test/cli/review.test.ts` "writes a payload larger than one pipe buffer without
      truncating it", `test/cli/entrypoint.test.ts` "passes text larger than one pipe buffer
      through the pager without truncating it", `src/lib/stdio.test.ts`
- [x] Extension MVP: open a range, see agent notes on their hunks, add a comment, reopen
      the workspace, comment is still there — asserted in the extension host by
      `bun run test:vscode`, not only by hand —
      `editors/vscode/src/test/endToEnd.test.ts` drives the real binary against a real Git
      repo with a real sidecar; persistence is proven by a later `hunk` process reading the
      comment back from disk
- [x] Extension surfaces a clear error on `exportVersion` mismatch —
      `editors/vscode/src/test/review.test.ts`
- [x] The sidebar groups by directory on request and preserves the export's order in list
      mode — `editors/vscode/src/test/reviewTree.test.ts`
- [x] The agent's account of the change leads the sidebar, and a file's own summary is its
      tooltip — `editors/vscode/src/test/reviewTree.test.ts` "leads with the agent's account
      of the change, in either arrangement", "carries a file's own summary as its tooltip"
- [x] A review with nothing to show shows no rows and names which emptiness it is, rather
      than a summary describing files that are not on screen —
      `editors/vscode/src/test/reviewTree.test.ts` "a sidebar with nothing to show"
- [x] Each filter admits exactly the files it names, is named back to the reviewer, and
      leaves progress measured against the whole review —
      `editors/vscode/src/test/reviewTree.test.ts` "review sidebar filtering"
- [x] A badge lands on review rows only, and an unresolved comment outranks the viewed mark
      — `editors/vscode/src/test/reviewDecorations.test.ts`
- [x] A directory row resolves to every file beneath it, so marking a folder viewed is one
      write — `editors/vscode/src/test/reviewTree.test.ts` "a directory row stands for every
      file beneath it, however deep"

- [x] A comment on a low-entropy line does not follow its text into unrelated code when its
      recorded context is gone, and still follows it when the context came along —
      `src/core/reviewCommentAnchor.test.ts` "a low-entropy anchor line"
- [x] The inline check mark marks a file viewed when handed the row VS Code actually passes,
      and no row-invoked command rejects its own row —
      `editors/vscode/src/test/review.test.ts`
- [x] The changeset summary renders code spans, bold, emphasis, and web links; escapes
      repository content; forbids scripts; and follows the user's theme —
      `editors/vscode/src/test/reviewSummaryView.test.ts`
- [x] An agent-recorded focus survives a round trip, refuses a file outside the changeset,
      and reads as none when corrupt — `src/core/reviewFocus.test.ts`
- [x] A focus payload with a line but no file, or a target the client does not recognize, is
      dropped whole rather than half-applied —
      `editors/vscode/src/test/reviewFocus.test.ts`
- [x] Opening a review costs no extra process spawn when nothing is pointing anywhere —
      asserted by the call counts in `editors/vscode/src/test/review.test.ts`
- [x] A stored entry carrying both an anchor and a `parentId`, or a reply carrying its own
      status, reports unavailable and leaves the file byte-intact —
      `src/core/reviewComments.test.ts` "review comment replies"
- [x] A reply threads onto the comment it names rather than onto whatever else sits at that
      line, and never appears as a top-level comment —
      `test/cli/review.test.ts` "replies thread onto the comment they answer"
- [x] Replying to a reply is refused, naming the comment that can be answered —
      `test/cli/review.test.ts` "refuses to reply to a reply"
- [x] Deleting a root deletes its replies; deleting a reply leaves the conversation —
      `test/cli/review.test.ts` "deletes a whole conversation", "deletes one reply without
      touching the conversation around it"
- [x] A note keeps its key when its id moves under it, and a rewritten note gets a new one —
      `src/session/app/reviewNotes.test.ts`
- [x] Answering a note opens one conversation carrying that note's key, and a second answer
      threads onto it — `test/cli/review.test.ts` "answering an agent note"
- [x] A note is marked resolved with nothing said first, and reopens —
      `test/cli/review.test.ts` "marking a note resolved needs nothing said first"
- [x] A note thread accepts a reply and routes it to `note reply`, and resolving a note routes
      to `note status` — `editors/vscode/src/test/review.test.ts` "an agent note opens a thread
      the reviewer can answer", "a note is marked resolved without having to say anything first"
- [x] An answer whose note was rewritten still renders as its own anchored comment —
      `editors/vscode/src/test/review.test.ts` "an answer whose note the agent rewrote"
- [x] A reply a peer added while a root was being deleted is not left stranded, and an
      unrelated peer comment still survives the same write —
      `src/core/reviewCommentsWriter.test.ts` "a delete does not strand a peer's reply to the
      comment it removed"
- [x] A resolved conversation can be reopened, and a reply has no status to set —
      `test/cli/review.test.ts` "resolves, unresolves, and deletes a whole conversation",
      `editors/vscode/src/test/review.test.ts` "a resolved conversation says so, and can be
      reopened"
- [x] A comment and its replies render as one thread in order, and the reply box writes a
      reply rather than a second root —
      `editors/vscode/src/test/review.test.ts` "a comment and its replies render as one
      conversation", "replying answers the conversation instead of opening a new one"

Still owed to the human (Boundary): the feel judgement on the finished VS Code surface,
and any publish.

## Test traceability

Added during TDD; empty at authoring.
