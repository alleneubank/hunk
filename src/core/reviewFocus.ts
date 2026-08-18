import { mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HUNK_DIR_NAME, REVIEW_FOCUS_FILENAME } from "./run/paths";
import { isRecord } from "./typeGuards";
import type { DiffSide } from "./liveComments";

const REVIEW_FOCUS_VERSION = 1;

/**
 * The changeset a paired reviewer should be looking at.
 *
 * The same repo-backed cases the editor client offers, so an agent names a target the way a
 * human would pick one. Revision expressions and pathspecs remain unresolved: Hunk owns ref
 * resolution, and a focus recorded as a commit id would still point at the old changeset
 * after the branch moves.
 */
export type ReviewFocusTarget =
  | { kind: "working-tree"; pathspecs?: string[] }
  | { kind: "staged"; pathspecs?: string[] }
  | { kind: "range"; expression: string; pathspecs?: string[] }
  | { kind: "show"; ref?: string; pathspecs?: string[] }
  | { kind: "stash-show"; ref?: string };

/**
 * Where an agent is pointing its human partner.
 *
 * Review state, not review content: this says what to look at, never what is true about the
 * code. It is therefore derived and disposable — a corrupt or unreadable focus resets to
 * nothing and the reviewer keeps whatever they were already reading, exactly as viewed state
 * does and unlike authored comments, which are never discarded.
 */
export interface ReviewFocus {
  version: 1;
  target: ReviewFocusTarget;
  /** Repo-relative path of the file to open, when the agent named one. */
  file?: string;
  /** Which side of the diff `line` counts against. */
  side?: DiffSide;
  /** 1-based line to reveal within `file`. */
  line?: number;
  /**
   * Monotonic per-write counter.
   *
   * A client watching this file needs to tell a rewrite carrying the same instruction from a
   * genuinely new one — an agent saying "look at `fileLock.ts` again" writes identical
   * content, and without a revision the watcher would correctly conclude nothing changed and
   * ignore it.
   */
  revision: number;
  updatedAt: string;
}

/** Absolute path of one repo's focus file. */
export function reviewFocusPath(repoRoot: string): string {
  return join(repoRoot, HUNK_DIR_NAME, REVIEW_FOCUS_FILENAME);
}

/** Validate the persisted target before it can move a reviewer anywhere. */
function isReviewFocusTarget(value: unknown): value is ReviewFocusTarget {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.pathspecs !== undefined &&
    (!Array.isArray(value.pathspecs) ||
      value.pathspecs.length === 0 ||
      value.pathspecs.some(
        (pathspec) => typeof pathspec !== "string" || pathspec.trim().length === 0,
      ))
  ) {
    return false;
  }

  if (value.kind === "working-tree" || value.kind === "staged") {
    return true;
  }

  if (value.kind === "range") {
    return typeof value.expression === "string" && value.expression.length > 0;
  }

  if (value.kind === "show" || value.kind === "stash-show") {
    if (value.kind === "stash-show" && value.pathspecs !== undefined) {
      return false;
    }

    return value.ref === undefined || (typeof value.ref === "string" && value.ref.length > 0);
  }

  return false;
}

/** Validate the whole persisted schema; a partial match is treated as no focus at all. */
function isReviewFocus(value: unknown): value is ReviewFocus {
  if (
    !isRecord(value) ||
    value.version !== REVIEW_FOCUS_VERSION ||
    !isReviewFocusTarget(value.target) ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return false;
  }

  // A line without a file cannot be revealed anywhere, and a side without a line points at
  // nothing; either combination means the writer and the reader disagree about the schema.
  if (value.file !== undefined && typeof value.file !== "string") {
    return false;
  }

  if (value.line !== undefined) {
    if (
      typeof value.line !== "number" ||
      !Number.isInteger(value.line) ||
      value.line < 1 ||
      typeof value.file !== "string"
    ) {
      return false;
    }
  }

  return value.side === undefined || value.side === "old" || value.side === "new";
}

/** Read one repo's focus, treating every filesystem or schema error as no focus. */
export function readReviewFocus(repoRoot: string): ReviewFocus | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(reviewFocusPath(repoRoot), "utf8"));
    return isReviewFocus(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** What one focus write should say, before the revision and timestamp are stamped on. */
export type ReviewFocusRequest = Omit<ReviewFocus, "version" | "revision" | "updatedAt">;

/**
 * Point the reviewer somewhere, and report the focus that was written.
 *
 * The write is a temp file plus a rename so a watcher never observes a half-written pointer;
 * a client is notified the instant the file appears, which for a plain overwrite would
 * regularly be mid-write. The revision continues from whatever is on disk, so repeated
 * instructions stay distinguishable even across processes.
 */
export function writeReviewFocus(
  repoRoot: string,
  request: ReviewFocusRequest,
  now: () => Date = () => new Date(),
): ReviewFocus {
  const focus: ReviewFocus = {
    version: REVIEW_FOCUS_VERSION,
    ...request,
    revision: (readReviewFocus(repoRoot)?.revision ?? 0) + 1,
    updatedAt: now().toISOString(),
  };

  const filePath = reviewFocusPath(repoRoot);
  mkdirSync(dirname(filePath), { recursive: true });

  // Same directory as the destination, so the rename never crosses a filesystem boundary.
  const pendingPath = `${filePath}.${process.pid}.pending`;
  try {
    writeFileSync(pendingPath, `${JSON.stringify(focus, null, 2)}\n`, "utf8");
    renameSync(pendingPath, filePath);
  } catch (error) {
    rmSync(pendingPath, { force: true });
    throw error;
  }

  return focus;
}

/** Stop pointing anywhere. Absent focus and cleared focus are the same state. */
export function clearReviewFocus(repoRoot: string): void {
  rmSync(reviewFocusPath(repoRoot), { force: true });
}
