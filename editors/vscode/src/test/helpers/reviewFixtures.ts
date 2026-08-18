import type { HunkCli } from "../../hunkCli";
import type {
  ExportedComment,
  ExportedFile,
  ExportedReviewNote,
  ReviewExport,
} from "../../reviewExport";
import { ReviewSession } from "../../reviewSession";

/** One reviewed file, with only the fields the sidebar reads. */
export function createTestFile(path: string, additions = 1, deletions = 0): ExportedFile {
  return { id: path, path, additions, deletions, hunkCount: 1, hunks: [] };
}

/** One comment, with only the fields the sidebar and its decorations read. */
export function createTestComment(overrides: Partial<ExportedComment> = {}): ExportedComment {
  return {
    id: "c1",
    body: "why?",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    side: "new",
    line: 1,
    originalLine: 1,
    status: "active",
    outdated: false,
    ...overrides,
  };
}

/** One agent note against a file. */
export function createTestNote(filePath: string): ExportedReviewNote {
  return {
    noteId: `${filePath}:1`,
    noteKey: `key-${filePath}`,
    source: "sidecar",
    filePath,
    body: "Because the constant moved.",
    createdAt: "2026-01-01T00:00:00.000Z",
    editable: false,
  };
}

/** Everything a test review can carry beyond its file paths. */
export interface TestReviewOverrides {
  agentSummary?: string;
  files?: ExportedFile[];
  notes?: ExportedReviewNote[];
  comments?: Record<string, ExportedComment[]>;
}

/**
 * A session over a fixed file list.
 *
 * The CLI is deliberately absent: every surface built on this reads the payload it was
 * handed, so a test that provoked a CLI call would be testing something else and should
 * crash rather than quietly pass.
 */
export function createTestSession(
  paths: readonly string[],
  viewedFilePaths: string[] = [],
  review: TestReviewOverrides = {},
): ReviewSession {
  const payload: ReviewExport = {
    exportVersion: 1,
    reviewCommentsVersion: 1,
    repoRoot: null,
    review: {
      title: "working tree",
      files: review.files ?? paths.map((path) => createTestFile(path)),
      ...(review.notes ? { reviewNotes: review.notes } : {}),
      ...(review.agentSummary ? { agentSummary: review.agentSummary } : {}),
    },
    viewedFilePaths,
    commentsAvailable: true,
    comments: review.comments ?? {},
  };

  return new ReviewSession(undefined as unknown as HunkCli, payload);
}
