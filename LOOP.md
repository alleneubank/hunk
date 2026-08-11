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

- Branch `feat/local-review-vscode`, HEAD before this State rewrite was
  `4db3b534` (charter) over stack with bottom commit
  `749ec724 feat: auto-discover target-keyed agent-context sidecars`.
  Tree dirty only with residual floor fixes in flight (CLI keyed fixtures,
  viewed keybinding docs/public ids, regenerated website docs).
- **Product unit is implemented** against the design in
  `.hunk/AGENT-CONTEXT-DISCOVERY-DESIGN.md` and SPEC REQ-AGENT-001…007:
  - `agentContextTargetId` / `conventionalAgentContextPath` in
    `src/core/paths.ts`
  - config seam injects keyed path only (`src/core/config.ts` ~1126)
  - `agentContextPath` on `hunk review export --json`
  - skill/README/docs/agent-workflows teach the convention
  - history is feat-shaped: keyed discovery is commit 1 of the stack
- **Floors cited this session:**
  - `bun run typecheck` — clean
  - `bun run lint` — 0 warnings
  - focused: `bun test src/core/agentContextPath.test.ts
src/core/config.test.ts src/core/agent.test.ts
src/core/loaders.test.ts src/core/reviewExport.test.ts` — 170 pass
  - `bun test src/core/` — 672 pass
  - `bun run check:docs` — was stale (config.md + skill); regenerated
    green after `bun run generate:docs`
  - `bun run test` — **not yet green**: residual failures (see Residual)
- **Residual walls blocking interior-green (`bun run test`):**
  1. ~~`test/cli/review.test.ts` bare `agent-context.json` fixtures~~ —
     **fixed this iteration** (write keyed path via
     `conventionalAgentContextPath`).
  2. ~~`docs/keybindings.md` missing viewed commands +
     `PUBLIC_EXTENSION_COMMAND_IDS`~~ — **fixed this iteration**
     (stack debt from viewed feat; blocked whole-branch floors).
  3. **Still open — App interaction scroll/layout (4 fails)** in
     `src/ui/AppHost.interactions.test.tsx`:
     - `bootstrap preferences initialize the visible view state` —
       agent-note index after added line (`indexOf` note 1059 >
       code 918); note-before-code invariant broken or chrome shifted
       string layout.
     - `arrow keys scroll the review pane line by line` — after down,
       up cannot re-show `line01` (stuck at `line02`); likely top clamp
       / pinned header off-by-one under viewed chrome.
     - `the first down-arrow step still advances content under the
always-pinned file header above a collapsed gap` — one down
       does not reveal `line366` past the collapsed gap.
     - `pager mode arrow keys also scroll line by line` — downs do not
       reach `line08` at height 8 (viewport too tight or scroll dead).
       Evidence: frames show `viewed 0/1` status chrome; failures are
       **not** in keyed-discovery source, but block BRIEF whole-branch
       `bun run test`. Treat as Unit F; do not park as pre-existing
       without a red on detached `upstream/main` in this working copy.
- #540 still OPEN; reply/close is **Boundary** (human).
- Read first: this file → Decisions → SPEC Agent-context section →
  Residual Unit F tests → only then discovery code if floors regress.

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
   "fix" for discovery). **provisional (driver)** — **done** as
   `749ec724`.
6. 2026-08-11 — **Agent path surface:** single machine-readable field
   `agentContextPath` on `hunk review export --json` (absolute conventional
   path or null). Skill documents that; no separate `hunk agent-context path`
   command in v1. **provisional (driver)**
7. 2026-08-11 — Stack floor failures in App interactions / missing viewed
   keybinding docs are **in campaign residual** when they fail
   `bun run test`, even if not caused by keyed discovery — BRIEF whole-branch
   green is the campaign terminal. **provisional (driver)**

## Work plan (ADF per unit)

### Unit A — SPEC: keyed discovery contract — **DONE**

- REQ-AGENT-001…007 in `SPEC.md` (Agent-context auto-discovery section).

### Unit B — PLAN + TDD: pure target id + discovery seam — **DONE**

- `src/core/agentContextPath.test.ts` + config/loaders coverage.

### Unit C — DEV: wire config + watch + loaders — **DONE**

- Keyed path only; no dual-read of bare+keyed.

### Unit D — Docs / skill / CLI surface for agents — **DONE** (regenerate docs if stale)

- README, agent-workflows, skill, export field. Run `bun run generate:docs`
  when skill/config help change.

### Unit E — History + discovery tip — **DONE**

- Bottom of stack is `749ec724` keyed discovery; unscoped bare auto-load
  is gone from tip.

### Unit F — Whole-branch floor green (residual) — **IN PROGRESS**

- **Establishes:** `bun run test` green on this branch; App interaction
  scroll/layout floors pass; any remaining keyed-fixture test debt gone.
- **Done when:** BRIEF floors for this branch cited green:
  `typecheck`, `lint`, `check:docs`, `test` (and `test:integration` only
  if watch/loader PTY surface is touched again).
- **Defers:** push, PR, #540 reply (Boundary).

### Explicitly out of campaign scope

- Opening/merging the PR to modem-dev; force-push of shared refs without
  human; implementing content-hash filenames; dogfood fork release unless
  human asks.

## Verification floors

Per-change (owning unit):

- `bun run typecheck` — clean.
- Focused: `bun test src/core/config.test.ts src/core/agent.test.ts
src/core/loaders.test.ts src/core/agentContextPath.test.ts
src/core/reviewExport.test.ts` — all pass.
- CLI export fixtures: `bun test ./test/cli/review.test.ts` — all pass.
- App residual: `bun test src/ui/AppHost.interactions.test.tsx` — all pass
  before claiming Unit F.
- Docs touched: `bun run check:docs` when applicable.

Whole-branch (before **done**):

- `bun run typecheck`
- `bun run lint`
- `bun run check:docs`
- `bun run test` (BRIEF: not bare `bun test` that sweeps pty/smoke without
  intent)
- `bun run test:integration` if watch/loader PTY notes coverage is hit
- Do **not** require `test:vscode` for this campaign unless extension files
  change for discovery (they should not).

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
- **Do not list** the four AppHost.interactions failures above as
  pre-existing until proven on `upstream/main` — they currently fail on
  this feature branch and are Unit F work.

## Terminal states & budget

- **done:** interior-green checklist:
  1. SPEC (and BRIEF if needed) describe keyed discovery; bare auto-load banned. ✅
  2. Pure target-id + path helpers exist; tests prove Ben's acceptance cases. ✅
  3. Config/watch/load path injects only the keyed conventional file. ✅
  4. Docs/skill (and export path hint) teach agents the path. ✅
  5. Branch tip implements the design; history remains feat-shaped for this
     unit. ✅
  6. Whole-branch floors green with cited output in State (Unit F). ⬜
  7. Handoff written for human: push branch, PR vs `modem-dev/hunk`, reply
     on #540 with the convention, supersede/close #540 as appropriate.
     Then stop the loop; dissolution of LOOP.md rides ship (dissolve-docs after
     boundary clears).
- **blocked:** numbered decision batch, each with evidence + a proposed
  answer; keep working independent items until only the batch remains.
- **budget:** hard cap **8** iterations for the campaign — or, earlier,
  three consecutive iterations without measurable movement on any checklist
  item → stop honestly with what was tried and why it cannot converge.
  Iterations so far (estimate): 2 (implement A–E + history; residual floors).
  Remaining budget: **6**.
