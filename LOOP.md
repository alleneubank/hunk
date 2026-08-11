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

- **Terminal: interior-green for this campaign.** Product units A–E done;
  Unit F (whole-branch floors) green. Remaining work is **Boundary only**.
- Branch `feat/local-review-vscode`. Stack bottom:
  `749ec724 feat: auto-discover target-keyed agent-context sidecars`.
  Residual floor commits on top of charter (see `git log`).
- **Product law shipped:** `.hunk/agent-context.<targetId>.json`; bare
  `agent-context.json` never auto-loaded; resolution order per Decisions;
  `agentContextPath` on `hunk review export --json`.
- **Unit F fix:** AppHost scroll tests were exercising pure viewport scroll
  while default `cursorLine` is `"row"` (arrows move the marker). Scroll
  fixtures now set `initialCursorLine: "off"`. Bootstrap-prefs note order
  assertion matches note-after-annotated-line layout.
- **Floors cited green (this iteration):**
  - `bun run typecheck` — clean
  - `bun run lint` — 0 warnings / 0 errors
  - `bun run check:docs` — clean
  - focused discovery: 170 pass / 1 skip
    (`agentContextPath`, `config`, `agent`, `loaders`, `reviewExport`)
  - AppHost residual: 5 pass (4 former fails + related collapsed up)
  - `bun run test` — **2258 pass, 9 skip, 0 fail** (106s)
  - CLI smoke: keyed sidecar → `agentSummary=smoke notes`; bare-only →
    `agentSummary=undefined`
- #540 still OPEN; reply/close is **Boundary** (human). Nothing pushed.

### Handoff (human boundary)

1. Review tip / stack: `git log --oneline upstream/main..HEAD`
2. Push `feat/local-review-vscode` when ready (force-with-lease if history
   was rewritten earlier on this branch).
3. Open or update PR against `modem-dev/hunk`; cite REQ-AGENT-\* and #540.
4. Reply to @benvinegar on #540: convention
   `.hunk/agent-context.<targetId>.json`, no bare auto-load; agents use
   `agentContextPath` from `hunk review export --json`.
5. Supersede/close #540 as appropriate once PR is up.
6. After boundary clears: dissolve LOOP.md (dissolve-docs) into standing
   docs if anything remains only here.

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
7. 2026-08-11 — Stack floor failures that fail `bun run test` stay in-campaign
   residual until green. **provisional (driver)** — **cleared** this iteration.
8. 2026-08-11 — Pure viewport-scroll interaction tests must set
   `initialCursorLine: "off"` so arrows call `scrollDiff` rather than
   `moveLineCursor` under the default `"row"` marker mode. **provisional
   (driver)**

## Work plan (ADF per unit)

### Unit A — SPEC — **DONE**

### Unit B — TDD pure helpers — **DONE**

### Unit C — DEV config/watch — **DONE**

### Unit D — Docs/skill/export — **DONE**

### Unit E — History — **DONE**

### Unit F — Whole-branch floors — **DONE**

### Explicitly out of campaign scope

- Opening/merging the PR to modem-dev; force-push without human;
  content-hash filenames; dogfood fork release unless human asks.

## Verification floors

Per-change (owning unit):

- `bun run typecheck` — clean.
- Focused discovery suites — all pass.
- CLI export fixtures — all pass.
- AppHost interactions — all pass.
- Docs: `bun run check:docs` when applicable.

Whole-branch (before **done**):

- `bun run typecheck` / `lint` / `check:docs` / `test` — all green (cited).

Review gate — harness first, briefed reviews; severity floor **major**
(BRIEF); max 3 review→fixup rounds per unit.

## Unblocking ladder

Investigate → doctrine → `rl consult` → provisional decision → accumulate
for the human (Boundary only).

## In-session edit policy

Driver edits finding-sized work; run owning gates; commit conventionally.
Never self-approve.

## Boundaries — NEVER

- Never push, open PRs, or merge — publish is the human's, per-artifact.
- Never touch live secrets or biometrics; never reroute around auth
  failures — surface and stop.
- Never reintroduce bare `.hunk/agent-context.json` auto-discovery.
- Never put full patch content hash in the conventional filename (v1).
- Never require the daemon, a live TUI session, or a TTY for discovery.
- Never weaken BRIEF floors or invent "pre-existing" failures without a
  cited red on clean `upstream/main` in this working copy (BRIEF Repo gates).
- Never commit `.hunk/` review/sidecar artifacts — LOOP.md is the exception
  as campaign charter.

## Known pre-existing failures — do not chase (cited evidence only)

- Host-specific Sapling / session skips in the suite are intentional skips
  (9 skipped on this host); not product reds.
- PR #540 greptile "author not in allowed list" — process noise.

## Terminal states & budget

- **done:** interior-green checklist:
  1. SPEC keyed discovery; bare auto-load banned. ✅
  2. Pure target-id + path helpers + Ben cases. ✅
  3. Config injects only keyed conventional file. ✅
  4. Docs/skill + export path surface. ✅
  5. Feat-shaped history; tip implements design. ✅
  6. Whole-branch floors green with cited output. ✅
  7. Handoff written for human boundary. ✅
- Loop should **stop**. Dissolution of LOOP.md after boundary clears.
- **budget:** hard cap 8; used ~3; remaining unused.
