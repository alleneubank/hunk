import * as assert from "node:assert/strict";
import * as vscode from "vscode";

/**
 * Proves the extension-host harness is real before the campaign relies on it.
 *
 * The BRIEF's oracle for the VS Code surface is this runner. If these assertions can run,
 * the surface is interior-verifiable and only *feel* needs a human. Each case therefore
 * checks a capability a later unit depends on, not incidental scaffolding.
 */
suite("extension host harness", () => {
  test("the extension is installed and activates", async () => {
    const extension = vscode.extensions.getExtension("hunk.hunk-vscode");
    assert.ok(extension, "extension not found in the host");

    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test("the contributed command is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("hunkReview.openReview"));
  });

  test("the comments API is available to build review threads on", () => {
    // REQ-VSCODE-003 persists user comments created through this controller. If the host
    // did not expose it, the whole comment surface would need a different design.
    const controller = vscode.comments.createCommentController("hunk.harness", "Hunk Harness");
    try {
      assert.equal(typeof controller.createCommentThread, "function");
    } finally {
      controller.dispose();
    }
  });

  test("a real workspace folder is open, so fixture-repo tests are possible", () => {
    // Later units run export against a fixture repo opened as the workspace root.
    assert.ok(vscode.workspace.workspaceFolders?.length);
  });
});
