import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { buildReviewExport, REVIEW_EXPORT_VERSION } from "./reviewExport";
import { captureReviewCommentAnchor } from "../core/reviewCommentAnchor";
import {
  addReviewComment,
  REVIEW_COMMENTS_VERSION,
  type ReviewComment,
} from "../core/reviewComments";
import { hashPatch } from "../core/viewedState";
import { HUNK_DIR_NAME, REVIEW_COMMENTS_FILENAME, REVIEW_STATE_FILENAME } from "../core/run/paths";
import { buildHunkSessionReview } from "../session/broker/projections";
import { createInitialSessionSnapshot, createSessionRegistration } from "./session/registration";
import { buildReviewPublication } from "./review/publication";
import { buildSidecarReviewNotes } from "./session/reviewNotes";

function sessionEntry(bootstrap: Parameters<typeof createSessionRegistration>[0]) {
  const publication = buildReviewPublication({
    files: bootstrap.changeset.files,
    generation: "headless",
    sourceLabel: bootstrap.changeset.sourceLabel,
  });
  const snapshot = createInitialSessionSnapshot(bootstrap, publication);
  const sidecarNotes = buildSidecarReviewNotes(bootstrap.changeset.files);
  snapshot.state.reviewNotes = sidecarNotes;
  snapshot.state.reviewNoteCount = sidecarNotes.length;
  return {
    registration: createSessionRegistration(bootstrap, publication),
    snapshot,
  };
}

function createRepoRoot() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-review-export-"));
  mkdirSync(join(dir, HUNK_DIR_NAME), { recursive: true });
  return dir;
}

/** A real unified patch for the fixture's default before/after contents. */
const ALPHA_PATCH = [
  "@@ -1,4 +1,4 @@",
  "-const alpha = 1;",
  "+const alpha = 10;",
  " const beta = 2;",
  "-const gamma = 3;",
  "+const gamma = 30;",
  " const stable = true;",
].join("\n");

function bootstrapWith(repoRoot: string) {
  // The shared fixture leaves `patch` empty; anchoring and viewed-state hashing both read it,
  // so this suite supplies the real patch text those paths would see in a live review.
  const file = { ...createTestDiffFile({ id: "alpha", path: "alpha.ts" }), patch: ALPHA_PATCH };
  return {
    bootstrap: createTestVcsAppBootstrap({ files: [file], sourceLabel: repoRoot }),
    file,
  };
}

describe("review export", () => {
  test("carries its own version, independent of the daemon protocol version", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap } = bootstrapWith(repoRoot);

    const exported = buildReviewExport(bootstrap, { repoRoot });

    expect(exported.exportVersion).toBe(REVIEW_EXPORT_VERSION);
    expect(exported.reviewCommentsVersion).toBe(REVIEW_COMMENTS_VERSION);
    expect(exported.agentContextPath).toMatch(
      new RegExp(
        `${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.hunk/agent-context\\.[0-9a-f]{12}\\.json$`,
      ),
    );
  });

  // The single-contract floor: export must not grow a second opinion about file identity,
  // ordering, or hunk ranges.
  test("file identity, order, and hunk ranges match the session projection exactly", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap } = bootstrapWith(repoRoot);

    const exported = buildReviewExport(bootstrap, { repoRoot });
    const viaSession = buildHunkSessionReview(sessionEntry(bootstrap));

    expect(exported.review.files.map((file) => [file.id, file.path, file.hunkCount])).toEqual(
      viaSession.files.map((file) => [file.id, file.path, file.hunkCount]),
    );
    expect(exported.review.files.map((file) => file.hunks)).toEqual(
      viaSession.files.map((file) => file.hunks),
    );
  });

  // Without this, a headless client sees a changeset with no agent rationale at all, even
  // though the sidecar loaded — the notes only ever existed inside the running TUI.
  test("carries sidecar agent notes, matching what the live session reports", () => {
    const repoRoot = createRepoRoot();
    const file = {
      ...createTestDiffFile({ id: "alpha", path: "alpha.ts", agent: true }),
      patch: ALPHA_PATCH,
    };
    const bootstrap = createTestVcsAppBootstrap({ files: [file], sourceLabel: repoRoot });

    const exported = buildReviewExport(bootstrap, { repoRoot });
    const notes = exported.review.reviewNotes ?? [];

    expect(notes).toHaveLength(1);
    expect(notes[0]?.filePath).toBe("alpha.ts");
    expect(notes[0]?.body).toContain("Why alpha.ts changed");
    expect(notes[0]?.editable).toBe(false);
    expect(exported.review.reviewNoteCount).toBe(1);
    expect(notes).toEqual(
      buildHunkSessionReview(sessionEntry(bootstrap), { includeNotes: true }).reviewNotes ?? [],
    );
  });

  test("carries the sidecar's changeset and per-file summaries", () => {
    const repoRoot = createRepoRoot();
    const file = {
      ...createTestDiffFile({ id: "alpha", path: "alpha.ts", agent: true }),
      patch: ALPHA_PATCH,
    };
    const bootstrap = createTestVcsAppBootstrap({
      files: [file],
      sourceLabel: repoRoot,
      agentSummary: "What this whole change does.",
    });

    const exported = buildReviewExport(bootstrap, { repoRoot });

    // Distinct from the hunk notes above: these describe the change and the file as wholes,
    // and a client that only received notes would have nothing to show before a hunk opens.
    expect(exported.review.agentSummary).toBe("What this whole change does.");
    expect(exported.review.files[0]?.agentSummary).toBe("alpha.ts note");
  });

  test("reports no summaries for a review with no sidecar", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap } = bootstrapWith(repoRoot);

    const exported = buildReviewExport(bootstrap, { repoRoot });

    expect(exported.review.agentSummary).toBeUndefined();
    expect(exported.review.files[0]?.agentSummary).toBeUndefined();
  });

  test("omits raw patch text unless asked", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap } = bootstrapWith(repoRoot);

    expect(buildReviewExport(bootstrap, { repoRoot }).review.files[0]?.patch).toBeUndefined();
    expect(
      buildReviewExport(bootstrap, { repoRoot, includePatch: true }).review.files[0]?.patch,
    ).toBeTypeOf("string");
  });

  test("resolves viewed state from disk against the current patch", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap, file } = bootstrapWith(repoRoot);
    writeFileSync(
      join(repoRoot, HUNK_DIR_NAME, REVIEW_STATE_FILENAME),
      JSON.stringify({
        version: 1,
        files: {
          "alpha.ts": { patchHash: hashPatch(file.patch), viewedAt: "2026-08-01T00:00:00.000Z" },
        },
      }),
    );

    expect(buildReviewExport(bootstrap, { repoRoot }).viewedFilePaths).toEqual(["alpha.ts"]);
  });

  test("drops viewed state whose recorded patch no longer matches", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap } = bootstrapWith(repoRoot);
    writeFileSync(
      join(repoRoot, HUNK_DIR_NAME, REVIEW_STATE_FILENAME),
      JSON.stringify({
        version: 1,
        files: { "alpha.ts": { patchHash: "c".repeat(64), viewedAt: "2026-08-01T00:00:00.000Z" } },
      }),
    );

    expect(buildReviewExport(bootstrap, { repoRoot }).viewedFilePaths).toEqual([]);
  });

  test("re-anchors persisted comments and reports their resolved status", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap, file } = bootstrapWith(repoRoot);
    const commentsPath = join(repoRoot, HUNK_DIR_NAME, REVIEW_COMMENTS_FILENAME);
    const anchorLine = 1;
    const anchor = captureReviewCommentAnchor(file.patch, "new", anchorLine);
    expect(anchor).not.toBeNull();

    const comment: ReviewComment = {
      id: "c1",
      anchor: anchor!,
      body: "why this value?",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      status: "active",
    };
    expect(addReviewComment(commentsPath, "alpha.ts", comment).kind).toBe("written");

    const exported = buildReviewExport(bootstrap, { repoRoot });

    expect(exported.commentsAvailable).toBe(true);
    expect(exported.comments["alpha.ts"]).toHaveLength(1);
    expect(exported.comments["alpha.ts"]?.[0]?.status).toBe("active");
    expect(exported.comments["alpha.ts"]?.[0]?.line).toBe(anchorLine);
  });

  test("marks a comment outdated when its anchor text is gone", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap, file } = bootstrapWith(repoRoot);
    const commentsPath = join(repoRoot, HUNK_DIR_NAME, REVIEW_COMMENTS_FILENAME);
    const anchor = captureReviewCommentAnchor(file.patch, "new", 1);

    addReviewComment(commentsPath, "alpha.ts", {
      id: "c1",
      anchor: { ...anchor!, lineTextHash: "d".repeat(64) },
      body: "stale",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      status: "active",
    });

    const exported = buildReviewExport(bootstrap, { repoRoot }).comments["alpha.ts"]?.[0];

    expect(exported?.outdated).toBe(true);
    // Lifecycle is untouched by the anchor going stale.
    expect(exported?.status).toBe("active");
  });

  // The two facts are independent, and folding them together hid a resolved comment's
  // stale placement behind its lifecycle.
  test("a resolved comment still reports that its anchor went outdated", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap, file } = bootstrapWith(repoRoot);
    const commentsPath = join(repoRoot, HUNK_DIR_NAME, REVIEW_COMMENTS_FILENAME);
    const anchor = captureReviewCommentAnchor(file.patch, "new", 1);

    addReviewComment(commentsPath, "alpha.ts", {
      id: "c1",
      anchor: { ...anchor!, lineTextHash: "d".repeat(64) },
      body: "handled, but the code moved",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      status: "resolved",
    });

    const exported = buildReviewExport(bootstrap, { repoRoot }).comments["alpha.ts"]?.[0];

    expect(exported?.status).toBe("resolved");
    expect(exported?.outdated).toBe(true);
  });

  // "comments unavailable" must never be reported as "no comments".
  test("reports comments unavailable rather than empty when the store is corrupt", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap } = bootstrapWith(repoRoot);
    const commentsPath = join(repoRoot, HUNK_DIR_NAME, REVIEW_COMMENTS_FILENAME);
    const corrupt = "{ not json";
    writeFileSync(commentsPath, corrupt, "utf8");

    const exported = buildReviewExport(bootstrap, { repoRoot });

    expect(exported.commentsAvailable).toBe(false);
    expect(exported.commentsUnavailableReason).toBeTypeOf("string");
    expect(readFileSync(commentsPath, "utf8")).toBe(corrupt);
  });

  test("never writes to the review directory", () => {
    const repoRoot = createRepoRoot();
    const { bootstrap, file } = bootstrapWith(repoRoot);
    const statePath = join(repoRoot, HUNK_DIR_NAME, REVIEW_STATE_FILENAME);
    const commentsPath = join(repoRoot, HUNK_DIR_NAME, REVIEW_COMMENTS_FILENAME);
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        files: {
          "alpha.ts": { patchHash: hashPatch(file.patch), viewedAt: "2026-08-01T00:00:00.000Z" },
        },
      }),
    );
    addReviewComment(commentsPath, "alpha.ts", {
      id: "c1",
      anchor: captureReviewCommentAnchor(file.patch, "new", 1)!,
      body: "hi",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      status: "active",
    });
    const stateBefore = readFileSync(statePath, "utf8");
    const commentsBefore = readFileSync(commentsPath, "utf8");

    buildReviewExport(bootstrap, { repoRoot, includePatch: true });

    expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(readFileSync(commentsPath, "utf8")).toBe(commentsBefore);
  });

  test("works with no repo root, reporting empty progress rather than failing", () => {
    const { bootstrap } = bootstrapWith(createRepoRoot());

    const exported = buildReviewExport(bootstrap, { repoRoot: null });
    expect(exported.agentContextPath).toBeNull();

    expect(exported.viewedFilePaths).toEqual([]);
    expect(exported.commentsAvailable).toBe(true);
    expect(exported.comments).toEqual({});
  });
});
