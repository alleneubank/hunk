import * as assert from "node:assert/strict";
import { HunkReviewError, parseReviewExport, readReviewPayload } from "../reviewExport";

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exportVersion: 1,
    reviewCommentsVersion: 1,
    repoRoot: "/repo",
    review: { title: "working tree", files: [], reviewNotes: [] },
    viewedFilePaths: [],
    commentsAvailable: true,
    comments: {},
    ...overrides,
  };
}

suite("review export payloads", () => {
  test("normalizes a legacy payload to conservative Hunk-served sources", () => {
    const parsed = parseReviewExport(validPayload());

    assert.deepEqual(parsed.sourceCapabilities, { old: "hunk", new: "hunk" });
  });

  test("preserves explicit workspace provenance for a working-tree diff", () => {
    const parsed = parseReviewExport(
      validPayload({ sourceCapabilities: { old: "hunk", new: "workspace" } }),
    );

    assert.deepEqual(parsed.sourceCapabilities, { old: "hunk", new: "workspace" });
  });

  test("rejects malformed file data before it can reach the review UI", () => {
    assert.throws(
      () =>
        parseReviewExport(
          validPayload({
            review: {
              files: [
                {
                  id: "alpha",
                  path: "alpha.ts",
                  additions: "one",
                  deletions: 0,
                  hunkCount: 0,
                  hunks: [],
                },
              ],
            },
          }),
        ),
      (error: unknown) => error instanceof HunkReviewError && error.message.includes("malformed"),
    );
  });

  test("rejects malformed source capabilities instead of guessing a side", () => {
    assert.throws(
      () =>
        parseReviewExport(validPayload({ sourceCapabilities: { old: "workspace", new: "hunk" } })),
      (error: unknown) =>
        error instanceof HunkReviewError && error.detail?.includes("sourceCapabilities.old"),
    );
  });

  test("rejects malformed comment envelopes instead of rendering partial review state", () => {
    assert.throws(
      () =>
        readReviewPayload(
          JSON.stringify(
            validPayload({
              comments: { "alpha.ts": [{ id: "c1", body: "missing anchor" }] },
            }),
          ),
        ),
      (error: unknown) => error instanceof HunkReviewError && error.message.includes("malformed"),
    );
  });
});
