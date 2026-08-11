import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  decoratedUri,
  REVIEW_DECORATION_SCHEME,
  ReviewDecorationProvider,
} from "../reviewDecorations";
import {
  createTestComment as exportedComment,
  createTestSession as sessionOver,
} from "./helpers/reviewFixtures";

/** A provider already holding one review. */
function providerOver(...args: Parameters<typeof sessionOver>): ReviewDecorationProvider {
  const provider = new ReviewDecorationProvider();
  provider.setSession(sessionOver(...args));

  return provider;
}

suite("review file decorations", () => {
  test("badges a file whose review is done", () => {
    const provider = providerOver(["a.ts", "b.ts"], ["a.ts"]);

    assert.equal(provider.provideFileDecoration(decoratedUri("a.ts"))?.badge, "✓");
  });

  test("leaves an untouched file undecorated", () => {
    // No badge at all, rather than an empty one: unreviewed is the resting state.
    const provider = providerOver(["a.ts"]);

    assert.equal(provider.provideFileDecoration(decoratedUri("a.ts")), undefined);
  });

  test("counts unresolved comments, and lets them outrank the viewed mark", () => {
    // A file marked done that still holds an unanswered comment is the one a reviewer must
    // not lose track of, so the count wins the single badge slot.
    const provider = providerOver(["a.ts"], ["a.ts"], {
      comments: {
        "a.ts": [
          exportedComment(),
          exportedComment({ id: "c2" }),
          exportedComment({ id: "c3", status: "resolved" }),
        ],
      },
    });

    const decoration = provider.provideFileDecoration(decoratedUri("a.ts"));
    assert.equal(decoration?.badge, "2");
    assert.equal(decoration?.tooltip, "2 unresolved comments");
  });

  test("keeps the badge to the two characters VS Code renders", () => {
    const comments = Array.from({ length: 120 }, (_, index) =>
      exportedComment({ id: `c${index}` }),
    );
    const provider = providerOver(["a.ts"], [], { comments: { "a.ts": comments } });

    assert.equal(provider.provideFileDecoration(decoratedUri("a.ts"))?.badge, "99");
  });

  test("decorates only the review's own rows", () => {
    // Never the workspace file: Hunk's badge would then sit on the explorer entry and the
    // editor tab beside Git's own decoration for the same file, saying something different.
    const provider = providerOver(["a.ts"], ["a.ts"]);

    assert.equal(provider.provideFileDecoration(vscode.Uri.file("/repo/a.ts")), undefined);
    assert.equal(decoratedUri("a.ts").scheme, REVIEW_DECORATION_SCHEME);
  });

  test("decorates nothing at all once the review closes", () => {
    const provider = providerOver(["a.ts"], ["a.ts"]);
    provider.setSession(null);

    assert.equal(provider.provideFileDecoration(decoratedUri("a.ts")), undefined);
  });

  test("ignores a path that is not in the review", () => {
    const provider = providerOver(["a.ts"]);

    assert.equal(provider.provideFileDecoration(decoratedUri("elsewhere.ts")), undefined);
  });
});
