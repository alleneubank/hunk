import * as assert from "node:assert/strict";
import { HunkCli } from "../hunkCli";
import {
  isReviewableExpression,
  parseReviewTarget,
  targetArguments,
  targetLabel,
  WORKING_TREE_TARGET,
} from "../reviewTarget";

/** A CLI whose every invocation is recorded and answered with an empty review. */
function recordingCli(target: Parameters<typeof targetArguments>[0]) {
  const calls: string[][] = [];
  const payload = JSON.stringify({
    exportVersion: 1,
    reviewCommentsVersion: 1,
    repoRoot: "/repo",
    review: { title: "t", files: [], reviewNotes: [] },
    viewedFilePaths: [],
    commentsAvailable: true,
    comments: {},
  });

  const cli = new HunkCli({
    repoRoot: "/repo",
    target,
    run: async (_binary, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: payload, stderr: "" };
    },
  });

  return { cli, calls };
}

suite("review target", () => {
  test("selects each changeset with the arguments Hunk expects", () => {
    assert.deepEqual(targetArguments(WORKING_TREE_TARGET), []);
    assert.deepEqual(targetArguments({ kind: "staged" }), ["--staged"]);
    // Passed through, not interpreted: resolving what `main...HEAD` means is Git's job.
    assert.deepEqual(targetArguments({ kind: "range", expression: "main...HEAD" }), [
      "main...HEAD",
    ]);
  });

  test("names the changeset the reviewer is reading", () => {
    assert.equal(targetLabel(WORKING_TREE_TARGET), "working tree");
    assert.equal(targetLabel({ kind: "staged" }), "staged changes");
    assert.equal(targetLabel({ kind: "range", expression: "main...HEAD" }), "main...HEAD");
  });

  test("refuses an expression the CLI would read as a flag or as nothing", () => {
    assert.equal(isReviewableExpression("main...HEAD"), true);
    assert.equal(isReviewableExpression("  HEAD~3..HEAD "), true);
    // An empty target silently becomes the working tree, which is a different review.
    assert.equal(isReviewableExpression("   "), false);
    assert.equal(isReviewableExpression("--staged"), false);
  });

  test("names the same changeset on reads and on writes", async () => {
    const { cli, calls } = recordingCli({ kind: "range", expression: "main...HEAD" });

    await cli.export(false);
    await cli.setViewed(["alpha.ts"], true);
    await cli.addComment({ file: "alpha.ts", side: "new", line: 1, body: "hi" });

    // A write anchored against a different changeset than the one on screen would be
    // resolved against a diff the reviewer never saw.
    for (const args of calls) {
      assert.ok(args.includes("main...HEAD"), `target missing from: ${args.join(" ")}`);
    }
  });

  test("marks several files viewed in one invocation", async () => {
    const { cli, calls } = recordingCli(WORKING_TREE_TARGET);

    await cli.setViewed(["alpha.ts", "beta.ts"], true);

    assert.deepEqual(calls[0], [
      "review",
      "viewed",
      "set",
      "--file",
      "alpha.ts",
      "--file",
      "beta.ts",
      "--viewed",
      "--json",
      "--repo",
      "/repo",
    ]);
  });

  test("falls back to the working tree for remembered state it does not recognize", () => {
    assert.deepEqual(parseReviewTarget({ kind: "range", expression: "main...HEAD" }), {
      kind: "range",
      expression: "main...HEAD",
    });
    assert.deepEqual(parseReviewTarget({ kind: "staged" }), { kind: "staged" });

    // Workspace state outlives the version that wrote it, so an unusable shape must not
    // reach the CLI as a target.
    assert.deepEqual(parseReviewTarget(undefined), WORKING_TREE_TARGET);
    assert.deepEqual(parseReviewTarget({ kind: "range" }), WORKING_TREE_TARGET);
    assert.deepEqual(parseReviewTarget({ kind: "range", expression: "-x" }), WORKING_TREE_TARGET);
    assert.deepEqual(parseReviewTarget("main...HEAD"), WORKING_TREE_TARGET);
  });
});
