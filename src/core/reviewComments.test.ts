import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReviewCommentReply,
  readReviewComments,
  REVIEW_COMMENTS_VERSION,
} from "./reviewComments";
import { readViewedState, mutateViewedState } from "./viewedState";

/** Create an isolated `.hunk`-shaped directory for one case. */
function createStoreDir() {
  return mkdtempSync(join(tmpdir(), "hunk-review-comments-"));
}

function writeRaw(dir: string, contents: string) {
  const filePath = join(dir, "review-comments.json");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

const validComment = {
  id: "c1",
  anchor: {
    side: "new",
    line: 42,
    originalLine: 42,
    lineTextHash: "a".repeat(64),
    contextBefore: ["const before = 1;"],
    contextAfter: ["const after = 2;"],
    hunkHeader: "@@ -10,6 +12,8 @@",
  },
  body: "Tighten this wording",
  author: "allen",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  status: "active",
};

describe("review comment store", () => {
  test("an absent file reads as empty, which is not a failure", () => {
    const dir = createStoreDir();

    const result = readReviewComments(join(dir, "review-comments.json"));

    expect(result.kind).toBe("absent");
    if (result.kind !== "absent") {
      throw new Error("expected absent");
    }
    expect(result.store).toEqual({ version: REVIEW_COMMENTS_VERSION, files: {} });
  });

  test("a valid file reads back its comments", () => {
    const dir = createStoreDir();
    const filePath = writeRaw(
      dir,
      JSON.stringify({
        version: REVIEW_COMMENTS_VERSION,
        files: { "src/App.tsx": [validComment] },
      }),
    );

    const result = readReviewComments(filePath);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.store.files["src/App.tsx"]).toHaveLength(1);
    expect(result.store.files["src/App.tsx"]?.[0]?.body).toBe("Tighten this wording");
  });

  // The whole point of the separate store: authored content is never silently dropped the
  // way `readViewedState` drops derived viewed state. Each unreadable shape must report
  // unavailable AND leave the bytes untouched so a later writer cannot clobber them.
  const preservedCases: Array<{ name: string; contents: string }> = [
    { name: "malformed JSON", contents: "{ this is not json" },
    { name: "truncated JSON", contents: '{"version":1,"files":{"a.ts":[' },
    { name: "valid JSON of the wrong shape", contents: JSON.stringify({ nope: true }) },
    { name: "a JSON array rather than a record", contents: JSON.stringify([validComment]) },
    {
      name: "a comment missing its anchor",
      contents: JSON.stringify({
        version: REVIEW_COMMENTS_VERSION,
        files: { "a.ts": [{ ...validComment, anchor: undefined }] },
      }),
    },
    {
      name: "a future version",
      contents: JSON.stringify({ version: REVIEW_COMMENTS_VERSION + 1, files: {} }),
    },
  ];

  for (const { name, contents } of preservedCases) {
    test(`${name} reports unavailable and leaves the file byte-intact`, () => {
      const dir = createStoreDir();
      const filePath = writeRaw(dir, contents);

      const result = readReviewComments(filePath);

      expect(result.kind).toBe("unavailable");
      expect(readFileSync(filePath, "utf8")).toBe(contents);
    });
  }

  test("an unreadable file reports unavailable rather than empty", () => {
    if (process.platform === "win32") {
      // POSIX permission bits do not deny reads to the owner on Windows.
      return;
    }

    const dir = createStoreDir();
    const filePath = writeRaw(dir, JSON.stringify({ version: REVIEW_COMMENTS_VERSION, files: {} }));
    chmodSync(filePath, 0o000);

    try {
      expect(readReviewComments(filePath).kind).toBe("unavailable");
    } finally {
      chmodSync(filePath, 0o600);
    }
  });

  test("viewed state and comments are independent stores", () => {
    const dir = createStoreDir();
    const commentsPath = writeRaw(
      dir,
      JSON.stringify({ version: REVIEW_COMMENTS_VERSION, files: { "a.ts": [validComment] } }),
    );
    const commentsBefore = readFileSync(commentsPath, "utf8");
    const viewedPath = join(dir, "review-state.json");

    // A full viewed-state round trip, exactly as the TUI performs it today.
    mutateViewedState(viewedPath, () => ({
      version: 1,
      files: { "a.ts": { patchHash: "b".repeat(64), viewedAt: "2026-08-01T00:00:00.000Z" } },
    }));
    expect(readViewedState(viewedPath).files["a.ts"]?.patchHash).toBe("b".repeat(64));

    // Comments survive untouched: an older binary that only knows viewed state cannot
    // destroy authored content (REQ-REVIEW-010).
    expect(readFileSync(commentsPath, "utf8")).toBe(commentsBefore);
    expect(readReviewComments(commentsPath).kind).toBe("ok");
  });

  test("a corrupt viewed store still resets to empty, unlike comments", () => {
    const dir = createStoreDir();
    const viewedPath = join(dir, "review-state.json");
    writeFileSync(viewedPath, JSON.stringify({ version: 1, files: { "a.ts": { nope: true } } }));

    // Derived state keeps its tolerant-reset policy; only the comment store is strict.
    expect(readViewedState(viewedPath)).toEqual({ version: 1, files: {} });
  });
});

const validReply = {
  id: "r1",
  parentId: "c1",
  body: "Because the timeout is in seconds.",
  author: "allen",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

describe("review comment replies", () => {
  test("a reply reads back alongside the comment it answers", () => {
    const dir = createStoreDir();
    const filePath = writeRaw(
      dir,
      JSON.stringify({
        version: REVIEW_COMMENTS_VERSION,
        files: { "src/App.tsx": [validComment, validReply] },
      }),
    );

    const result = readReviewComments(filePath);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    const stored = result.store.files["src/App.tsx"] ?? [];
    expect(stored).toHaveLength(2);
    expect(stored.filter(isReviewCommentReply).map((entry) => entry.parentId)).toEqual(["c1"]);
  });

  // A reply is positioned and resolved by the comment it answers, so carrying its own anchor
  // or status is state that can disagree with its parent. The two shapes are exclusive on
  // disk, which is what keeps a thread structurally unable to split.
  const rejectedShapes: Array<{ name: string; entry: Record<string, unknown> }> = [
    {
      name: "a reply carrying its own anchor",
      entry: { ...validReply, anchor: validComment.anchor },
    },
    { name: "a reply carrying its own status", entry: { ...validReply, status: "active" } },
    { name: "a reply with an empty parent id", entry: { ...validReply, parentId: "" } },
    { name: "a root comment claiming a parent", entry: { ...validComment, parentId: "c0" } },
  ];

  for (const { name, entry } of rejectedShapes) {
    test(`${name} reports unavailable and leaves the file byte-intact`, () => {
      const dir = createStoreDir();
      const contents = JSON.stringify({
        version: REVIEW_COMMENTS_VERSION,
        files: { "a.ts": [entry] },
      });
      const filePath = writeRaw(dir, contents);

      const result = readReviewComments(filePath);

      expect(result.kind).toBe("unavailable");
      expect(readFileSync(filePath, "utf8")).toBe(contents);
    });
  }
});
