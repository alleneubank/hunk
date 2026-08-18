import type { DiffSide } from "./reviewExport";
import { isReviewTarget as isValidReviewTarget, type ReviewTarget } from "./reviewTarget";

/**
 * Where an agent is pointing this reviewer.
 *
 * The client's mirror of Hunk's `.hunk/review-focus.json`, validated on arrival like every
 * other payload: an unrecognized shape is treated as no focus rather than half-applied,
 * because a half-applied instruction moves the reviewer somewhere nobody asked for.
 */
export interface ReviewFocusPayload {
  target: ReviewTarget;
  file?: string;
  side?: DiffSide;
  line?: number;
  /**
   * Monotonic per-write counter.
   *
   * What makes a repeated instruction actionable: an agent saying "look at `fileLock.ts`
   * again" writes identical content, so content comparison alone would ignore it.
   */
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isReviewFocusPayload(value: unknown): value is ReviewFocusPayload {
  if (
    !isRecord(value) ||
    !isValidReviewTarget(value.target) ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision)
  ) {
    return false;
  }

  if (value.file !== undefined && typeof value.file !== "string") {
    return false;
  }

  // A line with no file cannot be revealed anywhere, so the pair is accepted or neither is.
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

/** Whether two targets name the same changeset, so an unchanged one is not reopened. */
export function sameReviewTarget(left: ReviewTarget, right: ReviewTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  const leftPathspecs = left.pathspecs ?? [];
  const rightPathspecs = right.pathspecs ?? [];
  if (
    leftPathspecs.length !== rightPathspecs.length ||
    leftPathspecs.some((pathspec, index) => pathspec !== rightPathspecs[index])
  ) {
    return false;
  }

  if (left.kind === "range") {
    return left.expression === (right as { expression: string }).expression;
  }

  if (left.kind === "show" || left.kind === "stash-show") {
    return left.ref === (right as { ref?: string }).ref;
  }

  return true;
}
