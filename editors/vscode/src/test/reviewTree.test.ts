import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  createTestComment as exportedComment,
  createTestFile as exportedFile,
  createTestNote as exportedNote,
  createTestSession as sessionOver,
} from "./helpers/reviewFixtures";
import {
  reviewedPathsOf,
  ReviewDirectoryItem,
  ReviewFileItem,
  ReviewTreeProvider,
} from "../reviewTree";

/** The rows one node shows, as `label · description` pairs. */
function rowsOf(provider: ReviewTreeProvider, element?: ReviewDirectoryItem) {
  return provider.getChildren(element).map((item) => `${String(item.label)} ${item.description}`);
}

suite("review sidebar arrangement", () => {
  test("lists files in the review's own order by default", () => {
    // The sidecar's order is authored, so list mode must not sort or group it.
    const provider = new ReviewTreeProvider(
      sessionOver(["src/core/zeta.ts", "README.md", "src/core/alpha.ts"]),
    );

    assert.equal(provider.viewMode, "list");
    assert.deepEqual(
      provider.getChildren().map((item) => String(item.label)),
      ["src/core/zeta.ts", "README.md", "src/core/alpha.ts"],
    );
  });

  test("groups files by directory in tree mode, directories first", () => {
    const provider = new ReviewTreeProvider(
      sessionOver(["README.md", "src/core/alpha.ts", "src/core/beta.ts"]),
    );
    provider.setViewMode("tree");

    const roots = provider.getChildren();
    assert.deepEqual(
      roots.map((item) => String(item.label)),
      ["src/core", "README.md"],
    );

    const [directory] = roots;
    assert.ok(directory instanceof ReviewDirectoryItem);
    assert.deepEqual(
      provider.getChildren(directory).map((item) => String(item.label)),
      ["alpha.ts", "beta.ts"],
    );
  });

  test("collapses a chain of single-child directories into one row", () => {
    // Otherwise a deep, narrow path costs a row of nothing per level before the file shows.
    const provider = new ReviewTreeProvider(sessionOver(["src/ui/hooks/useThing.ts"]));
    provider.setViewMode("tree");

    assert.deepEqual(
      provider.getChildren().map((item) => String(item.label)),
      ["src/ui/hooks"],
    );
  });

  test("stops collapsing where a directory holds more than one thing", () => {
    const provider = new ReviewTreeProvider(
      sessionOver(["src/ui/hooks/useThing.ts", "src/ui/App.tsx"]),
    );
    provider.setViewMode("tree");

    const roots = provider.getChildren();
    assert.deepEqual(
      roots.map((item) => String(item.label)),
      ["src/ui"],
    );

    const [directory] = roots;
    assert.ok(directory instanceof ReviewDirectoryItem);
    assert.deepEqual(
      provider.getChildren(directory).map((item) => String(item.label)),
      ["hooks", "App.tsx"],
    );
  });

  test("sums the change a directory contains", () => {
    const provider = new ReviewTreeProvider(sessionOver(["src/a.ts", "src/nested/b.ts"]));
    provider.setViewMode("tree");

    assert.deepEqual(rowsOf(provider), ["src +2 −0"]);
  });

  test("keeps a file's viewed state and identity in both arrangements", () => {
    const provider = new ReviewTreeProvider(
      sessionOver(["src/core/alpha.ts"], ["src/core/alpha.ts"]),
    );

    const [listed] = provider.getChildren();
    assert.ok(listed instanceof ReviewFileItem);
    assert.equal(listed.contextValue, "hunkFile.viewed");

    provider.setViewMode("tree");
    const [directory] = provider.getChildren();
    assert.ok(directory instanceof ReviewDirectoryItem);
    const [nested] = provider.getChildren(directory);
    assert.ok(nested instanceof ReviewFileItem);
    // Same file, same identity — only the label shortens.
    assert.equal(nested.id, listed.id);
    assert.equal(nested.contextValue, "hunkFile.viewed");
    assert.equal(String(nested.label), "alpha.ts");
  });

  test("carries the agent's account of the change whole, not as a clipped row", () => {
    // A tree row is one line with no wrapping, which turned a paragraph into
    // "Adds a durable local review contract and the VS Code client that con…". The full
    // text goes to the view's message area, which wraps.
    const summary = "Raises alpha.\n\nAnd explains why at length.";
    const provider = new ReviewTreeProvider(
      sessionOver(["src/a.ts"], [], { agentSummary: summary }),
    );

    assert.equal(provider.summaryMessage, summary);
    // Every row is a file. The summary never costs one.
    assert.ok(provider.getChildren()[0] instanceof ReviewFileItem);

    provider.setViewMode("tree");
    assert.equal(provider.summaryMessage, summary);
  });

  test("says nothing for a review that carries no summary", () => {
    const provider = new ReviewTreeProvider(sessionOver(["src/a.ts"]));

    assert.equal(provider.summaryMessage, undefined);
    assert.ok(provider.getChildren()[0] instanceof ReviewFileItem);
  });

  test("dresses each row in the workspace's own file icon", () => {
    // Not a per-row diff glyph: a column of identical marks carries no information, and the
    // reviewer already reads this repo by the icon theme everywhere else.
    const provider = new ReviewTreeProvider(sessionOver(["src/a.ts"]));

    const [item] = provider.getChildren();
    assert.ok(item instanceof ReviewFileItem);
    assert.equal(item.iconPath, vscode.ThemeIcon.File);
    // The icon theme resolves against the resource path, so it has to keep the extension.
    assert.match(String(item.resourceUri?.path), /\.ts$/);
  });

  test("carries a file's own summary as its tooltip", () => {
    const provider = new ReviewTreeProvider(
      sessionOver([], [], {
        files: [{ ...exportedFile("src/a.ts"), agentSummary: "Only the constant moves." }],
      }),
    );

    const [item] = provider.getChildren();
    assert.ok(item instanceof ReviewFileItem);
    assert.match(String((item.tooltip as { value?: string }).value), /Only the constant moves\./);
  });

  test("reports progress from the review, not from the rows it happens to show", () => {
    const provider = new ReviewTreeProvider(sessionOver(["a.ts", "src/b.ts"], ["a.ts"]));
    provider.setViewMode("tree");

    assert.equal(provider.progressLabel, "Hunk Review — 1/2 viewed");
  });
});

suite("a sidebar with nothing to show", () => {
  test("says nothing at all rather than a summary describing an absent change", () => {
    // A changeset summary standing alone is a sentence about files that are not on screen.
    // Returning no rows is what lets VS Code's welcome content explain the emptiness instead.
    const provider = new ReviewTreeProvider(
      sessionOver([], [], { agentSummary: "Adds a durable local review contract." }),
    );

    assert.deepEqual(provider.getChildren(), []);
    assert.equal(provider.emptyReason, "no-changes");
  });

  test("distinguishes a target with no changes from a filter that hid everything", () => {
    const provider = new ReviewTreeProvider(sessionOver(["a.ts"], ["a.ts"]));

    assert.equal(provider.emptyReason, undefined);

    provider.setFilter("unviewed");
    assert.deepEqual(provider.getChildren(), []);
    // The distinction is the whole point: one is fixed by picking another target, the
    // other by clearing the filter, and telling the reviewer the wrong one wastes a trip.
    assert.equal(provider.emptyReason, "filtered");
  });

  test("reports no emptiness at all before a review is open", () => {
    // That state has its own welcome content; claiming "no changes" would be a lie about
    // a review that was never run.
    assert.equal(new ReviewTreeProvider(null).emptyReason, undefined);
  });

  test("shows the summary again as soon as there is something for it to describe", () => {
    const summary = "Adds a durable local review contract.";
    const provider = new ReviewTreeProvider(sessionOver(["a.ts"], [], { agentSummary: summary }));

    assert.equal(provider.emptyReason, undefined);
    assert.equal(provider.summaryMessage, summary);
    assert.ok(provider.getChildren()[0] instanceof ReviewFileItem);
  });
});

suite("rows as review targets", () => {
  test("a directory row stands for every file beneath it, however deep", () => {
    const provider = new ReviewTreeProvider(
      sessionOver(["src/a.ts", "src/ui/panes/b.tsx", "docs/c.md"]),
    );
    provider.setViewMode("tree");

    const [source] = provider.getChildren();
    assert.ok(source instanceof ReviewDirectoryItem);
    // Sorted only for the assertion: the walk keeps review order, which is not alphabetical.
    assert.deepEqual(reviewedPathsOf(source).sort(), ["src/a.ts", "src/ui/panes/b.tsx"]);
  });

  test("a file row stands for itself, and anything else for nothing", () => {
    const provider = new ReviewTreeProvider(
      sessionOver(["a.ts"], [], { agentSummary: "Raises alpha." }),
    );

    // Guards the bulk-marking path against a row type that carries no files: it must
    // resolve to an empty set rather than throw or claim the whole review.
    assert.deepEqual(reviewedPathsOf({ label: "not a review row" }), []);
    const [file] = provider.getChildren();
    assert.ok(file instanceof ReviewFileItem);
    assert.deepEqual(reviewedPathsOf(file), ["a.ts"]);
  });
});

suite("review sidebar filtering", () => {
  test("shows every file until a filter is chosen", () => {
    const provider = new ReviewTreeProvider(sessionOver(["a.ts", "b.ts"], ["a.ts"]));

    assert.equal(provider.activeFilter, "all");
    assert.equal(provider.filterLabel, undefined);
    assert.equal(provider.visibleFiles().length, 2);
  });

  test("keeps only the files still to review", () => {
    const provider = new ReviewTreeProvider(sessionOver(["a.ts", "b.ts", "c.ts"], ["b.ts"]));
    provider.setFilter("unviewed");

    assert.deepEqual(
      provider.visibleFiles().map((state) => state.file.path),
      ["a.ts", "c.ts"],
    );
  });

  test("keeps only the files carrying an unresolved comment", () => {
    // A resolved comment is finished business: it must not hold a file in the filter.
    const provider = new ReviewTreeProvider(
      sessionOver(["a.ts", "b.ts", "c.ts"], [], {
        comments: {
          "a.ts": [exportedComment()],
          "b.ts": [exportedComment({ id: "c2", status: "resolved" })],
        },
      }),
    );
    provider.setFilter("commented");

    assert.deepEqual(
      provider.visibleFiles().map((state) => state.file.path),
      ["a.ts"],
    );
  });

  test("keeps only the files an agent left notes on", () => {
    const provider = new ReviewTreeProvider(
      sessionOver(["a.ts", "b.ts"], [], { notes: [exportedNote("b.ts")] }),
    );
    provider.setFilter("annotated");

    assert.deepEqual(
      provider.visibleFiles().map((state) => state.file.path),
      ["b.ts"],
    );
  });

  test("says which filter is on, so hidden files are never silent", () => {
    const provider = new ReviewTreeProvider(sessionOver(["a.ts"]));

    provider.setFilter("unviewed");
    assert.equal(provider.filterLabel, "unviewed only");
    provider.setFilter("commented");
    assert.equal(provider.filterLabel, "with comments");
    provider.setFilter("annotated");
    assert.equal(provider.filterLabel, "with agent notes");
    provider.setFilter("all");
    assert.equal(provider.filterLabel, undefined);
  });

  test("filters the tree arrangement too, dropping the directories left empty", () => {
    const provider = new ReviewTreeProvider(sessionOver(["src/a.ts", "docs/b.md"], ["docs/b.md"]));
    provider.setViewMode("tree");
    provider.setFilter("unviewed");

    assert.deepEqual(
      provider.getChildren().map((item) => String(item.label)),
      ["src"],
    );
  });

  test("measures progress against the whole review while a filter hides rows", () => {
    // Progress that moved because a filter changed would be measuring the sidebar.
    const provider = new ReviewTreeProvider(sessionOver(["a.ts", "b.ts"], ["a.ts"]));
    provider.setFilter("unviewed");

    assert.equal(provider.visibleFiles().length, 1);
    assert.equal(provider.progressLabel, "Hunk Review — 1/2 viewed");
  });
});
