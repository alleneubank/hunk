import { createHash } from "node:crypto";
import type { DiffSide } from "./liveComments";
import type { ReviewCommentAnchor, ReviewCommentStatus } from "./reviewComments";

/** How many neighbouring rows are captured on each side of an anchor. */
const ANCHOR_CONTEXT_LINES = 2;

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One row of a unified patch, numbered on whichever sides it belongs to. */
export interface PatchLine {
  hunkIndex: number;
  hunkHeader: string;
  /** Present for context and deletion rows. */
  oldLine?: number;
  /** Present for context and addition rows. */
  newLine?: number;
  text: string;
}

/** Hash the comparable form of one line's text. */
export function hashAnchorText(text: string): string {
  // Trimmed on purpose: pure re-indentation should not orphan a comment, while any change
  // to the line's actual content should.
  return createHash("sha256").update(text.trim()).digest("hex");
}

/**
 * Walk a unified patch into numbered rows.
 *
 * Deliberately parses the raw patch rather than reusing Pierre's `Hunk` model: that model
 * carries per-block *counts*, not per-line text, and anchoring needs the text. Keeping
 * this a pure string walk also means resolution never needs the file on disk.
 */
export function readPatchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let hunkIndex = -1;
  let hunkHeader = "";
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const headerMatch = HUNK_HEADER_PATTERN.exec(raw);
    if (headerMatch) {
      hunkIndex += 1;
      hunkHeader = raw;
      oldLine = Number(headerMatch[1]);
      newLine = Number(headerMatch[3]);
      continue;
    }

    if (hunkIndex < 0) {
      // Everything before the first hunk header is file chrome (---/+++/diff/index).
      continue;
    }

    const marker = raw.slice(0, 1);
    const text = raw.slice(1);

    if (marker === "+") {
      lines.push({ hunkIndex, hunkHeader, newLine, text });
      newLine += 1;
      continue;
    }

    if (marker === "-") {
      lines.push({ hunkIndex, hunkHeader, oldLine, text });
      oldLine += 1;
      continue;
    }

    if (marker === " ") {
      lines.push({ hunkIndex, hunkHeader, oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    // "\" (no newline at end of file) and blank trailing rows carry no line number.
  }

  return lines;
}

/** Return the row's number on the requested side, if it exists there. */
function lineNumberOn(line: PatchLine, side: DiffSide): number | undefined {
  return side === "new" ? line.newLine : line.oldLine;
}

/** Collect up to `ANCHOR_CONTEXT_LINES` neighbouring texts around one index. */
function contextAround(lines: PatchLine[], index: number) {
  return {
    contextBefore: lines
      .slice(Math.max(0, index - ANCHOR_CONTEXT_LINES), index)
      .map((line) => line.text),
    contextAfter: lines.slice(index + 1, index + 1 + ANCHOR_CONTEXT_LINES).map((line) => line.text),
  };
}

/**
 * Capture everything needed to find this line again after the patch changes.
 *
 * Returns `null` when the requested location is not in the patch, so a caller can never
 * persist an anchor that never existed.
 */
export function captureReviewCommentAnchor(
  patch: string,
  side: DiffSide,
  line: number,
): ReviewCommentAnchor | null {
  const lines = readPatchLines(patch);
  const index = lines.findIndex((candidate) => lineNumberOn(candidate, side) === line);
  const anchorLine = lines[index];
  if (index < 0 || !anchorLine) {
    return null;
  }

  return {
    side,
    line,
    originalLine: line,
    lineTextHash: hashAnchorText(anchorLine.text),
    ...contextAround(lines, index),
    hunkHeader: anchorLine.hunkHeader,
  };
}

/** Score how much of the recorded context still surrounds a candidate row. */
function contextScore(lines: PatchLine[], index: number, anchor: ReviewCommentAnchor): number {
  const { contextBefore, contextAfter } = contextAround(lines, index);
  let score = 0;

  for (let offset = 1; offset <= anchor.contextBefore.length; offset += 1) {
    const expected = anchor.contextBefore[anchor.contextBefore.length - offset];
    const actual = contextBefore[contextBefore.length - offset];
    if (expected !== undefined && expected === actual) {
      score += 1;
    }
  }

  for (let offset = 0; offset < anchor.contextAfter.length; offset += 1) {
    if (
      anchor.contextAfter[offset] !== undefined &&
      anchor.contextAfter[offset] === contextAfter[offset]
    ) {
      score += 1;
    }
  }

  return score;
}

export interface ResolvedReviewCommentAnchor {
  line: number;
  status: ReviewCommentStatus;
}

/**
 * Re-anchor one comment against a fresh patch.
 *
 * Every rung requires the candidate row's text to hash to the recorded anchor hash. That
 * is what makes the Never-list invariant structural rather than aspirational: a comment
 * can only land on content matching what it was written against, and anything else
 * degrades to `outdated` with the author's original line preserved. Rungs differ only in
 * how they *choose among* matching rows, never in whether a match is required.
 */
export function resolveReviewCommentAnchor(
  anchor: ReviewCommentAnchor,
  patch: string,
): ResolvedReviewCommentAnchor {
  const outdated: ResolvedReviewCommentAnchor = {
    line: anchor.originalLine,
    status: "outdated",
  };
  const lines = readPatchLines(patch);

  // Candidates are always same-side rows whose text still matches.
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        lineNumberOn(line, anchor.side) !== undefined &&
        hashAnchorText(line.text) === anchor.lineTextHash,
    );

  if (candidates.length === 0) {
    return outdated;
  }

  // Matching text alone is not evidence, at any rung: `}` matches `}` anywhere in the file,
  // and so do `});`, `return;`, and `*/`. Where the anchor recorded surrounding context, a
  // candidate must still carry some of it. Without this, deleting a block leaves a lone
  // surviving `}` that is accepted as the comment's home — even at the same line number,
  // where the coincidence is most convincing and most wrong — and reported active. That is
  // the Never-list's letter satisfied and its intent broken. An anchor with no recorded
  // context has nothing to corroborate against and is exempt; one shared line of four is
  // enough, so an ordinary edit beside the anchor still holds it.
  const recordedContext = anchor.contextBefore.length + anchor.contextAfter.length;
  const corroborated =
    recordedContext === 0
      ? candidates
      : candidates.filter(({ index }) => contextScore(lines, index, anchor) > 0);

  if (corroborated.length === 0) {
    return outdated;
  }

  // Rung 1 — the anchor is still exactly where it was.
  const atSameLine = corroborated.find(
    ({ line }) => lineNumberOn(line, anchor.side) === anchor.line,
  );
  if (atSameLine) {
    return { line: anchor.line, status: "active" };
  }

  // Rung 2 — exactly one corroborated row, so there is nothing to disambiguate.
  const only = corroborated.length === 1 ? corroborated[0] : undefined;
  if (only) {
    return { line: lineNumberOn(only.line, anchor.side)!, status: "active" };
  }

  // Rung 3 — several rows match; prefer the one that kept the most surrounding context,
  // then the one nearest the original line. Both tie-breaks only ever pick among rows that
  // already matched, so neither can place the comment on foreign content.
  const scored = corroborated
    .map((candidate) => ({
      candidate,
      score: contextScore(lines, candidate.index, anchor),
      sameHunk: candidate.line.hunkHeader === anchor.hunkHeader ? 1 : 0,
      distance: Math.abs(lineNumberOn(candidate.line, anchor.side)! - anchor.originalLine),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.sameHunk - left.sameHunk ||
        left.distance - right.distance,
    );

  const best = scored[0];
  return best
    ? { line: lineNumberOn(best.candidate.line, anchor.side)!, status: "active" }
    : outdated;
}
