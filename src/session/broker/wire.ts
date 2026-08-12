import type { ChangeTypes } from "@pierre/diffs";
import { EXPERIMENTAL_FEATURES, type ExperimentalFeature } from "../../core/experimental";
import type { CliInput } from "../../core/types";
import {
  MAX_REGISTRATION_FILES,
  MAX_REGISTRATION_HUNKS_PER_FILE,
  MAX_REGISTRATION_PATCH_BYTES,
  MAX_SNAPSHOT_LIVE_COMMENTS,
  MAX_SNAPSHOT_REVIEW_NOTES,
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  utf8ByteLength,
} from "@hunk/session-broker-core";
import type { HunkSessionRegistration, HunkSessionSnapshot } from "../types";
import type {
  HunkSessionInfo,
  HunkSessionState,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
  SessionReviewFile,
  SessionReviewHunk,
} from "../types";

const REVIEW_INPUT_KINDS = new Set<CliInput["kind"]>([
  "vcs",
  "show",
  "stash-show",
  "diff",
  "patch",
  "difftool",
]);
const EXPERIMENTAL_FEATURE_SET = new Set<string>(EXPERIMENTAL_FEATURES);
/**
 * Ceiling on one agent-authored summary.
 *
 * Generous for a paragraph and far below anything that could bloat a registration: the
 * point is that the peer, not Hunk, chooses this string's length.
 */
const MAX_AGENT_SUMMARY_CHARS = 4_000;

/** Preserve only recognized experimental feature ids from a session registration. */
function parseExperimentalFeatures(value: unknown): ExperimentalFeature[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value)].filter(
    (feature): feature is ExperimentalFeature =>
      typeof feature === "string" && EXPERIMENTAL_FEATURE_SET.has(feature),
  );
}

/** Parse one optional diff-side line range tuple when the payload shape matches. */
function parseOptionalRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  const start = brokerWireParsers.parsePositiveInt(value[0]);
  const end = brokerWireParsers.parsePositiveInt(value[1]);
  return start !== null && end !== null ? [start, end] : undefined;
}

/** Parse one registered review hunk from the app-owned session payload. */
function parseSessionReviewHunk(value: unknown): SessionReviewHunk | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const index = brokerWireParsers.parseNonNegativeInt(record.index);
  const header = brokerWireParsers.parseRequiredString(record.header);
  if (index === null || header === null) {
    return null;
  }

  return {
    index,
    header,
    oldRange: parseOptionalRange(record.oldRange),
    newRange: parseOptionalRange(record.newRange),
  };
}

/** Every change kind Pierre reports, listed so the wire can reject anything else. */
const CHANGE_TYPES = new Set<ChangeTypes>([
  "change",
  "rename-pure",
  "rename-changed",
  "new",
  "deleted",
]);

/**
 * Parse a registered file's change kind, tolerating only a peer that does not send one.
 *
 * Registrations cross a process boundary between independently installed Hunk binaries, so
 * an older session can register with a newer daemon. Rejecting the whole file over a field
 * that peer never heard of would break the pairing outright, and absence degrades safely to
 * `change` — the behavior every client had before the field existed.
 *
 * A value that is present but not a change kind is different: something is wrong with the
 * payload, and coercing it would quietly turn a deleted file into an ordinary one, changing
 * which document a client opens. That fails validation like any other malformed field.
 */
function parseChangeType(value: unknown): ChangeTypes | null {
  if (value === undefined) {
    return "change";
  }

  return typeof value === "string" && CHANGE_TYPES.has(value as ChangeTypes)
    ? (value as ChangeTypes)
    : null;
}

/**
 * Parse one agent-authored summary, dropping anything past the budget.
 *
 * Truncated rather than rejected: a summary is descriptive text, so an over-long one is a
 * sloppy sidecar, not a corrupt registration, and refusing the whole review over it would
 * lose the diff as well. The bound exists because the peer authors this string.
 */
function parseAgentSummary(value: unknown): string | undefined {
  const summary = brokerWireParsers.parseOptionalString(value);

  return summary === undefined || summary.length <= MAX_AGENT_SUMMARY_CHARS
    ? summary
    : summary.slice(0, MAX_AGENT_SUMMARY_CHARS);
}

/** Parse one registered review file from the app-owned session payload. */
function parseSessionReviewFile(value: unknown): SessionReviewFile | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const id = brokerWireParsers.parseRequiredString(record.id);
  const path = brokerWireParsers.parseRequiredString(record.path);
  const additions = brokerWireParsers.parseNonNegativeInt(record.additions);
  const deletions = brokerWireParsers.parseNonNegativeInt(record.deletions);
  const changeType = parseChangeType(record.changeType);
  if (
    id === null ||
    path === null ||
    additions === null ||
    deletions === null ||
    changeType === null
  ) {
    return null;
  }

  if (!Array.isArray(record.hunks) || record.hunks.length > MAX_REGISTRATION_HUNKS_PER_FILE) {
    return null;
  }

  const hunks = record.hunks.map(parseSessionReviewHunk);
  if (hunks.some((hunk) => hunk === null)) {
    return null;
  }

  // Reject files whose patch text alone would blow the per-file memory budget instead of
  // silently dropping it, so an oversized registration fails loudly rather than half-loading.
  const patch = brokerWireParsers.parseOptionalString(record.patch);
  if (patch !== undefined && utf8ByteLength(patch) > MAX_REGISTRATION_PATCH_BYTES) {
    return null;
  }

  return {
    id,
    path,
    previousPath: brokerWireParsers.parseOptionalString(record.previousPath),
    additions,
    deletions,
    hunkCount: (hunks as SessionReviewHunk[]).length,
    changeType,
    agentSummary: parseAgentSummary(record.agentSummary),
    patch,
    hunks: hunks as SessionReviewHunk[],
  };
}

/** Parse one review input kind supported by live review sessions. */
function parseReviewInputKind(value: unknown): CliInput["kind"] | null {
  if (typeof value !== "string" || !REVIEW_INPUT_KINDS.has(value as CliInput["kind"])) {
    return null;
  }

  return value as CliInput["kind"];
}

/** Parse one live comment summary from the app-owned snapshot payload. */
function parseSessionLiveCommentSummary(value: unknown): SessionLiveCommentSummary | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const commentId = brokerWireParsers.parseRequiredString(record.commentId);
  const filePath = brokerWireParsers.parseRequiredString(record.filePath);
  const hunkIndex = brokerWireParsers.parseNonNegativeInt(record.hunkIndex);
  const summary = brokerWireParsers.parseRequiredString(record.summary);
  const createdAt = brokerWireParsers.parseRequiredString(record.createdAt);
  const line = brokerWireParsers.parsePositiveInt(record.line);
  const side = record.side === "old" || record.side === "new" ? record.side : null;
  if (
    commentId === null ||
    filePath === null ||
    hunkIndex === null ||
    summary === null ||
    createdAt === null ||
    line === null ||
    side === null
  ) {
    return null;
  }

  return {
    commentId,
    filePath,
    hunkIndex,
    side,
    line,
    summary,
    rationale: brokerWireParsers.parseOptionalString(record.rationale),
    author: brokerWireParsers.parseOptionalString(record.author),
    createdAt,
  };
}

/** Parse one review note summary from the app-owned snapshot payload. */
function parseSessionReviewNoteSummary(value: unknown): SessionReviewNoteSummary | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const noteId = brokerWireParsers.parseRequiredString(record.noteId);
  const filePath = brokerWireParsers.parseRequiredString(record.filePath);
  const body = brokerWireParsers.parseRequiredString(record.body);
  const createdAt = brokerWireParsers.parseRequiredString(record.createdAt);
  const source =
    record.source === "ai" || record.source === "agent" || record.source === "user"
      ? record.source
      : null;
  if (
    noteId === null ||
    filePath === null ||
    body === null ||
    createdAt === null ||
    source === null
  ) {
    return null;
  }

  return {
    noteId,
    // Absent from a snapshot written by a peer older than note keys. Falling back to the id
    // keeps the payload parseable; it is only ever used to pair a note with a reply, and a
    // peer that does not send keys has no replies to pair.
    noteKey: brokerWireParsers.parseOptionalString(record.noteKey) ?? noteId,
    source,
    filePath,
    hunkIndex: brokerWireParsers.parseNonNegativeInt(record.hunkIndex) ?? undefined,
    oldRange: parseOptionalRange(record.oldRange),
    newRange: parseOptionalRange(record.newRange),
    body,
    title: brokerWireParsers.parseOptionalString(record.title),
    author: brokerWireParsers.parseOptionalString(record.author),
    createdAt,
    updatedAt: brokerWireParsers.parseOptionalString(record.updatedAt),
    editable: typeof record.editable === "boolean" ? record.editable : source === "user",
  };
}

/** Parse the app-owned registration info embedded inside one broker registration envelope. */
function parseHunkSessionInfo(value: unknown): HunkSessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || !Array.isArray(record.files) || record.files.length > MAX_REGISTRATION_FILES) {
    return null;
  }

  const inputKind = parseReviewInputKind(record.inputKind);
  const title = brokerWireParsers.parseRequiredString(record.title);
  const sourceLabel = brokerWireParsers.parseRequiredString(record.sourceLabel);
  if (inputKind === null || title === null || sourceLabel === null) {
    return null;
  }

  const files = record.files.map(parseSessionReviewFile);
  if (files.some((file) => file === null)) {
    return null;
  }

  return {
    inputKind,
    title,
    sourceLabel,
    experimentalFeatures: parseExperimentalFeatures(record.experimentalFeatures),
    agentSummary: parseAgentSummary(record.agentSummary),
    files: files as SessionReviewFile[],
  };
}

/** Parse the app-owned snapshot state embedded inside one broker snapshot envelope. */
function parseHunkSessionState(value: unknown): HunkSessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (
    !record ||
    !Array.isArray(record.liveComments) ||
    record.liveComments.length > MAX_SNAPSHOT_LIVE_COMMENTS ||
    (Array.isArray(record.reviewNotes) && record.reviewNotes.length > MAX_SNAPSHOT_REVIEW_NOTES)
  ) {
    return null;
  }

  const selectedHunkIndex = brokerWireParsers.parseNonNegativeInt(record.selectedHunkIndex);
  const showAgentNotes = typeof record.showAgentNotes === "boolean" ? record.showAgentNotes : null;
  const viewedFileCount =
    record.viewedFileCount === undefined
      ? 0
      : brokerWireParsers.parseNonNegativeInt(record.viewedFileCount);
  const viewedFilePaths = record.viewedFilePaths === undefined ? [] : record.viewedFilePaths;
  if (
    selectedHunkIndex === null ||
    showAgentNotes === null ||
    viewedFileCount === null ||
    !Array.isArray(viewedFilePaths) ||
    viewedFilePaths.length > MAX_REGISTRATION_FILES ||
    viewedFilePaths.some((filePath) => typeof filePath !== "string")
  ) {
    return null;
  }

  const liveComments = record.liveComments
    .map(parseSessionLiveCommentSummary)
    .filter((comment): comment is SessionLiveCommentSummary => comment !== null);
  const reviewNotes = (Array.isArray(record.reviewNotes) ? record.reviewNotes : [])
    .map(parseSessionReviewNoteSummary)
    .filter((note): note is SessionReviewNoteSummary => note !== null);

  return {
    selectedFileId: brokerWireParsers.parseOptionalString(record.selectedFileId),
    selectedFilePath: brokerWireParsers.parseOptionalString(record.selectedFilePath),
    selectedHunkIndex,
    selectedHunkOldRange: parseOptionalRange(record.selectedHunkOldRange),
    selectedHunkNewRange: parseOptionalRange(record.selectedHunkNewRange),
    showAgentNotes,
    noteMarkupWidth: brokerWireParsers.parseNonNegativeInt(record.noteMarkupWidth) ?? undefined,
    liveCommentCount: liveComments.length,
    liveComments,
    reviewNoteCount: reviewNotes.length,
    reviewNotes,
    viewedFileCount,
    viewedFilePaths: viewedFilePaths as string[],
  };
}

/** Parse one Hunk session registration payload from the websocket wire format. */
export function parseSessionRegistration(value: unknown): HunkSessionRegistration | null {
  return parseSessionRegistrationEnvelope(value, parseHunkSessionInfo);
}

/** Parse one Hunk session snapshot payload from the websocket wire format. */
export function parseSessionSnapshot(value: unknown): HunkSessionSnapshot | null {
  return parseSessionSnapshotEnvelope(value, parseHunkSessionState);
}
