import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import * as vscode from "vscode";
import type { HunkReviewExtensionApi } from "../extension";
import type { ReviewExport } from "../reviewExport";

/**
 * End-to-end: the real extension, the real `hunk` binary, a real Git repo.
 *
 * Everything else in this suite scripts the CLI, which proves the extension asks the right
 * questions but not that Hunk answers them. This file closes that gap — it is the only
 * place where a change to the export payload on either side fails the build.
 *
 * Unix-only: it shims the binary with a shell script, the same exception the PTY suites
 * take. On Windows the scripted-CLI suite still covers the extension's own behavior.
 */

const isWindows = process.platform === "win32";
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
// `out/test/` -> package root -> `editors/` -> repo root.
const repoRoot = resolve(dirname(__dirname), "..", "..", "..");

let shimDir = "";
let shimPath = "";

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: workspaceRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

async function extensionApi(): Promise<HunkReviewExtensionApi> {
  const extension = vscode.extensions.getExtension("hunk.hunk-vscode");
  assert.ok(extension);
  return (await extension.activate()) as HunkReviewExtensionApi;
}

/**
 * Wait for a virtual document to hold the content the real binary produces.
 *
 * Invalidating a pre-image clears VS Code's cached copy and re-requests it, and that
 * request spawns a real `hunk` process. Bounded so a genuine failure still fails fast
 * rather than hanging the suite.
 *
 * Waiting for the *expected* text rather than for any non-empty text is deliberate. The
 * scripted suite in `review.test.ts` opens this very URI against a fake CLI, and VS Code
 * caches virtual documents per URI across suites — so "first non-empty answer wins" can
 * return that suite's fixture instead of anything this file asked for. The last text seen
 * is returned on timeout, which keeps the caller's assertion the thing that reports the
 * mismatch.
 */
async function readSource(
  path: string,
  side: "old" | "new",
  expected: string,
  attemptsMax = 60,
): Promise<string> {
  // The side belongs in the URI: it is what the provider reads, and it is what the
  // extension invalidates. A query-less URI would be a different document that never
  // refreshes.
  const uri = vscode.Uri.from({ scheme: "hunk-review", path: `/${path}`, query: `side=${side}` });
  let text = "";

  for (let attempt = 0; attempt < attemptsMax; attempt += 1) {
    const document = await vscode.workspace.openTextDocument(uri);
    text = document.getText();
    if (text === expected) {
      return text;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return text;
}

async function readPreImage(path: string, expected: string, attemptsMax = 60): Promise<string> {
  return readSource(path, "old", expected, attemptsMax);
}

function currentReview(api: HunkReviewExtensionApi): ReviewExport {
  const active = api.__getActiveReviewForTests();
  assert.ok(active, "expected an open review");
  return active.session.export;
}

/** Drive the real target picker without letting a test depend on QuickPick timing. */
async function selectTarget(choice: string, inputs: string[] = []): Promise<void> {
  const originalQuickPick = vscode.window.showQuickPick;
  const originalInput = vscode.window.showInputBox;
  const remaining = [...inputs];
  (vscode.window as { showQuickPick: unknown }).showQuickPick = () => Promise.resolve({ choice });
  (vscode.window as { showInputBox: unknown }).showInputBox = () =>
    Promise.resolve(remaining.shift() ?? "");

  try {
    await vscode.commands.executeCommand("hunkReview.selectTarget");
  } finally {
    (vscode.window as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
    (vscode.window as { showInputBox: unknown }).showInputBox = originalInput;
  }
}

suite("end to end against the real hunk binary", function () {
  // Bun startup plus a real changeset load runs well past mocha's default.
  this.timeout(120_000);

  suiteSetup(function () {
    if (isWindows) {
      this.skip();
      return;
    }

    shimDir = mkdtempSync(join(tmpdir(), "hunk-vscode-e2e-"));
    shimPath = join(shimDir, "hunk");
    // A shim rather than a compiled binary: this must test the working tree's Hunk, not
    // whatever version happens to be installed on the machine running the suite.
    writeFileSync(
      shimPath,
      `#!/bin/sh\nexec bun run ${JSON.stringify(join(repoRoot, "src", "main.tsx"))} "$@"\n`,
      "utf8",
    );
    chmodSync(shimPath, 0o755);

    // The fixture workspace becomes a real repo for the duration of the suite; `.git` here
    // is gitignored so it never leaks into Hunk's own history.
    rmSync(join(workspaceRoot, ".git"), { recursive: true, force: true });
    rmSync(join(workspaceRoot, ".hunk"), { recursive: true, force: true });
    rmSync(join(workspaceRoot, ".vscode"), { recursive: true, force: true });
    writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 1;\n");
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    git("add", "alpha.ts");
    git("commit", "-m", "initial");
    writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 10;\n");

    // Keyed conventional sidecar only — bare `.hunk/agent-context.json` is never
    // auto-loaded. The target is a working-tree review with no pathspecs, matching
    // `conventionalAgentContextPath` / `canonicalizeAgentContextTarget`.
    mkdirSync(join(workspaceRoot, ".hunk"), { recursive: true });
    const workingTreeTargetId = createHash("sha256")
      .update(["working-tree", ""].join("\0"))
      .digest("hex")
      .slice(0, 12);
    writeFileSync(
      join(workspaceRoot, ".hunk", `agent-context.${workingTreeTargetId}.json`),
      JSON.stringify({
        summary: "one-line changeset summary",
        files: [
          {
            path: "alpha.ts",
            summary: "bumped the constant",
            annotations: [
              { newRange: [1, 1], summary: "why ten", rationale: "the caller needs ten" },
            ],
          },
        ],
      }),
      "utf8",
    );
  });

  suiteTeardown(() => {
    if (isWindows) {
      return;
    }

    rmSync(shimDir, { recursive: true, force: true });
    rmSync(join(workspaceRoot, ".git"), { recursive: true, force: true });
    rmSync(join(workspaceRoot, ".hunk"), { recursive: true, force: true });
    rmSync(join(workspaceRoot, ".vscode"), { recursive: true, force: true });
    writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 1;\n");
  });

  setup(async () => {
    const api = await extensionApi();
    api.__setHunkRunnerForTests(undefined);
    // Global, not workspace: a workspace setting lands in `.vscode/settings.json` inside
    // the fixture repo, and Hunk would then correctly report it as an untracked change.
    await vscode.workspace
      .getConfiguration("hunkReview")
      .update("binaryPath", shimPath, vscode.ConfigurationTarget.Global);
  });

  test("the whole review round trip works against the real binary", async () => {
    const api = await extensionApi();

    await vscode.commands.executeCommand("hunkReview.openReview");
    const opened = currentReview(api);
    assert.equal(opened.exportVersion, 1);
    assert.deepEqual(
      opened.review.files.map((file) => file.path),
      ["alpha.ts"],
    );
    assert.deepEqual(opened.viewedFilePaths, []);

    // REQ-VSCODE-002: agent annotations reach the client, attached to their file.
    const notes = opened.review.reviewNotes ?? [];
    assert.equal(notes.length, 1, `expected one agent note, got ${JSON.stringify(notes)}`);
    assert.equal(notes[0]?.filePath, "alpha.ts");
    assert.ok(notes[0]?.body.includes("the caller needs ten"));

    // The pre-image comes back through the content provider, from Hunk, not from git.
    await vscode.commands.executeCommand("hunkReview.openFile", "alpha.ts");
    const preImage = "export const alpha = 1;\n";
    assert.equal(await readPreImage("alpha.ts", preImage), preImage);

    await vscode.commands.executeCommand("hunkReview.toggleViewed", "alpha.ts");
    assert.deepEqual(currentReview(api).viewedFilePaths, ["alpha.ts"]);

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), "alpha.ts"),
    );
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    (vscode.window as { showInputBox: unknown }).showInputBox = () =>
      Promise.resolve("why ten?\nsecond line");

    await vscode.commands.executeCommand("hunkReview.addComment", undefined);
    const withComment = currentReview(api);
    const comments = withComment.comments["alpha.ts"] ?? [];
    assert.equal(comments.length, 1, `expected one comment, got ${JSON.stringify(comments)}`);
    assert.equal(comments[0]?.status, "active");
    assert.equal(comments[0]?.line, 1);
    assert.ok(comments[0]?.body.includes("second line"), "multi-line body must survive stdin");

    // Change the anchored line out from under the comment, then refresh.
    writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 4321;\n");
    await vscode.commands.executeCommand("hunkReview.refresh");
    const afterEdit = currentReview(api);
    const outdated = afterEdit.comments["alpha.ts"] ?? [];
    assert.equal(outdated.length, 1, "an outdated comment is marked, never dropped");
    assert.equal(outdated[0]?.outdated, true);
    assert.equal(outdated[0]?.status, "active");
    assert.equal(outdated[0]?.body, comments[0]?.body);
    // The patch changed, so viewed state invalidates itself (REQ-REVIEW-007).
    assert.deepEqual(afterEdit.viewedFilePaths, []);

    await vscode.commands.executeCommand("hunkReview.resolveComment", {
      filePath: "alpha.ts",
      commentId: outdated[0]?.id,
    });
    const resolved = currentReview(api).comments["alpha.ts"]?.[0];
    assert.equal(resolved?.status, "resolved");
    // Resolving does not re-anchor it, so the stale placement stays visible.
    assert.equal(resolved?.outdated, true);

    await vscode.commands.executeCommand("hunkReview.deleteComment", {
      filePath: "alpha.ts",
      commentId: outdated[0]?.id,
    });
    assert.deepEqual(currentReview(api).comments["alpha.ts"] ?? [], []);
  });

  test("the real extension preserves every repo-backed target and source side", async () => {
    const api = await extensionApi();
    let historicalCommitCreated = false;

    // The preceding round-trip test intentionally leaves its working copy changed to prove
    // outdated comments. Re-establish the suite fixture before this independent operation
    // matrix starts.
    git("stash", "clear");
    git("reset", "--hard", "HEAD");
    writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 10;\n");

    try {
      // Working tree: the new side is the editable workspace file.
      await vscode.commands.executeCommand("hunkReview.openReview");
      assert.equal(currentReview(api).sourceCapabilities?.new, "workspace");

      // Staged: index content must win over a different dirty workspace value.
      git("add", "alpha.ts");
      writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 30;\n");
      await selectTarget("staged");
      assert.equal(currentReview(api).sourceCapabilities?.new, "hunk");
      await vscode.commands.executeCommand("hunkReview.openFile", "alpha.ts");
      assert.equal(
        await readSource("alpha.ts", "new", "export const alpha = 10;\n"),
        "export const alpha = 10;\n",
      );

      // Create one historical commit and leave a different dirty workspace value behind.
      git("reset", "--", "alpha.ts");
      writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 20;\n");
      git("add", "alpha.ts");
      git("commit", "-m", "historical review fixture");
      historicalCommitCreated = true;
      writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 99;\n");

      await selectTarget("show", ["HEAD", ""]);
      assert.equal(currentReview(api).review.inputKind, "show");
      assert.equal(currentReview(api).sourceCapabilities?.new, "hunk");
      await vscode.commands.executeCommand("hunkReview.openFile", "alpha.ts");
      assert.equal(
        await readSource("alpha.ts", "new", "export const alpha = 20;\n"),
        "export const alpha = 20;\n",
      );

      await selectTarget("custom", ["HEAD~1..HEAD", ""]);
      assert.equal(currentReview(api).review.inputKind, "vcs");
      assert.equal(currentReview(api).sourceCapabilities?.new, "hunk");
      await vscode.commands.executeCommand("hunkReview.openFile", "alpha.ts");
      assert.equal(
        await readSource("alpha.ts", "old", "export const alpha = 1;\n"),
        "export const alpha = 1;\n",
      );
      assert.equal(
        await readSource("alpha.ts", "new", "export const alpha = 20;\n"),
        "export const alpha = 20;\n",
      );

      writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 40;\n");
      git("stash", "push", "-m", "operation matrix fixture");
      await selectTarget("stash-show");
      assert.equal(currentReview(api).review.inputKind, "stash-show");
      assert.equal(currentReview(api).sourceCapabilities?.new, "hunk");
      await vscode.commands.executeCommand("hunkReview.openFile", "alpha.ts");
      assert.equal(
        await readSource("alpha.ts", "new", "export const alpha = 40;\n"),
        "export const alpha = 40;\n",
      );
    } finally {
      // Leave the shared fixture exactly as the following real-binary test expects it.
      git("stash", "clear");
      git("reset", "--hard", historicalCommitCreated ? "HEAD~1" : "HEAD");
      writeFileSync(join(workspaceRoot, "alpha.ts"), "export const alpha = 10;\n");
    }
  });

  test("a failure from the real binary reaches the user as its own message", async () => {
    const messages: string[] = [];
    const original = vscode.window.showErrorMessage;
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage = (message: string) => {
      messages.push(message);
      return Promise.resolve(undefined);
    };

    try {
      await vscode.commands.executeCommand("hunkReview.openReview");
      await vscode.commands.executeCommand("hunkReview.toggleViewed", "not-in-review.ts");
    } finally {
      (vscode.window as { showErrorMessage: unknown }).showErrorMessage = original;
    }

    assert.ok(
      messages.some((message) => message.includes("Hunk review")),
      `expected a refusal naming the review, got ${JSON.stringify(messages)}`,
    );
  });
});
