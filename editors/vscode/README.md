# Hunk for VS Code

A local review surface for a Hunk changeset: the agent's rationale beside the code it
explains, comments that survive a reload, and per-file viewed state — with no daemon, no
registered session, and no terminal.

The extension is a _client_ of the `hunk` CLI. It spawns the binary, consumes
`hunk review export --json`, and writes review state back through `hunk review comment` and
`hunk review viewed set`. It never reads git, never writes `.hunk/` itself, and replaces its
whole payload after every write, so it holds no state that can drift. `SPEC.md` and
`BRIEF.md` at the repo root are the contract and the quality law.

## Running the suites

From the repo root:

```sh
bun run typecheck:vscode   # bun run --filter hunk-vscode typecheck
bun run test:vscode        # bun run --filter hunk-vscode test
```

Reach the package through `bun run --filter hunk-vscode`. A root script that does
`cd editors/vscode && vscode-test` fails with `command not found`.

## Toolchain constraints

These are load-bearing. Changing any of them breaks files that have nothing to do with this
package.

- **The package stays outside `packages/`.** `bun test ./packages` picks up its host-only
  tests (`Cannot find package 'vscode'`), and the root `tsconfig.json` includes
  `packages/**/*.ts`, which drags `@types/node` into the Bun program and breaks unrelated
  files with `Property 'once' does not exist on type 'Server'`. `editors/*` is in
  `workspaces` instead.
- **`@types/node` is pinned to `^25.5.0`.** A lower pin re-resolves it workspace-wide and
  reproduces exactly the `Server.once` / `ChildProcess.once` / `FSWatcher.on` errors above.
- **`.vscode-test/` holds a downloaded VS Code (~300 MB).** It and `out/` are git-ignored.
  Never commit either.

## Writing extension-host tests

`vscode-test` runs the real extension host, so the suites in `src/test/` are integration
tests against a live editor. Two costs already paid for:

- Set `hunkReview.binaryPath` at **Global** scope. A workspace setting writes
  `.vscode/settings.json` into the fixture repo, and Hunk then correctly reports it as an
  untracked change — which the assertions did not expect.
- **Poll for virtual-document content** rather than reading it once. Invalidation re-requests
  the document asynchronously and the fetch spawns a real process. Asserting on the first
  read is how VS Code's per-URI document cache serves a stale fixture across suites.

`src/test/endToEnd.test.ts` drives the real binary against a real Git repo. It shims the
binary with a `#!/bin/sh exec bun run src/main.tsx` script and git-inits the fixture
workspace, which makes it Unix-only — the same exception the PTY suites take.
