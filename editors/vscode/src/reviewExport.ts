/**
 * The `hunk review` payload, as this extension consumes it.
 *
 * Declared structurally rather than imported from Hunk's sources on purpose: the extension
 * host is Node and CommonJS, and Hunk's `src/core` reaches Bun APIs. The compatibility
 * contract is `exportVersion`, checked at every read, not a shared type at compile time.
 */

/** The only export envelope version this extension understands. */
export const SUPPORTED_EXPORT_VERSION = 1;

/** Lifecycle of a comment. Placement is reported separately by `outdated`. */
export type ReviewCommentStatus = "active" | "resolved";

/** Which side of the diff something is anchored to. */
export type DiffSide = "old" | "new";

export interface ExportedHunk {
  index: number;
  header?: string;
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
}

/** How a file changed. Mirrors Pierre's `ChangeTypes`, which Hunk carries into the export. */
export type ExportedChangeType = "change" | "rename-pure" | "rename-changed" | "new" | "deleted";

export interface ExportedFile {
  id: string;
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  hunkCount: number;
  /**
   * Absent from a payload written by a Hunk older than this field.
   *
   * Treated as `change` where it matters, which is the behavior that predates it.
   */
  changeType?: ExportedChangeType;
  /** The sidecar's one-line reason this file is in the change, when it has one. */
  agentSummary?: string;
  hunks: ExportedHunk[];
  patch?: string;
}

/**
 * One answer to a comment.
 *
 * Carries no side, line, or status: a reply is shown wherever its root landed and shares its
 * root's lifecycle, so those facts are reported once per conversation rather than per message.
 */
export interface ExportedCommentReply {
  id: string;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExportedComment {
  id: string;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  side: DiffSide;
  line: number;
  originalLine: number;
  status: ReviewCommentStatus;
  /** True when Hunk could not re-anchor it onto matching content. */
  outdated: boolean;
  /**
   * Answers to this comment, oldest first.
   *
   * Absent from a payload written by a Hunk older than replies; every read treats a missing
   * list as an empty one rather than as a reason to reject the review.
   */
  replies?: ExportedCommentReply[];
  /** Set when this conversation answers an agent note, naming that note's `noteKey`. */
  noteKey?: string;
}

/** One agent note, in the shape `SessionReviewNoteSummary` serializes to. */
export interface ExportedReviewNote {
  noteId: string;
  /**
   * Content identity of the note, stable where `noteId` is not.
   *
   * `noteId` embeds the note's position in the changeset, so it moves when an unrelated file
   * enters the review. Anything the reviewer persists against a note is keyed on this.
   */
  noteKey: string;
  source: string;
  filePath: string;
  hunkIndex?: number;
  oldRange?: [number, number];
  newRange?: [number, number];
  /** Summary and rationale already joined by Hunk; the client never re-derives it. */
  body: string;
  title?: string;
  author?: string;
  createdAt: string;
  updatedAt?: string;
  editable: boolean;
}

export interface ReviewExport {
  exportVersion: number;
  reviewCommentsVersion: number;
  repoRoot: string | null;
  review: {
    title?: string;
    sourceLabel?: string;
    /** The sidecar's account of what this whole change does, when one was authored. */
    agentSummary?: string;
    files: ExportedFile[];
    reviewNotes?: ExportedReviewNote[];
  };
  viewedFilePaths: string[];
  commentsAvailable: boolean;
  commentsUnavailableReason?: string;
  comments: Record<string, ExportedComment[]>;
}

/** Error carrying an actionable message for the user, as opposed to a bug. */
export class HunkReviewError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "HunkReviewError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate one already-parsed export payload before any of it reaches the UI.
 *
 * The version check is first and fatal: REQ-VSCODE-006 forbids a fallback, and a payload
 * from a newer Hunk may have moved a field this extension reads positionally. Failing with
 * "upgrade the extension" beats rendering a review that is quietly wrong.
 */
export function parseReviewExport(payload: unknown): ReviewExport {
  if (!isRecord(payload)) {
    throw new HunkReviewError("Hunk returned an unexpected review payload.");
  }

  const version = payload.exportVersion;
  if (version !== SUPPORTED_EXPORT_VERSION) {
    throw new HunkReviewError(
      `This extension understands Hunk review export v${SUPPORTED_EXPORT_VERSION}, but the \`hunk\` binary emitted v${String(version)}.`,
      "Upgrade whichever of the two is older, then run Hunk: Open Review again.",
    );
  }

  const review = payload.review;
  if (!isRecord(review) || !Array.isArray(review.files)) {
    throw new HunkReviewError("Hunk returned a review with no file list.");
  }

  return payload as unknown as ReviewExport;
}

/**
 * Unwrap whichever payload shape a review subcommand produced.
 *
 * `export` returns the review bare; write operations wrap it beside what the write did.
 * Unwrapping here means no UI code has to know which subcommand it happened to call.
 */
export function readReviewPayload(raw: string): ReviewExport {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HunkReviewError("Hunk returned output that is not JSON.", raw.slice(0, 400));
  }

  const wrapped = isRecord(payload) && "operation" in payload && "review" in payload;
  return parseReviewExport(wrapped ? (payload as { review: unknown }).review : payload);
}

/** Read the structured error `hunk review` writes to stderr on failure. */
export function parseReviewError(stderr: string): { message: string; suggestions: string[] } {
  try {
    const parsed: unknown = JSON.parse(stderr);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return {
        message: parsed.error.message,
        suggestions: Array.isArray(parsed.error.suggestions)
          ? parsed.error.suggestions.filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    }
  } catch {
    // Fall through: a crash before the JSON handler still owes the user its output.
  }

  return { message: stderr.trim() || "Hunk failed without a message.", suggestions: [] };
}
