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

/** Whether one side can be opened as an editable workspace document. */
export type ReviewSourceKind = "hunk" | "workspace";

export interface ReviewSourceCapabilities {
  old: "hunk";
  new: ReviewSourceKind;
}

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
  /** Omitted by older Hunk binaries; those payloads are safest when both sides use Hunk. */
  sourceCapabilities?: ReviewSourceCapabilities;
  review: {
    title?: string;
    sourceLabel?: string;
    inputKind?: "vcs" | "show" | "stash-show";
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

const CHANGE_TYPES = new Set<ExportedChangeType>([
  "change",
  "rename-pure",
  "rename-changed",
  "new",
  "deleted",
]);

const NOTE_SOURCES = new Set(["ai", "agent", "user"]);

function malformed(field: string): never {
  throw new HunkReviewError("Hunk returned a malformed review payload.", `Invalid ${field}.`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  return isRecord(value) ? value : malformed(field);
}

function requireString(value: unknown, field: string): string {
  return typeof value === "string" ? value : malformed(field);
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    malformed(field);
  }
}

function requireInteger(value: unknown, field: string, minimum = 0): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    malformed(field);
  }
}

function optionalInteger(value: unknown, field: string, minimum = 0): void {
  if (value !== undefined) {
    requireInteger(value, field, minimum);
  }
}

function optionalRange(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }

  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((entry) => typeof entry !== "number" || !Number.isInteger(entry) || entry < 0)
  ) {
    malformed(field);
  }
}

function validateHunk(value: unknown, index: number): void {
  const hunk = requireRecord(value, `review.files[${index}].hunks`);
  requireInteger(hunk.index, `review.files[${index}].hunks.index`);
  optionalString(hunk.header, `review.files[${index}].hunks.header`);
  optionalInteger(hunk.oldStart, `review.files[${index}].hunks.oldStart`);
  optionalInteger(hunk.oldLines, `review.files[${index}].hunks.oldLines`);
  optionalInteger(hunk.newStart, `review.files[${index}].hunks.newStart`);
  optionalInteger(hunk.newLines, `review.files[${index}].hunks.newLines`);
  optionalRange(hunk.oldRange, `review.files[${index}].hunks.oldRange`);
  optionalRange(hunk.newRange, `review.files[${index}].hunks.newRange`);
}

function validateFile(value: unknown, index: number): void {
  const file = requireRecord(value, `review.files[${index}]`);
  requireString(file.id, `review.files[${index}].id`);
  requireString(file.path, `review.files[${index}].path`);
  optionalString(file.previousPath, `review.files[${index}].previousPath`);
  requireInteger(file.additions, `review.files[${index}].additions`);
  requireInteger(file.deletions, `review.files[${index}].deletions`);
  requireInteger(file.hunkCount, `review.files[${index}].hunkCount`);
  if (
    file.changeType !== undefined &&
    (typeof file.changeType !== "string" ||
      !CHANGE_TYPES.has(file.changeType as ExportedChangeType))
  ) {
    malformed(`review.files[${index}].changeType`);
  }
  optionalString(file.agentSummary, `review.files[${index}].agentSummary`);
  if (!Array.isArray(file.hunks)) {
    malformed(`review.files[${index}].hunks`);
  }
  file.hunks.forEach((hunk, hunkIndex) => validateHunk(hunk, hunkIndex));
  optionalString(file.patch, `review.files[${index}].patch`);
}

function validateNote(value: unknown, index: number): void {
  const note = requireRecord(value, `review.reviewNotes[${index}]`);
  requireString(note.noteId, `review.reviewNotes[${index}].noteId`);
  requireString(note.noteKey, `review.reviewNotes[${index}].noteKey`);
  if (typeof note.source !== "string" || !NOTE_SOURCES.has(note.source)) {
    malformed(`review.reviewNotes[${index}].source`);
  }
  requireString(note.filePath, `review.reviewNotes[${index}].filePath`);
  optionalInteger(note.hunkIndex, `review.reviewNotes[${index}].hunkIndex`);
  optionalRange(note.oldRange, `review.reviewNotes[${index}].oldRange`);
  optionalRange(note.newRange, `review.reviewNotes[${index}].newRange`);
  requireString(note.body, `review.reviewNotes[${index}].body`);
  optionalString(note.title, `review.reviewNotes[${index}].title`);
  optionalString(note.author, `review.reviewNotes[${index}].author`);
  requireString(note.createdAt, `review.reviewNotes[${index}].createdAt`);
  optionalString(note.updatedAt, `review.reviewNotes[${index}].updatedAt`);
  if (typeof note.editable !== "boolean") {
    malformed(`review.reviewNotes[${index}].editable`);
  }
}

function validateReply(value: unknown, field: string): void {
  const reply = requireRecord(value, field);
  requireString(reply.id, `${field}.id`);
  requireString(reply.body, `${field}.body`);
  optionalString(reply.author, `${field}.author`);
  requireString(reply.createdAt, `${field}.createdAt`);
  requireString(reply.updatedAt, `${field}.updatedAt`);
}

function validateComment(value: unknown, field: string): void {
  const comment = requireRecord(value, field);
  requireString(comment.id, `${field}.id`);
  requireString(comment.body, `${field}.body`);
  optionalString(comment.author, `${field}.author`);
  requireString(comment.createdAt, `${field}.createdAt`);
  requireString(comment.updatedAt, `${field}.updatedAt`);
  if (comment.side !== "old" && comment.side !== "new") {
    malformed(`${field}.side`);
  }
  requireInteger(comment.line, `${field}.line`, 1);
  requireInteger(comment.originalLine, `${field}.originalLine`, 1);
  if (comment.status !== "active" && comment.status !== "resolved") {
    malformed(`${field}.status`);
  }
  if (typeof comment.outdated !== "boolean") {
    malformed(`${field}.outdated`);
  }
  optionalString(comment.noteKey, `${field}.noteKey`);
  if (comment.replies !== undefined) {
    if (!Array.isArray(comment.replies)) {
      malformed(`${field}.replies`);
    }
    comment.replies.forEach((reply, index) => validateReply(reply, `${field}.replies[${index}]`));
  }
}

function validateSourceCapabilities(value: unknown): ReviewSourceCapabilities {
  const capabilities = requireRecord(value, "sourceCapabilities");
  if (capabilities.old !== "hunk") {
    malformed("sourceCapabilities.old");
  }
  if (capabilities.new !== "hunk" && capabilities.new !== "workspace") {
    malformed("sourceCapabilities.new");
  }

  return { old: "hunk", new: capabilities.new };
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

  if (
    typeof payload.reviewCommentsVersion !== "number" ||
    !Number.isInteger(payload.reviewCommentsVersion)
  ) {
    malformed("reviewCommentsVersion");
  }
  if (payload.repoRoot !== null && typeof payload.repoRoot !== "string") {
    malformed("repoRoot");
  }
  review.files.forEach(validateFile);
  optionalString(review.title, "review.title");
  optionalString(review.sourceLabel, "review.sourceLabel");
  if (
    review.inputKind !== undefined &&
    review.inputKind !== "vcs" &&
    review.inputKind !== "show" &&
    review.inputKind !== "stash-show"
  ) {
    malformed("review.inputKind");
  }
  optionalString(review.agentSummary, "review.agentSummary");
  if (review.reviewNotes !== undefined) {
    if (!Array.isArray(review.reviewNotes)) {
      malformed("review.reviewNotes");
    }
    review.reviewNotes.forEach(validateNote);
  }
  if (
    !Array.isArray(payload.viewedFilePaths) ||
    payload.viewedFilePaths.some((path) => typeof path !== "string")
  ) {
    malformed("viewedFilePaths");
  }
  if (typeof payload.commentsAvailable !== "boolean") {
    malformed("commentsAvailable");
  }
  optionalString(payload.commentsUnavailableReason, "commentsUnavailableReason");
  const comments = requireRecord(payload.comments, "comments");
  for (const [path, value] of Object.entries(comments)) {
    if (!Array.isArray(value)) {
      malformed(`comments.${path}`);
    }
    value.forEach((comment, index) => validateComment(comment, `comments.${path}[${index}]`));
  }

  const sourceCapabilities =
    payload.sourceCapabilities !== undefined
      ? validateSourceCapabilities(payload.sourceCapabilities)
      : { old: "hunk" as const, new: "hunk" as const };

  return { ...payload, sourceCapabilities } as unknown as ReviewExport;
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
