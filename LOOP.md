# Loop: Changeset-keyed agent-context discovery — `feat/local-review-vscode`

Mission: reimplement agent-context **auto-discovery** so simple commands
(`hunk diff`, `hunk diff <range>`, `hunk show …`) still need **no**
`--agent-context`, while discovery is scoped to the **review target** Ben
required on [modem-dev/hunk#540](https://github.com/modem-dev/hunk/pull/540).
Drive that unit (and only the follow-through it forces on the stack) to
**interior-green** so the only remaining steps are the human's boundary
calls (PR to `modem-dev/hunk`, reply/close #540, publish).

Work through the ADF loop (SPEC → PLAN → TDD → DEV → E2E). Unblock via the
ladder; the verifier — not confidence — decides when work is done.

## State (updated 2026-08-11 — rewrite each iteration; newest facts first)

- Branch `feat/local-review-vscode`, HEAD `87ca74e2` (pre-loop tip: 8-commit
  upstream stack on `upstream/main`). Tree clean except campaign artifacts
  under `.hunk/` (ignored) until LOOP.md is committed.
- Design ratified in conversation (see Decisions): target-keyed filename,
  no bare-file auto-load. Full draft:
  `.hunk/AGENT-CONTEXT-DISCOVERY-DESIGN.md` (local; not required for git
  resume once SPEC carries the contract).
- Stack commit 1 today still implements **unscoped**
  `.hunk/agent-context.json` discovery — that is the work to replace, not
  leave as-is for upstream.
- #540 is OPEN with @benvinegar's design note (filename id ↔ changeset);
  no line review; greptile author-list noise only.
- Prior rewrite backups: `backup/pre-upstream-rebase-20260811`,
  `backup/merged-upstream-local-review`.
- Read first: this file → Decisions → SPEC.md review/export rows if any →
  `src/core/config.ts` (resolution seam ~1107–1135) → `src/core/paths.ts`
  → `src/core/agent.ts` → config/loader tests.

## Decisions (append-only; do not re-litigate)

1. 2026-08-11 — **Auto-discovery key = review target identity in the
   filename**, not patch content, not bare `agent-context.json`.
   Path: `.hunk/agent-context.<targetId>.json` where `targetId` is the first
   12 hex of SHA-256 over a canonical target string (working-tree | staged |
   range+expression | show+ref | stash-show+ref + sorted pathspecs). Users
   never type the id; simple CLI stays simple. **provisional (driver)** —
   human affirmed the restatement in session; treat as campaign law until
   SPEC amendment or human overturns.
2. 2026-08-11 — **Resolution order:** `--no-agent-context` → explicit
   `--agent-context` (strict) → config `agent_context` (strict) → keyed
   conventional path only (optional) → never fall back to bare name for
   auto-discovery. **provisional (driver)**
3. 2026-08-11 — **Non-goals v1:** content-hash in filename; annotation JSON
   schema change; auto-discovery for file/patch/stdin inputs. WT content
   drift on the same target stays soft via range matching. **provisional
   (driver)**
4. 2026-08-11 — **fix: reserved** for truly pre-existing upstream breakage.
   This feature is `feat` / docs / test only. **provisional (driver)**
5. 2026-08-11 — Campaign lands on `feat/local-review-vscode` by rewriting
   or amending the bottom auto-discover unit so the stack's first commit
   matches the keyed design (history stays feat-shaped; no new top-of-stack
   "fix" for discovery). **provisional (driver)**

## Work plan (ADF per unit)

### Unit A — SPEC: keyed discovery contract

- **Establishes:** REQ rows (or amendments to existing agent-context docs)
  for target id, path convention, resolution order, watch, agent ergonomics
  (how to obtain the path without memorizing hashes), migration (bare file
  not auto-loaded). Point at #540 acceptance.
- **Defers:** implementation, skill/README polish beyond contract, PR text.
- **Done when:** SPEC (and BRIEF if floors change) state the law in
  present tense; no open design forks for v1.

### Unit B — PLAN + TDD: pure target id + discovery seam

- **Establishes:** `agentContextTargetId` / `conventionalAgentContextPath`
  (or equivalent names) as pure functions; failing tests for: same inputs →
  same id; range ≠ working-tree id; wrong-id file not loaded; matching id
  loaded optional; explicit bare path still strict; `--no-agent-context`
  wins; config path wins over conventional.
- **Defers:** full docs site, vscode (untouched by discovery).
- **Done when:** tests observed red on pre-change tree (or red on a
  temporary wrong implementation), then green after DEV; cite outputs.

### Unit C — DEV: wire config + watch + loaders

- **Establishes:** `resolveConfiguredCliInput` (or successor) injects only
  the keyed path; watch tracks that path; loaders unchanged except they
  receive the resolved path. No dual-read of bare+keyed.
- **Defers:** agent skill prose polish if skill regen is mechanical.
- **Done when:** unit B floors green; typecheck green.

### Unit D — Docs / skill / CLI surface for agents

- **Establishes:** README + agent-workflows + hunk-review skill state the
  convention; agents learn the path via documented formula and/or a single
  cheap surface (prefer: field on `hunk review export --json` **or** one
  line in skill — pick one, log Decision if both).
- **Defers:** website marketing copy.
- **Done when:** skill/docs consistent with SPEC; `bun run check:docs` if
  it covers touched docs.

### Unit E — History + interior-green of discovery unit

- **Establishes:** stack history presents keyed discovery as the
  auto-discover feat (rewrite commit 1 or squash equivalent); no unscoped
  discovery left on the branch tip.
- **Defers:** full-stack PR body, Graphite split of later commits, human
  push/PR.
- **Done when:** `git log upstream/main..HEAD` still feat-shaped; tip
  implements keyed discovery; whole-branch floors below green for
  **this unit's** surface (not a full re-audit of vscode unless regressed).

### Explicitly out of campaign scope

- Opening/merging the PR to modem-dev; force-push of shared refs without
  human; implementing content-hash filenames; fixing unrelated stack
  commits unless a floor proves a regression introduced by this campaign.

## Verification floors

Per-change (owning unit):

- `bun run typecheck` — clean.
- Focused: `bun test src/core/config.test.ts src/core/agent.test.ts
src/core/loaders.test.ts` (extend as new files appear) — all pass.
- If CLI surface changes: `bun test src/core/cli.test.ts` and/or
  `test/cli/` contracts for help text / export fields.
- Docs touched: `bun run check:docs` when applicable.

Whole-branch (before **done**):

- `bun run typecheck`
- `bun run lint`
- `bun run test` (BRIEF: not bare `bun test` that sweeps pty/smoke without
  intent — use package scripts / scoped paths consistent with BRIEF Floors)
- `bun run test:integration` if watch/loader PTY notes coverage is hit
- Do **not** require `test:vscode` for this campaign unless extension files
  change (they should not).

Review gate — harness first, briefed reviews: the driver and cooks own
verification; do not outsource to a reviewer what a floor can decide.
Every review carries its unit's contract — intended outcome, what to judge
now, invariants, acceptance evidence, and work explicitly deferred to a
later unit; declared deferred work is not a finding. Severity-floor
semantics — floor **major** (BRIEF): findings at or above it block; max 3
review→fixup rounds per reviewed unit. A finding the harness should have
caught earns a new floor, not just a patch.

## Unblocking ladder

Investigate (two focused passes) → doctrine (Decisions here, BRIEF/SPEC
Decisions, loop-brief `doctrine.md`, memory) → `rl consult` with evidence +
candidate approaches + design excerpts → provisional decision (dated entry
above) → accumulate for the human (irreversible / scope-changing / Boundary
items only).

## In-session edit policy

The driver edits directly when the fix is finding-sized (≤ ~2 files,
mechanical, fully understood). After any in-session edit: run the owning
gates and commit conventionally — the edit lands in its unit's review
scope; the driver never self-approves. Larger or design-shaped work goes to
a cook packet. Never mix in-session edits with an in-flight worker on the
same files.

## Boundaries — NEVER

- Never push, open PRs, or merge — publish is the human's, per-artifact.
- Never touch live secrets or biometrics; never reroute around auth
  failures — surface and stop.
- Never reintroduce bare `.hunk/agent-context.json` auto-discovery.
- Never put full patch content hash in the conventional filename (v1).
- Never require the daemon, a live TUI session, or a TTY for discovery.
- Never weaken BRIEF floors or invent "pre-existing" failures without a
  cited red on clean `upstream/main` in this working copy (BRIEF Repo gates).
- Never commit `.hunk/` review/sidecar artifacts (agent-context dumps,
  review-comments) — LOOP.md is the exception as campaign charter.

## Known pre-existing failures — do not chase (cited evidence only)

- Full `bun run test` / `test:tty-smoke` flakiness or host-specific Sapling /
  session failures: only treat as pre-existing if the same failure is
  observed on detached `upstream/main` in **this** working copy (BRIEF).
  Until cited, do not park new breakage there.
- PR #540 greptile "author not in allowed list" — process noise, not a
  product defect.

## Terminal states & budget

- **done:** interior-green checklist:
  1. SPEC (and BRIEF if needed) describe keyed discovery; bare auto-load banned.
  2. Pure target-id + path helpers exist; tests prove Ben's acceptance cases.
  3. Config/watch/load path injects only the keyed conventional file.
  4. Docs/skill (and optional export/CLI path hint) teach agents the path.
  5. Branch tip implements the design; history remains feat-shaped for this
     unit; floors above green with cited output in State.
  6. Handoff written for human: push branch, PR vs `modem-dev/hunk`, reply
     on #540 with the convention, supersede/close #540 as appropriate.
     Then stop the loop; dissolution of LOOP.md rides ship (dissolve-docs after
     boundary clears).
- **blocked:** numbered decision batch, each with evidence + a proposed
  answer; keep working independent items until only the batch remains.
- **budget:** hard cap **8** iterations for the campaign — or, earlier,
  three consecutive iterations without measurable movement on any checklist
  item → stop honestly with what was tried and why it cannot converge.
