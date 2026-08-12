import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./fileLock";
import type { DiffSide } from "./liveComments";
import { isRecord } from "./typeGuards";

export const REVIEW_COMMENTS_VERSION = 1;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** Lifecycle of one review comment relative to the code it was written against. */
export type ReviewCommentStatus = "active" | "outdated" | "resolved";

/**
 * Where a comment was written, recorded richly enough to survive an edit.
 *
 * `line` is the current resolution and moves; `originalLine` is where the author put it
 * and never moves. The content fields exist because pure line anchors rot — they are what
 * lets the resolver (a later unit) prove a candidate line is the *same* line rather than
 * merely the same number.
 */
export interface ReviewCommentAnchor {
  side: DiffSide;
  line: number;
  originalLine: number;
  /** sha256 of the trimmed anchor line's text at write time. */
  lineTextHash: string;
  contextBefore: string[];
  contextAfter: string[];
  hunkHeader?: string;
}

/** What every comment carries, whether it opens a conversation or continues one. */
export interface ReviewCommentFields {
  id: string;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

/** A comment written against a line: the root of one conversation. */
export interface ReviewRootComment extends ReviewCommentFields {
  anchor: ReviewCommentAnchor;
  status: ReviewCommentStatus;
  /**
   * Set when this conversation answers an agent note, keyed on the note's content.
   *
   * A note lives in the sidecar and is never edited here, so the reviewer's half of the
   * exchange is an ordinary anchored comment that happens to say which note it is about.
   * That buys the whole comment machinery — re-anchoring, resolution, replies — instead of a
   * parallel store for note state, and a note the agent later rewrites simply stops matching
   * rather than collecting answers to text it no longer contains.
   */
  noteKey?: string;
  /** Never present. Declared so the union narrows on the field that distinguishes it. */
  parentId?: undefined;
}

/**
 * One answer to a root comment.
 *
 * A reply has neither an anchor nor a status, and that absence is the design rather than an
 * omission: it is shown wherever its root landed and dismissed when its root is dismissed.
 * Giving a reply its own copy of either field would let a thread disagree with itself — the
 * root outdated while a reply claims a live line, or half a conversation resolved — so the
 * two shapes are made exclusive on disk instead.
 */
export interface ReviewCommentReply extends ReviewCommentFields {
  parentId: string;
  anchor?: undefined;
  status?: undefined;
}

export type ReviewComment = ReviewRootComment | ReviewCommentReply;

/** Narrow one stored comment to a reply. */
export function isReviewCommentReply(comment: ReviewComment): comment is ReviewCommentReply {
  return comment.parentId !== undefined;
}

/** Narrow one stored comment to the root of a conversation. */
export function isReviewRootComment(comment: ReviewComment): comment is ReviewRootComment {
  return comment.parentId === undefined;
}

export interface ReviewCommentsStore {
  version: typeof REVIEW_COMMENTS_VERSION;
  files: Record<string, ReviewComment[]>;
}

/**
 * Outcome of reading the comment store.
 *
 * Deliberately a union rather than a plain store: comments are authored content, so
 * "there is no file yet" and "the file exists but could not be read" must never collapse
 * into the same empty value. `unavailable` carries no store at all, which makes it
 * unrepresentable for a caller to treat a read failure as an empty review and write over
 * it. This is the type-level half of the strict-preserve policy; the writer unit enforces
 * the rest by refusing to write when the last read was `unavailable`.
 */
export type ReviewCommentsRead =
  | { kind: "ok"; store: ReviewCommentsStore }
  | { kind: "absent"; store: ReviewCommentsStore }
  | { kind: "unavailable"; reason: string };

/** Create a fresh empty store so callers never share a mutable record. */
export function emptyReviewCommentsStore(): ReviewCommentsStore {
  return { version: REVIEW_COMMENTS_VERSION, files: {} };
}

/** Validate one persisted anchor before it can position a comment. */
function isReviewCommentAnchor(value: unknown): value is ReviewCommentAnchor {
  if (!isRecord(value)) {
    return false;
  }

  const hasContext =
    Array.isArray(value.contextBefore) &&
    value.contextBefore.every((line) => typeof line === "string") &&
    Array.isArray(value.contextAfter) &&
    value.contextAfter.every((line) => typeof line === "string");

  return (
    (value.side === "old" || value.side === "new") &&
    Number.isInteger(value.line) &&
    Number.isInteger(value.originalLine) &&
    typeof value.lineTextHash === "string" &&
    SHA256_HEX_PATTERN.test(value.lineTextHash) &&
    hasContext &&
    (value.hunkHeader === undefined || typeof value.hunkHeader === "string")
  );
}

/** Validate the fields every comment carries, whatever its shape. */
function hasReviewCommentFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.body === "string" &&
    (value.author === undefined || typeof value.author === "string") &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

/**
 * Validate one persisted comment as exactly one of the two shapes.
 *
 * Exclusivity is checked here rather than trusted from the writer, because this is the only
 * point every entry passes through. A hybrid — anchor *and* parent, or a reply carrying its
 * own status — would type-check against the union at a call site while meaning something no
 * part of the system can render, so it is rejected as an unsupported store and the bytes are
 * preserved for the user.
 */
function isReviewComment(value: unknown): value is ReviewComment {
  if (!isRecord(value) || !hasReviewCommentFields(value)) {
    return false;
  }

  if (value.parentId !== undefined) {
    return (
      typeof value.parentId === "string" &&
      value.parentId.length > 0 &&
      value.anchor === undefined &&
      value.status === undefined
    );
  }

  return (
    isReviewCommentAnchor(value.anchor) &&
    (value.noteKey === undefined || typeof value.noteKey === "string") &&
    (value.status === "active" || value.status === "outdated" || value.status === "resolved")
  );
}

/** Validate the complete persisted schema before any entry can affect a review. */
function isReviewCommentsStore(value: unknown): value is ReviewCommentsStore {
  if (!isRecord(value) || value.version !== REVIEW_COMMENTS_VERSION || !isRecord(value.files)) {
    return false;
  }

  return Object.values(value.files).every(
    (comments) => Array.isArray(comments) && comments.every(isReviewComment),
  );
}

/**
 * Read the comment store without ever discarding authored content.
 *
 * Contrast `readViewedState`, which resets to empty on any doubt: that is correct for
 * derived viewed state and wrong here. A missing file is genuinely empty; anything else
 * that cannot be parsed is reported as `unavailable` so the bytes survive for the user to
 * recover. This function only reads — it never repairs, truncates, or rewrites.
 */
export function readReviewComments(filePath: string): ReviewCommentsRead {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    // Only a genuinely absent file is an empty review. Permission and IO errors are not.
    if (isRecord(error) && error.code === "ENOENT") {
      return { kind: "absent", store: emptyReviewCommentsStore() };
    }

    return {
      kind: "unavailable",
      reason: `Could not read ${filePath}: ${isRecord(error) && typeof error.message === "string" ? error.message : "unknown error"}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unavailable", reason: `${filePath} is not valid JSON.` };
  }

  if (!isReviewCommentsStore(parsed)) {
    // A newer version lands here too, on purpose: an older binary must not decide a store
    // it does not understand is empty.
    return { kind: "unavailable", reason: `${filePath} is not a supported review comment store.` };
  }

  return { kind: "ok", store: parsed };
}

export type ReviewCommentsWrite =
  | { kind: "written"; store: ReviewCommentsStore }
  | { kind: "unavailable"; reason: string }
  // Distinct from `unavailable`: the store is perfectly readable, a peer simply holds the
  // lock. The caller's remedy is to retry, not to repair a file.
  | { kind: "contended"; reason: string };

/** Union two stores by comment id, keeping whichever revision was updated last. */
export function mergeReviewCommentStores(
  base: ReviewCommentsStore,
  incoming: ReviewCommentsStore,
): ReviewCommentsStore {
  const files: Record<string, ReviewComment[]> = {};

  for (const path of new Set([...Object.keys(base.files), ...Object.keys(incoming.files)])) {
    const byId = new Map<string, ReviewComment>();
    for (const comment of [...(base.files[path] ?? []), ...(incoming.files[path] ?? [])]) {
      const existing = byId.get(comment.id);
      // Union, never replace: a writer that read a stale store must not delete a peer's
      // comment, and an older revision of one id must not beat a newer one.
      if (!existing || Date.parse(comment.updatedAt) >= Date.parse(existing.updatedAt)) {
        byId.set(comment.id, comment);
      }
    }

    const merged = [...byId.values()];
    if (merged.length > 0) {
      files[path] = merged;
    }
  }

  return { version: REVIEW_COMMENTS_VERSION, files };
}

/**
 * Collect the comment ids one mutation intentionally removed.
 *
 * The merge below is a union, which is what keeps a peer's concurrent additions alive — but
 * a union can never express a deletion, because the id the mutation dropped is still in the
 * store it merges against. Comparing the mutation's input to its output is what separates
 * "this writer deleted it" from "this writer never saw it".
 */
function collectRemovedCommentIds(
  before: ReviewCommentsStore,
  after: ReviewCommentsStore,
): Map<string, Set<string>> {
  const removed = new Map<string, Set<string>>();

  for (const [path, comments] of Object.entries(before.files)) {
    const survivingIds = new Set((after.files[path] ?? []).map((comment) => comment.id));
    const removedIds = comments.map((comment) => comment.id).filter((id) => !survivingIds.has(id));

    if (removedIds.length > 0) {
      removed.set(path, new Set(removedIds));
    }
  }

  return removed;
}

/** Drop intentionally removed comments from a merged store. */
function dropRemovedComments(
  store: ReviewCommentsStore,
  removed: Map<string, Set<string>>,
): ReviewCommentsStore {
  if (removed.size === 0) {
    return store;
  }

  const files: Record<string, ReviewComment[]> = {};

  for (const [path, comments] of Object.entries(store.files)) {
    const removedIds = removed.get(path);
    const kept = removedIds ? comments.filter((comment) => !removedIds.has(comment.id)) : comments;

    if (kept.length > 0) {
      files[path] = kept;
    }
  }

  return { version: REVIEW_COMMENTS_VERSION, files };
}

/**
 * Drop replies whose root is no longer in the store.
 *
 * The union rule and cascading deletion pull in opposite directions: a writer deleting a root
 * computes its removal set before the merge, so a peer's reply that arrived in between is
 * unioned back in and survives with no root to be shown under and no anchor of its own —
 * invisible content in a store whose whole promise is that authored content is never quietly
 * lost. Reconciling here, after the merge, is what makes "a conversation is deleted whole"
 * true of the file rather than only of one writer's intent.
 */
function dropOrphanedReplies(store: ReviewCommentsStore): ReviewCommentsStore {
  const files: Record<string, ReviewComment[]> = {};

  for (const [path, comments] of Object.entries(store.files)) {
    const rootIds = new Set(comments.filter(isReviewRootComment).map((comment) => comment.id));
    const kept = comments.filter(
      (comment) => !isReviewCommentReply(comment) || rootIds.has(comment.parentId),
    );

    if (kept.length > 0) {
      files[path] = kept;
    }
  }

  return { version: REVIEW_COMMENTS_VERSION, files };
}

/**
 * Apply one mutation to the comment store under an exclusive lock.
 *
 * Three properties matter more than throughput here. First, the lock is required, not
 * advisory: failing to take it within the bounded budget returns `contended` and writes
 * nothing, because a read-modify-write without exclusivity can drop a peer's comment.
 * Second, a store that cannot be read is never written — `unavailable` propagates instead,
 * so unparseable authored content is preserved for the user rather than replaced by
 * whatever this process happened to hold. Third, the result is still merged against a
 * re-read taken under the lock, which keeps the union rule (REQ-REVIEW-008) true even for
 * a store that changed between acquiring the lock and writing.
 */
export function mutateReviewComments(
  filePath: string,
  mutate: (store: ReviewCommentsStore) => ReviewCommentsStore,
): ReviewCommentsWrite {
  const lockPath = `${filePath}.lock`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `Could not create the review directory: ${String(error)}`,
    };
  }

  const locked = withFileLock<ReviewCommentsWrite>(lockPath, () => {
    const before = readReviewComments(filePath);
    if (before.kind === "unavailable") {
      return before;
    }

    const mutated = mutate(before.store);

    // Re-read under the lock rather than trusting `before`: the mutation itself may have
    // touched the file, and the union rule has to be applied against what is on disk now.
    const latest = readReviewComments(filePath);
    if (latest.kind === "unavailable") {
      return latest;
    }

    const next = dropOrphanedReplies(
      dropRemovedComments(
        mergeReviewCommentStores(latest.store, mutated),
        collectRemovedCommentIds(before.store, mutated),
      ),
    );
    const tempPath = `${filePath}.${process.pid}.tmp`;
    try {
      // Write-then-rename so a crash mid-write can never truncate authored content.
      writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tempPath, filePath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      return { kind: "unavailable", reason: `Could not write ${filePath}: ${String(error)}` };
    }

    return { kind: "written", store: next };
  });

  if (locked.kind === "ran") {
    return locked.value;
  }

  // `unavailable` is passed through rather than folded into contention: a lock path that
  // cannot be created never resolves by waiting, and telling the client to retry it hides
  // the real failure behind a peer that does not exist.
  return locked.kind === "unavailable"
    ? locked
    : { kind: "contended", reason: `Another process is writing ${filePath}.` };
}

/** Add or update one comment on one file path. */
export function addReviewComment(
  filePath: string,
  reviewedPath: string,
  comment: ReviewComment,
): ReviewCommentsWrite {
  return mutateReviewComments(filePath, (store) => ({
    ...store,
    files: {
      ...store.files,
      [reviewedPath]: [
        ...(store.files[reviewedPath] ?? []).filter((entry) => entry.id !== comment.id),
        comment,
      ],
    },
  }));
}
