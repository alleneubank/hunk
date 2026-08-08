import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { HunkRunResult, HunkRunner } from "../hunkCli";
import type { ReviewExport } from "../reviewExport";

import type { HunkReviewExtensionApi } from "../extension";
import { ReviewDirectoryItem, ReviewFileItem } from "../reviewTree";

/** One recorded CLI invocation, so tests can assert what the extension asked Hunk for. */
interface RecordedCall {
  args: string[];
  input?: string;
}

/** The folder the extension host opened, which reviewed paths resolve against. */
function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "/repo";
}

/** Build a minimal but valid export payload. */
function buildExport(overrides: Partial<ReviewExport> = {}): ReviewExport {
  return {
    exportVersion: 1,
    reviewCommentsVersion: 1,
    sourceCapabilities: { old: "hunk", new: "workspace" },
    // Real, not a placeholder: the extension resolves documents against this, so a fake
    // root would make every workspace-file lookup miss.
    repoRoot: workspaceRoot(),
    review: {
      title: "working tree",
      files: [
        {
          id: "alpha",
          path: "alpha.ts",
          additions: 1,
          deletions: 1,
          hunkCount: 1,
          hunks: [{ index: 0, header: "@@ -1,2 +1,2 @@", newStart: 1, newLines: 2 }],
        },
      ],
      reviewNotes: [],
    },
    viewedFilePaths: [],
    commentsAvailable: true,
    comments: {},
    ...overrides,
  };
}

/** The envelope `hunk review` wraps a write's result in. */
interface ReviewEnvelope {
  operation: string;
  commentId?: string;
  review: ReviewExport;
}

/** The envelope returned by `hunk review focus get`. */
interface FocusEnvelope {
  focus: unknown;
}

/** One scripted CLI response: a raw process result, a payload, or a thrown failure. */
type ScriptedResponse =
  | Partial<HunkRunResult>
  | ReviewExport
  | ReviewEnvelope
  | FocusEnvelope
  | ((args: string[]) => unknown);

/**
 * Script the CLI so the harness exercises the real extension against known payloads.
 *
 * The extension is the unit under test, not the binary: what matters here is that it asks
 * Hunk the right question and renders the answer without inventing anything.
 */
function scriptRunner(responses: ScriptedResponse[]) {
  const calls: RecordedCall[] = [];
  let index = 0;

  const runner: HunkRunner = async (_binary, args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const resolved = typeof response === "function" ? response(args) : response;

    if (resolved && typeof resolved === "object" && "exitCode" in resolved) {
      return { exitCode: 0, stdout: "", stderr: "", ...(resolved as Partial<HunkRunResult>) };
    }

    return { exitCode: 0, stdout: JSON.stringify(resolved), stderr: "" };
  };

  return { runner, calls };
}

async function extensionApi(): Promise<HunkReviewExtensionApi> {
  const extension = vscode.extensions.getExtension("hunk.hunk-vscode");
  assert.ok(extension, "extension not found in the host");
  return (await extension.activate()) as HunkReviewExtensionApi;
}

/** Poll until the active tab is a side-by-side diff (REQ-VSCODE-022 promotion). */
async function waitForActiveTextDiff(timeoutMs = 5000): Promise<vscode.TabInputTextDiff> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab?.input instanceof vscode.TabInputTextDiff) {
      return tab.input;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for an active text diff tab");
}

/** Poll until a visible editor matches the predicate (reveal / focus assertions). */
async function waitForVisibleEditor(
  match: (editor: vscode.TextEditor) => boolean,
  timeoutMs = 5000,
): Promise<vscode.TextEditor> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const editor = vscode.window.visibleTextEditors.find(match);
    if (editor) {
      return editor;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for a matching visible editor");
}

/** Scripted pre-image so opening a review diff does not fail the content provider. */
function alphaSourceResponse(args: string[]): { path: string; side: string; text: string } {
  const side = args[args.indexOf("--side") + 1] ?? "old";
  return { path: "alpha.ts", side, text: "export const alpha = 1;\n" };
}

/** Collect the error/warning messages VS Code was asked to show during one action. */
async function captureMessages<T>(
  action: () => Promise<T>,
): Promise<{ result: T; shown: string[] }> {
  const shown: string[] = [];
  const originalError = vscode.window.showErrorMessage;
  const originalWarning = vscode.window.showWarningMessage;
  const originalInput = vscode.window.showInputBox;

  (vscode.window as { showErrorMessage: unknown }).showErrorMessage = (message: string) => {
    shown.push(message);
    return Promise.resolve(undefined);
  };
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (message: string) => {
    shown.push(message);
    return Promise.resolve(undefined);
  };

  try {
    return { result: await action(), shown };
  } finally {
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage = originalError;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
    (vscode.window as { showInputBox: unknown }).showInputBox = originalInput;
  }
}

suite("hunk review in VS Code", () => {
  teardown(async () => {
    (await extensionApi()).__setHunkRunnerForTests(undefined);
  });

  test("opening a review loads the changeset from `hunk review export`", async () => {
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([buildExport()]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args.slice(0, 3), ["review", "export", "--json"]);
    assert.ok(calls[0]?.args.includes("--repo"));
    assert.equal(api.__getActiveReviewForTests()?.session.files.length, 1);
  });

  test("a version mismatch fails with an actionable message and no review", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([buildExport({ exportVersion: 99 })]);
    api.__setHunkRunnerForTests(runner);

    const { shown } = await captureMessages(() =>
      Promise.resolve(vscode.commands.executeCommand("hunkReview.openReview")),
    );

    // REQ-VSCODE-006: no silent fallback, and no partially rendered review.
    assert.ok(
      shown.some((message) => message.includes("v99")),
      `expected a version-mismatch message, got ${JSON.stringify(shown)}`,
    );
  });

  test("a failed target replacement leaves the current review intact", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport(),
      {
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({ error: { kind: "user", message: "invalid target" } }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const before = api.__getActiveReviewForTests();
    assert.ok(before);

    const originalQuickPick = vscode.window.showQuickPick;
    const originalInput = vscode.window.showInputBox;
    (vscode.window as { showQuickPick: unknown }).showQuickPick = () =>
      Promise.resolve({ choice: "staged" });
    (vscode.window as { showInputBox: unknown }).showInputBox = () => Promise.resolve("");

    try {
      const { shown } = await captureMessages(() =>
        Promise.resolve(vscode.commands.executeCommand("hunkReview.selectTarget")),
      );
      assert.ok(shown.some((message) => message.includes("invalid target")));
    } finally {
      (vscode.window as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
      (vscode.window as { showInputBox: unknown }).showInputBox = originalInput;
    }

    assert.equal(api.__getActiveReviewForTests(), before);
    assert.deepEqual(api.__getActiveReviewForTests()?.target, { kind: "working-tree" });
  });

  test("a focus on a file outside the review is recoverable", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport(),
      {
        focus: {
          target: { kind: "working-tree" },
          file: "not-in-review.ts",
          side: "new",
          line: 1,
          revision: 1,
        },
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const before = api.__getActiveReviewForTests();
    assert.ok(before);

    const { shown } = await captureMessages(() =>
      Promise.resolve(vscode.commands.executeCommand("hunkReview.followFocus")),
    );

    assert.ok(
      shown.some(
        (message) =>
          message.includes("not-in-review.ts") && message.includes("Choose what to review"),
      ),
      `expected a recoverable focus warning, got ${JSON.stringify(shown)}`,
    );
    assert.equal(api.__getActiveReviewForTests(), before);
  });

  test("a missing binary reports how to fix it", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      () => {
        throw new Error("spawn hunk ENOENT");
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    const { shown } = await captureMessages(() =>
      Promise.resolve(vscode.commands.executeCommand("hunkReview.openReview")),
    );

    assert.ok(shown.length > 0, "expected an error message");
  });

  test("a CLI failure surfaces Hunk's own message", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      {
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({
          error: { kind: "user", message: "not a Git repository", suggestions: ["cd somewhere"] },
        }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    const { shown } = await captureMessages(() =>
      Promise.resolve(vscode.commands.executeCommand("hunkReview.openReview")),
    );

    assert.ok(
      shown.some((message) => message.includes("not a Git repository")),
      `expected Hunk's message, got ${JSON.stringify(shown)}`,
    );
  });

  test("an unreadable comment store warns instead of showing zero comments", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport({
        commentsAvailable: false,
        commentsUnavailableReason: "/repo/.hunk/review-comments.json is not valid JSON.",
      }),
    ]);
    api.__setHunkRunnerForTests(runner);

    const { shown } = await captureMessages(() =>
      Promise.resolve(vscode.commands.executeCommand("hunkReview.openReview")),
    );

    assert.ok(
      shown.some((message) => message.includes("review-comments.json")),
      `expected an unavailable-store warning, got ${JSON.stringify(shown)}`,
    );
  });

  test("toggling viewed state calls `hunk review viewed set` and re-reads the review", async () => {
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([
      buildExport(),
      { operation: "viewed-set", review: buildExport({ viewedFilePaths: ["alpha.ts"] }) },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    await vscode.commands.executeCommand("hunkReview.toggleViewed", "alpha.ts");

    assert.deepEqual(calls[1]?.args.slice(0, 4), ["review", "viewed", "set", "--file"]);
    assert.ok(calls[1]?.args.includes("--viewed"));
    assert.deepEqual(api.__getActiveReviewForTests()?.session.export.viewedFilePaths, ["alpha.ts"]);
  });

  test("the inline check mark marks viewed, given the row VS Code actually passes", async () => {
    // A `view/item/context` command is handed the TreeItem, never a path. The handler used
    // to take `path?: string`, so clicking the check mark compared a path against an object,
    // matched nothing, and told the user to select the file they had just clicked. No test
    // caught it because every test passed a string.
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([
      buildExport(),
      { operation: "viewed-set", review: buildExport({ viewedFilePaths: ["alpha.ts"] }) },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const state = api.__getActiveReviewForTests()?.session.files[0];
    assert.ok(state);

    await vscode.commands.executeCommand("hunkReview.toggleViewed", new ReviewFileItem(state));

    assert.ok(calls[1]?.args.includes("--viewed"), "expected a viewed write");
    assert.deepEqual(api.__getActiveReviewForTests()?.session.export.viewedFilePaths, ["alpha.ts"]);
  });

  test("every row-invoked command accepts a row, not just a path", async () => {
    // The contract under test is the argument, not the outcome: VS Code types the menu
    // argument as `any`, so a handler that expects something else fails only at runtime.
    // Each command here is reachable from `view/item/context` in `package.json`.
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport(),
      { operation: "viewed-set", review: buildExport({ viewedFilePaths: ["alpha.ts"] }) },
      { operation: "viewed-set", review: buildExport() },
      { operation: "viewed-set", review: buildExport({ viewedFilePaths: ["alpha.ts"] }) },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const state = api.__getActiveReviewForTests()?.session.files[0];
    assert.ok(state);

    const fileRow = new ReviewFileItem(state);
    const directoryRow = new ReviewDirectoryItem("src", "src", [fileRow], [state]);

    const { shown } = await captureMessages(async () => {
      await vscode.commands.executeCommand("hunkReview.toggleViewed", fileRow);
      await vscode.commands.executeCommand("hunkReview.markFolderViewed", directoryRow);
      await vscode.commands.executeCommand("hunkReview.markFolderUnviewed", directoryRow);
    });

    assert.deepEqual(shown, [], "no row-invoked command may reject its own row");
  });

  test("adding a comment sends the body on stdin, never on argv", async () => {
    const api = await extensionApi();
    const body = "multi\nline body";
    const { runner, calls } = scriptRunner([
      buildExport(),
      {
        operation: "comment-add",
        commentId: "c1",
        review: buildExport({
          comments: {
            "alpha.ts": [
              {
                id: "c1",
                body,
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
                side: "new",
                line: 1,
                originalLine: 1,
                status: "active",
                outdated: false,
              },
            ],
          },
        }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);
    (vscode.window as { showInputBox: unknown }).showInputBox = () => Promise.resolve(body);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, "alpha.ts"),
    );
    await vscode.window.showTextDocument(document);

    await captureMessages(() =>
      Promise.resolve(vscode.commands.executeCommand("hunkReview.addComment", undefined)),
    );

    const addCall = calls.find((call) => call.args.includes("add"));
    assert.ok(addCall, "expected a comment add call");
    assert.equal(addCall.input, body);
    assert.ok(
      !addCall.args.some((arg) => arg.includes("multi")),
      "comment body must not appear in argv",
    );
    assert.ok(addCall.args.includes("--stdin"));
  });

  test("an outdated comment stays visible and says so", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport({
        comments: {
          "alpha.ts": [
            {
              id: "c1",
              body: "still relevant?",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              side: "new",
              line: 3,
              originalLine: 3,
              status: "active",
              outdated: true,
            },
          ],
        },
      }),
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");

    // REQ-VSCODE-005: hiding it would silently drop authored review work.
    const comments = api.__getActiveReviewForTests()?.session.export.comments["alpha.ts"];
    assert.equal(comments?.length, 1);
    // Placement is its own fact: the comment is still active, its anchor is not.
    assert.equal(comments?.[0]?.outdated, true);
    assert.equal(comments?.[0]?.status, "active");
  });

  test("opening a file diff asks Hunk for the pre-image rather than reading git", async () => {
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([
      buildExport(),
      {
        exitCode: 0,
        stdout: JSON.stringify({ path: "alpha.ts", side: "old", text: "old text\n" }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    await vscode.commands.executeCommand("hunkReview.openFile", "alpha.ts");

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.from({ scheme: "hunk-review", path: "/alpha.ts", query: "side=old" }),
    );

    assert.equal(document.getText(), "old text\n");
    assert.ok(
      calls.some((call) => call.args.includes("source")),
      "expected a `review file source` call",
    );
  });

  // `null` is a real answer from this command -- the side does not exist -- so a client that
  // maps anything it does not recognize to null reports "no old side" for a broken response,
  // and the editor renders that as an empty document. A malformed payload has to surface.
  test("a malformed file-source response fails instead of rendering as empty", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport(),
      {
        exitCode: 0,
        // Answers about a different file than the one that was asked for.
        stdout: JSON.stringify({ path: "other.ts", side: "old", text: "wrong file\n" }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");

    const active = api.__getActiveReviewForTests();
    assert.ok(active, "expected an open review");
    // Asserted on the client call itself: routing it through the document provider would
    // measure VS Code's virtual-document cache as much as the validation.
    await assert.rejects(async () => {
      await active.cli.fileSource("alpha.ts", "old");
    });
  });

  // A deleted file has no working-tree document. Asking VS Code to diff against one just
  // fails, so both sides have to come from Hunk.
  test("a deleted file diffs against Hunk-served documents on both sides", async () => {
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([
      buildExport({
        review: {
          title: "working tree",
          files: [
            {
              id: "gone",
              path: "gone.ts",
              additions: 0,
              deletions: 2,
              hunkCount: 1,
              changeType: "deleted",
              hunks: [{ index: 0, header: "@@ -1,2 +0,0 @@", oldStart: 1, oldLines: 2 }],
            },
          ],
          reviewNotes: [],
        },
      }),
      // Answered from the request, not by position: both sides are fetched and the order is
      // VS Code's to choose, so a positional fixture would answer one of them wrongly.
      (args: string[]) => {
        const side = args[args.indexOf("--side") + 1];
        // A deleted file keeps its old side and genuinely has no new one.
        return { path: "gone.ts", side, text: side === "old" ? "gone\n" : null };
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    await vscode.commands.executeCommand("hunkReview.openFile", "gone.ts");

    const sides = calls
      .filter((call) => call.args.includes("source"))
      .map((call) => call.args[call.args.indexOf("--side") + 1]);

    // Both sides were requested from Hunk; neither resolved to a file on disk.
    assert.ok(sides.includes("old"), `expected an old-side fetch, got ${JSON.stringify(sides)}`);
    assert.ok(sides.includes("new"), `expected a new-side fetch, got ${JSON.stringify(sides)}`);
  });

  test("a historical new side is served by Hunk, never by the live workspace", async () => {
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([
      buildExport({ sourceCapabilities: { old: "hunk", new: "hunk" } }),
      (args: string[]) => {
        const side = args[args.indexOf("--side") + 1];
        return { path: "alpha.ts", side, text: `${side} historical\n` };
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    await vscode.commands.executeCommand("hunkReview.openFile", "alpha.ts");

    const sides = calls
      .filter((call) => call.args.includes("source"))
      .map((call) => call.args[call.args.indexOf("--side") + 1]);
    assert.ok(sides.includes("old"), `expected an old-side fetch, got ${JSON.stringify(sides)}`);
    assert.ok(sides.includes("new"), `expected a new-side fetch, got ${JSON.stringify(sides)}`);
  });

  // Hunk resolved the comment against the old side; the same line number on the new side is
  // a different line.
  test("an old-side comment is placed in the pre-image, not the working file", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport({
        comments: {
          "alpha.ts": [
            {
              id: "c1",
              body: "why was this removed?",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              side: "old",
              line: 4,
              originalLine: 4,
              status: "active",
              outdated: false,
            },
          ],
        },
      }),
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const thread = api.__getActiveReviewForTests()?.comments.threads.at(-1);

    assert.ok(thread, "expected a rendered comment thread");
    assert.equal(thread.uri.scheme, "hunk-review");
    assert.equal(thread.uri.query, "side=old");
    assert.equal(thread.range?.start.line, 3);
  });

  // REQ-VSCODE-022: the Comments panel opens the thread URI alone; that must become the
  // review diff, not a lone working-tree (or pre-image) document.
  test("opening a new-side reviewed document plain promotes into the review diff", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport({
        comments: {
          "alpha.ts": [
            {
              id: "c1",
              body: "check this",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              side: "new",
              line: 1,
              originalLine: 1,
              status: "active",
              outdated: false,
            },
          ],
        },
      }),
      alphaSourceResponse,
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("hunkReview.openReview");
    const thread = api.__getActiveReviewForTests()?.comments.threads.at(-1);
    assert.ok(thread, "expected a rendered comment thread");
    assert.equal(thread.uri.scheme, "file");

    const document = await vscode.workspace.openTextDocument(thread.uri);
    const line = thread.range?.start.line ?? 0;
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(line, 0, line, 0),
      preview: false,
    });

    const input = await waitForActiveTextDiff();
    assert.equal(input.original.scheme, "hunk-review");
    assert.ok(
      input.modified.fsPath.endsWith("alpha.ts"),
      `expected modified side to be the workspace file, got ${input.modified.toString()}`,
    );

    // Revealed on the new-side document, not left on a random line after promote.
    const revealed = await waitForVisibleEditor(
      (editor) =>
        editor.document.uri.scheme === "file" &&
        editor.document.uri.fsPath.endsWith("alpha.ts") &&
        editor.selection.active.line === line,
    );
    assert.equal(revealed.selection.active.line, line);

    // The plain Comments-panel tab must not linger beside the review diff.
    const plainLeft = vscode.window.tabGroups.activeTabGroup.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === thread.uri.toString(),
    );
    assert.equal(plainLeft, false);
  });

  test("opening an old-side reviewed document plain promotes into the review diff", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport({
        comments: {
          "alpha.ts": [
            {
              id: "c1",
              body: "why was this removed?",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              side: "old",
              line: 1,
              originalLine: 1,
              status: "active",
              outdated: false,
            },
          ],
        },
      }),
      alphaSourceResponse,
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("hunkReview.openReview");
    const thread = api.__getActiveReviewForTests()?.comments.threads.at(-1);
    assert.ok(thread, "expected a rendered comment thread");
    assert.equal(thread.uri.scheme, "hunk-review");

    const document = await vscode.workspace.openTextDocument(thread.uri);
    const line = thread.range?.start.line ?? 0;
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(line, 0, line, 0),
      preview: false,
    });

    const input = await waitForActiveTextDiff();
    assert.equal(input.original.scheme, "hunk-review");
    assert.equal(input.original.query, "side=old");
    assert.ok(
      input.modified.fsPath.endsWith("alpha.ts"),
      `expected modified side to be the workspace file, got ${input.modified.toString()}`,
    );

    const revealed = await waitForVisibleEditor(
      (editor) =>
        editor.document.uri.scheme === "hunk-review" &&
        editor.document.uri.query === "side=old" &&
        editor.selection.active.line === line,
    );
    assert.equal(revealed.document.uri.query, "side=old");
    assert.equal(revealed.selection.active.line, line);
  });

  test("a plain open of a non-reviewed file is not promoted", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([buildExport(), alphaSourceResponse]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("hunkReview.openReview");

    // Fixture workspace only has alpha.ts under review; open a path outside the export.
    const outside = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      "not-in-review.ts",
    );
    await vscode.workspace.fs.writeFile(outside, Buffer.from("not reviewed\n"));
    try {
      const document = await vscode.workspace.openTextDocument(outside);
      await vscode.window.showTextDocument(document, { preview: false });

      // Give the promote handler a beat; it must leave this as a plain tab.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab?.input instanceof vscode.TabInputText);
      assert.equal((tab.input as vscode.TabInputText).uri.fsPath, outside.fsPath);
    } finally {
      await vscode.workspace.fs.delete(outside, { useTrash: false });
    }
  });

  test("an already-open review diff is left alone by promotion", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([buildExport(), alphaSourceResponse]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("hunkReview.openReview");
    await vscode.commands.executeCommand("hunkReview.openFile", "alpha.ts");
    await waitForActiveTextDiff();

    // Re-activate the modified side of the already-open diff: must not open a second pair.
    const modified = vscode.window.visibleTextEditors.find(
      (editor) =>
        editor.document.uri.scheme === "file" && editor.document.uri.fsPath.endsWith("alpha.ts"),
    );
    assert.ok(modified, "expected the new side of the review diff to be visible");
    await vscode.window.showTextDocument(modified.document, {
      viewColumn: modified.viewColumn,
      preview: false,
      preserveFocus: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
    );
    assert.equal(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputTextDiff).length,
      1,
      "promotion must not stack a second review diff tab",
    );
  });

  // Opening a subdirectory of a repository is ordinary; repo-relative paths are still
  // relative to the repository, not to the folder VS Code happens to have open.
  test("resolves reviewed paths against the repo root the export reports", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport({
        repoRoot: "/canonical-root",
        comments: {
          "alpha.ts": [
            {
              id: "c1",
              body: "on the new side",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              side: "new",
              line: 1,
              originalLine: 1,
              status: "active",
              outdated: false,
            },
          ],
        },
      }),
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const thread = api.__getActiveReviewForTests()?.comments.threads.at(-1);

    assert.ok(thread, "expected a rendered comment thread");
    assert.equal(thread.uri.scheme, "file");
    assert.equal(thread.uri.path, "/canonical-root/alpha.ts");
  });

  test("a comment and its replies render as one conversation, in order", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      buildExport({
        comments: {
          "alpha.ts": [
            {
              id: "c1",
              body: "why 10?",
              author: "allen",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              side: "new",
              line: 1,
              originalLine: 1,
              status: "active",
              outdated: false,
              replies: [
                {
                  id: "r1",
                  body: "the constant moved",
                  author: "Claude",
                  createdAt: "2026-08-01T00:01:00.000Z",
                  updatedAt: "2026-08-01T00:01:00.000Z",
                },
                {
                  id: "r2",
                  body: "makes sense",
                  author: "allen",
                  createdAt: "2026-08-01T00:02:00.000Z",
                  updatedAt: "2026-08-01T00:02:00.000Z",
                },
              ],
            },
          ],
        },
      }),
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");

    const threads = api.__getActiveReviewForTests()?.comments.threads ?? [];
    // One thread, not three: a reply drawn as its own thread would sit on a line it was
    // never written against and read as a second opinion rather than an answer.
    assert.equal(threads.length, 1);
    const thread = threads[0]!;
    assert.deepEqual(
      thread.comments.map((comment) => (comment as { commentId?: string }).commentId),
      ["c1", "r1", "r2"],
    );
    assert.equal(thread.canReply, true);
    assert.equal(thread.state, vscode.CommentThreadState.Unresolved);
  });

  test("replying answers the conversation instead of opening a new one", async () => {
    const api = await extensionApi();
    const comment = {
      id: "c1",
      body: "why 10?",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      side: "new" as const,
      line: 1,
      originalLine: 1,
      status: "active" as const,
      outdated: false,
    };
    const { runner, calls } = scriptRunner([
      buildExport({ comments: { "alpha.ts": [comment] } }),
      {
        operation: "comment-reply",
        commentId: "r1",
        review: buildExport({
          comments: {
            "alpha.ts": [
              {
                ...comment,
                replies: [
                  {
                    id: "r1",
                    body: "because the constant moved",
                    createdAt: "2026-08-01T00:01:00.000Z",
                    updatedAt: "2026-08-01T00:01:00.000Z",
                  },
                ],
              },
            ],
          },
        }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const thread = api.__getActiveReviewForTests()?.comments.threads[0];
    assert.ok(thread, "expected a rendered comment thread");

    await captureMessages(() =>
      Promise.resolve(
        vscode.commands.executeCommand("hunkReview.addComment", {
          thread,
          text: "because the constant moved",
        }),
      ),
    );

    const replyCall = calls.find((call) => call.args.includes("reply"));
    assert.ok(replyCall, `expected a comment reply call, got ${JSON.stringify(calls)}`);
    // The id names the comment being answered — the reply must not be re-derived from the
    // thread's line, which is where a second root would land instead.
    const idAt = replyCall.args.indexOf("--id");
    assert.deepEqual(replyCall.args.slice(idAt, idAt + 2), ["--id", "c1"]);
    assert.ok(replyCall.args.includes("--stdin"));
    assert.equal(replyCall.input, "because the constant moved");
    assert.ok(
      !calls.some((call) => call.args.includes("add")),
      "a reply must not be written as a new top-level comment",
    );
  });

  test("a resolved conversation says so, and can be reopened", async () => {
    const api = await extensionApi();
    const resolved = {
      id: "c1",
      body: "why 10?",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      side: "new" as const,
      line: 1,
      originalLine: 1,
      status: "resolved" as const,
      outdated: false,
    };
    const { runner, calls } = scriptRunner([
      buildExport({ comments: { "alpha.ts": [resolved] } }),
      {
        operation: "comment-status",
        review: buildExport({
          comments: { "alpha.ts": [{ ...resolved, status: "active" as const }] },
        }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const thread = api.__getActiveReviewForTests()?.comments.threads[0];
    assert.equal(thread?.state, vscode.CommentThreadState.Resolved);

    await captureMessages(() =>
      Promise.resolve(
        vscode.commands.executeCommand("hunkReview.unresolveComment", {
          filePath: "alpha.ts",
          commentId: "c1",
        }),
      ),
    );

    // Reopening is the inverse of resolving, not a second way to spell it: without it one
    // misclick closes a conversation permanently and the only remedy left is deleting it.
    const statusCall = calls.find((call) => call.args.includes("status"));
    assert.ok(statusCall, "expected a comment status call");
    const statusAt = statusCall.args.indexOf("--status");
    assert.deepEqual(statusCall.args.slice(statusAt, statusAt + 2), ["--status", "active"]);
    assert.equal(
      api.__getActiveReviewForTests()?.comments.threads[0]?.state,
      vscode.CommentThreadState.Unresolved,
    );
  });

  test("a comment carrying neither a note nor a comment id is refused, not guessed at", async () => {
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([buildExport()]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const callsAfterOpen = calls.length;

    const { shown } = await captureMessages(async () => {
      await vscode.commands.executeCommand("hunkReview.resolveComment", { filePath: "alpha.ts" });
      await vscode.commands.executeCommand("hunkReview.deleteComment", { filePath: "alpha.ts" });
    });

    assert.equal(shown.length, 2, `expected two refusals, got ${JSON.stringify(shown)}`);
    assert.equal(calls.length, callsAfterOpen, "a refused action must not call Hunk");
  });

  /** An export whose one file carries one agent note. */
  function exportWithNote(overrides: Partial<ReviewExport> = {}): ReviewExport {
    const base = buildExport(overrides);
    return {
      ...base,
      review: {
        ...base.review,
        reviewNotes: [
          {
            noteId: "ai:repo:0:alpha.ts:0",
            noteKey: "note-key-1",
            source: "ai",
            filePath: "alpha.ts",
            newRange: [1, 1],
            body: "One placement rule, used by every surface.",
            title: "One placement rule",
            author: "Claude",
            createdAt: "2026-08-01T00:00:00.000Z",
            editable: false,
          },
        ],
      },
    };
  }

  test("an agent note opens a thread the reviewer can answer", async () => {
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([
      exportWithNote(),
      {
        operation: "note-reply",
        commentId: "c1",
        review: exportWithNote({
          comments: {
            "alpha.ts": [
              {
                id: "c1",
                body: "makes sense",
                noteKey: "note-key-1",
                createdAt: "2026-08-01T00:01:00.000Z",
                updatedAt: "2026-08-01T00:01:00.000Z",
                side: "new",
                line: 1,
                originalLine: 1,
                status: "active",
                outdated: false,
              },
            ],
          },
        }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const thread = api.__getActiveReviewForTests()?.comments.threads[0];
    assert.ok(thread, "expected a rendered note thread");
    // The defect: an agent explaining itself is half a conversation, and the reviewer had
    // nowhere to say the other half.
    assert.equal(thread.canReply, true);

    await captureMessages(() =>
      Promise.resolve(
        vscode.commands.executeCommand("hunkReview.addComment", { thread, text: "makes sense" }),
      ),
    );

    const replyCall = calls.find((call) => call.args.includes("note"));
    assert.ok(replyCall, `expected a note reply call, got ${JSON.stringify(calls)}`);
    assert.deepEqual(replyCall.args.slice(0, 3), ["review", "note", "reply"]);
    const noteAt = replyCall.args.indexOf("--note");
    assert.deepEqual(replyCall.args.slice(noteAt, noteAt + 2), ["--note", "ai:repo:0:alpha.ts:0"]);
    assert.equal(replyCall.input, "makes sense");

    // The answer joins the note's thread rather than standing beside it as a rival comment.
    const threads = api.__getActiveReviewForTests()?.comments.threads ?? [];
    assert.equal(threads.length, 1);
    assert.deepEqual(
      threads[0]?.comments.map((comment) => (comment as { contextValue?: string }).contextValue),
      ["note-active", "root-active"],
    );
  });

  test("a note is marked resolved without having to say anything first", async () => {
    const api = await extensionApi();
    const { runner, calls } = scriptRunner([
      exportWithNote(),
      {
        operation: "note-status",
        review: exportWithNote({
          comments: {
            "alpha.ts": [
              {
                id: "c1",
                // Empty: the reviewer marked the note dealt with, they did not write a reply.
                body: "",
                noteKey: "note-key-1",
                createdAt: "2026-08-01T00:01:00.000Z",
                updatedAt: "2026-08-01T00:01:00.000Z",
                side: "new",
                line: 1,
                originalLine: 1,
                status: "resolved",
                outdated: false,
              },
            ],
          },
        }),
      },
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");
    const note = api.__getActiveReviewForTests()?.comments.threads[0]?.comments[0];
    assert.equal((note as { contextValue?: string })?.contextValue, "note-active");

    await captureMessages(() =>
      Promise.resolve(vscode.commands.executeCommand("hunkReview.resolveComment", note)),
    );

    const statusCall = calls.find((call) => call.args.includes("status"));
    assert.ok(statusCall, `expected a note status call, got ${JSON.stringify(calls)}`);
    assert.deepEqual(statusCall.args.slice(0, 3), ["review", "note", "status"]);

    const threads = api.__getActiveReviewForTests()?.comments.threads ?? [];
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.state, vscode.CommentThreadState.Resolved);
    // An acknowledgement is a state, not a message: nothing empty is drawn for it.
    assert.deepEqual(
      threads[0]?.comments.map((comment) => (comment as { contextValue?: string }).contextValue),
      ["note-resolved"],
    );
  });

  test("an answer whose note the agent rewrote stays visible as a comment", async () => {
    const api = await extensionApi();
    const { runner } = scriptRunner([
      // The note now keys differently: its text changed, so the old answer no longer pairs.
      exportWithNote({
        comments: {
          "alpha.ts": [
            {
              id: "c1",
              body: "makes sense",
              noteKey: "note-key-since-rewritten",
              createdAt: "2026-08-01T00:01:00.000Z",
              updatedAt: "2026-08-01T00:01:00.000Z",
              side: "new",
              line: 1,
              originalLine: 1,
              status: "active",
              outdated: false,
            },
          ],
        },
      }),
    ]);
    api.__setHunkRunnerForTests(runner);

    await vscode.commands.executeCommand("hunkReview.openReview");

    // Two threads: the note with nothing said about it yet, and the orphaned answer still
    // standing on its own anchor. Losing the reviewer's words because the agent edited its
    // note would be the store quietly dropping authored content.
    const threads = api.__getActiveReviewForTests()?.comments.threads ?? [];
    assert.equal(threads.length, 2);
    assert.deepEqual(
      threads.map((thread) => (thread.comments[0] as { contextValue?: string }).contextValue),
      ["note-active", "root-active"],
    );
  });
});
