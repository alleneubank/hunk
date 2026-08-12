import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { ReviewSummaryView, summaryDocument } from "../reviewSummaryView";

/** Just the body, so assertions are about content rather than the surrounding document. */
function bodyOf(summary: string): string {
  return summaryDocument(summary)
    .replace(/^[\s\S]*<body>/, "")
    .replace(/<\/body>[\s\S]*$/, "");
}

suite("changeset summary rendering", () => {
  test("renders code spans instead of showing their backticks", () => {
    // The defect this view exists for: the plain-text container showed the markdown source,
    // so every identifier in the one piece of prose in the panel arrived wearing backticks.
    assert.equal(
      bodyOf("A headless `hunk review` command group."),
      "<p>A headless <code>hunk review</code> command group.</p>",
    );
  });

  test("keeps an identifier's underscores out of emphasis", () => {
    // `_` is emphasis in markdown and part of the name in code. Code spans are resolved
    // first precisely so `snake_case` does not come back italicised.
    assert.equal(
      bodyOf("Reads `REVIEW_STATE_FILENAME` first."),
      "<p>Reads <code>REVIEW_STATE_FILENAME</code> first.</p>",
    );
  });

  test("renders bold and emphasis outside code", () => {
    assert.equal(bodyOf("**Never** do _that_."), "<p><strong>Never</strong> do <em>that</em>.</p>");
  });

  test("splits blank-line-separated paragraphs and joins wrapped lines", () => {
    assert.equal(bodyOf("One line\nwrapped.\n\nSecond."), "<p>One line wrapped.</p><p>Second.</p>");
  });

  test("shows repository text as text, never as markup", () => {
    // A summary is content from the repository. It reaches an editor surface, so it is
    // escaped before anything else looks at it.
    assert.equal(
      bodyOf("Compare <script>alert(1)</script> & co."),
      "<p>Compare &lt;script&gt;alert(1)&lt;/script&gt; &amp; co.</p>",
    );
  });

  test("renders web links and leaves every other scheme as plain text", () => {
    assert.match(
      bodyOf("See [docs](https://example.com/x)."),
      /<a href="https:\/\/example\.com\/x">docs<\/a>/,
    );
    // A `javascript:` target in repository text is not a link this panel will render.
    assert.equal(bodyOf("See [x](javascript:alert(1))."), "<p>See [x](javascript:alert(1)).</p>");
  });

  test("forbids scripts in the document it emits", () => {
    const document = summaryDocument("Anything at all.");

    assert.match(document, /default-src 'none'/);
    assert.equal(/<script/i.test(document), false);
  });

  test("dresses itself in the user's theme rather than its own palette", () => {
    assert.match(summaryDocument("x"), /var\(--vscode-foreground\)/);
  });

  test("emits nothing for a summary that is only whitespace", () => {
    assert.equal(bodyOf("   \n\n  "), "");
  });
});

/** The parts of a `WebviewView` this provider touches, and nothing else. */
function fakeWebviewView() {
  const webview = { options: {}, html: "" };
  return { webview } as unknown as vscode.WebviewView & { webview: { html: string } };
}

suite("summary panel lifecycle", () => {
  test("holds a summary that arrives before the view exists", () => {
    // The order VS Code actually uses: the view is contributed `when: hunkReview.hasSummary`,
    // so it is not resolved until after a summary has been announced. A provider that only
    // remembered summaries arriving after resolution would render an empty panel forever.
    const provider = new ReviewSummaryView();
    provider.setSummary("Adds `hunk review focus`.");

    const view = fakeWebviewView();
    provider.resolveWebviewView(view);

    assert.match(view.webview.html, /<code>hunk review focus<\/code>/);
  });

  test("renders a later summary into an already-resolved view", () => {
    const provider = new ReviewSummaryView();
    const view = fakeWebviewView();
    provider.resolveWebviewView(view);

    provider.setSummary("Second changeset.");

    assert.match(view.webview.html, /Second changeset\./);
  });

  test("empties the panel when a review carries no summary", () => {
    const provider = new ReviewSummaryView();
    const view = fakeWebviewView();
    provider.resolveWebviewView(view);
    provider.setSummary("Something.");

    provider.setSummary(undefined);

    assert.equal(view.webview.html, "");
  });

  test("never lets a summary run scripts in the editor", () => {
    const provider = new ReviewSummaryView();
    const view = fakeWebviewView();
    provider.resolveWebviewView(view);
    provider.setSummary("x");

    assert.equal(
      (view.webview as unknown as { options: { enableScripts?: boolean } }).options.enableScripts,
      false,
    );
  });
});
