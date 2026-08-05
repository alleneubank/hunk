import * as assert from "node:assert/strict";
import { isReviewFocusPayload, sameReviewTarget } from "../reviewFocus";

/** A payload Hunk would actually emit, with one field overridden per case. */
function focusPayload(overrides: Record<string, unknown> = {}): unknown {
  return { target: { kind: "staged" }, revision: 1, ...overrides };
}

suite("agent focus payloads", () => {
  test("accepts the three targets Hunk can record", () => {
    for (const target of [
      { kind: "working-tree" },
      { kind: "staged" },
      { kind: "range", expression: "main...HEAD" },
    ]) {
      assert.ok(isReviewFocusPayload(focusPayload({ target })));
    }
  });

  test("accepts a file with a side and a line", () => {
    assert.ok(isReviewFocusPayload(focusPayload({ file: "src/a.ts", side: "old", line: 12 })));
  });

  test("refuses a line that names no file", () => {
    // There is nowhere to put the cursor. Half-applying the instruction would move the
    // reviewer somewhere nobody asked for, which is worse than ignoring it.
    assert.equal(isReviewFocusPayload(focusPayload({ line: 12 })), false);
  });

  test("refuses lines that are not positive 1-based integers", () => {
    for (const line of [0, -3, 1.5, "12"]) {
      assert.equal(isReviewFocusPayload(focusPayload({ file: "a.ts", line })), false);
    }
  });

  test("refuses a target it does not recognize, and a range with no expression", () => {
    assert.equal(isReviewFocusPayload(focusPayload({ target: { kind: "elsewhere" } })), false);
    assert.equal(isReviewFocusPayload(focusPayload({ target: { kind: "range" } })), false);
    assert.equal(isReviewFocusPayload(focusPayload({ target: undefined })), false);
  });

  test("refuses a payload with no revision, which is what makes a repeat land", () => {
    assert.equal(isReviewFocusPayload({ target: { kind: "staged" } }), false);
  });

  test("refuses anything that is not an object at all", () => {
    for (const value of [null, undefined, 4, "focus", []]) {
      assert.equal(isReviewFocusPayload(value), false);
    }
  });
});

suite("recognizing the same changeset", () => {
  test("matches a target against itself without reopening the review", () => {
    assert.ok(sameReviewTarget({ kind: "working-tree" }, { kind: "working-tree" }));
    assert.ok(
      sameReviewTarget(
        { kind: "range", expression: "main...HEAD" },
        { kind: "range", expression: "main...HEAD" },
      ),
    );
  });

  test("separates targets that name different changesets", () => {
    assert.equal(sameReviewTarget({ kind: "staged" }, { kind: "working-tree" }), false);
    assert.equal(
      sameReviewTarget(
        { kind: "range", expression: "main...HEAD" },
        { kind: "range", expression: "dev...HEAD" },
      ),
      false,
    );
  });
});
