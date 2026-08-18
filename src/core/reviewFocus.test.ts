import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearReviewFocus,
  readReviewFocus,
  reviewFocusPath,
  writeReviewFocus,
} from "./reviewFocus";
import { HUNK_DIR_NAME } from "./run/paths";

/** A scratch repo root; focus needs no VCS, only a directory to write `.hunk/` into. */
function createTestRepo(): string {
  return mkdtempSync(join(tmpdir(), "hunk-focus-"));
}

/** Put arbitrary bytes where the focus file belongs, to test tolerant reads. */
function writeRawFocus(repoRoot: string, contents: string): void {
  mkdirSync(join(repoRoot, HUNK_DIR_NAME), { recursive: true });
  writeFileSync(reviewFocusPath(repoRoot), contents, "utf8");
}

describe("review focus", () => {
  test("records the changeset an agent points at", () => {
    const repo = createTestRepo();

    writeReviewFocus(repo, { target: { kind: "range", expression: "main...HEAD" } });

    expect(readReviewFocus(repo)?.target).toEqual({ kind: "range", expression: "main...HEAD" });
  });

  test("records a file and line alongside the changeset", () => {
    const repo = createTestRepo();

    writeReviewFocus(repo, {
      target: { kind: "working-tree" },
      file: "src/core/fileLock.ts",
      side: "new",
      line: 191,
    });

    const focus = readReviewFocus(repo);
    expect(focus?.file).toBe("src/core/fileLock.ts");
    expect(focus?.side).toBe("new");
    expect(focus?.line).toBe(191);
  });

  test("keeps a range as its expression, never as a resolved commit", () => {
    // A focus resolved to a commit id still points at the old changeset once the branch
    // moves. Hunk owns ref resolution, and it resolves at read time.
    const repo = createTestRepo();

    writeReviewFocus(repo, { target: { kind: "range", expression: "main...HEAD" } });

    expect(readFileSync(reviewFocusPath(repo), "utf8")).toContain("main...HEAD");
  });

  test("advances the revision on every write, so a repeated instruction still lands", () => {
    // An agent saying "look at fileLock.ts again" writes identical content. Without the
    // revision a watcher would correctly see no change and ignore it.
    const repo = createTestRepo();
    const request = { target: { kind: "working-tree" }, file: "a.ts" } as const;

    expect(writeReviewFocus(repo, request).revision).toBe(1);
    expect(writeReviewFocus(repo, request).revision).toBe(2);
    expect(readReviewFocus(repo)?.revision).toBe(2);
  });

  test("reports no focus for a repo that was never pointed anywhere", () => {
    expect(readReviewFocus(createTestRepo())).toBeUndefined();
  });

  test("treats a corrupt focus as none rather than failing the review", () => {
    // Derived state: the reviewer keeps reading whatever they had. This is viewed state's
    // policy, not the comment store's — nothing here is authored.
    const repo = createTestRepo();
    writeRawFocus(repo, "{ this is not json");

    expect(readReviewFocus(repo)).toBeUndefined();
  });

  test("refuses a focus whose schema it does not fully recognize", () => {
    const repo = createTestRepo();

    for (const contents of [
      JSON.stringify({ version: 2, target: { kind: "staged" }, revision: 1, updatedAt: "x" }),
      JSON.stringify({ version: 1, target: { kind: "elsewhere" }, revision: 1, updatedAt: "x" }),
      JSON.stringify({ version: 1, target: { kind: "range" }, revision: 1, updatedAt: "x" }),
      JSON.stringify({
        version: 1,
        target: { kind: "stash-show", pathspecs: ["src"] },
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        version: 1,
        target: { kind: "working-tree", pathspecs: ["   "] },
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      // A line with no file cannot be revealed anywhere.
      JSON.stringify({
        version: 1,
        target: { kind: "staged" },
        line: 4,
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      // Lines are 1-based; 0 means the writer and reader disagree about the schema.
      JSON.stringify({
        version: 1,
        target: { kind: "staged" },
        file: "a.ts",
        line: 0,
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]) {
      writeRawFocus(repo, contents);
      expect(readReviewFocus(repo)).toBeUndefined();
    }
  });

  test("never leaves a half-written pointer where a watcher can read it", () => {
    // The write is a temp file plus a rename precisely so a client woken by the change
    // never parses a partial document. Nothing but the focus file survives the write.
    const repo = createTestRepo();

    writeReviewFocus(repo, { target: { kind: "staged" } });

    const entries = readdirSync(join(repo, HUNK_DIR_NAME));
    expect(entries).toEqual(["review-focus.json"]);
  });

  test("clearing is the same state as never having pointed anywhere", () => {
    const repo = createTestRepo();
    writeReviewFocus(repo, { target: { kind: "staged" } });

    clearReviewFocus(repo);

    expect(readReviewFocus(repo)).toBeUndefined();
    // Clearing twice is not an error: the caller wants the state, not the transition.
    expect(() => clearReviewFocus(repo)).not.toThrow();
  });
});
