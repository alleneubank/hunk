import {
  createInitialSessionSnapshot,
  createSessionRegistration,
} from "../session/app/registration";
import { buildHunkSessionReview } from "../session/broker/projections";
import type { SessionReview } from "../session/types";
import { resolveReviewCommentAnchor } from "./reviewCommentAnchor";
import {
  isReviewCommentReply,
  isReviewRootComment,
  readReviewComments,
  REVIEW_COMMENTS_VERSION,
} from "./reviewComments";
import { resolveReviewCommentsPath, resolveViewedStatePath } from "./reviewStore";
import type { AppBootstrap } from "./types";
import type { ExtensionVcsSourceCapabilities } from "../extension-api/types";
import { readViewedState, resolveViewedPaths } from "./viewedState";

/**
 * Version of the export envelope itself.
 *
 * Deliberately separate from the daemon protocol version and from the comment store
 * version: a client reads this payload without ever speaking to the daemon, so tying its
 * compatibility to a wire protocol it never uses would force pointless lockstep upgrades.
 */
export const REVIEW_EXPORT_VERSION = 1;

/**
 * One answer to a comment, carrying no placement of its own.
 *
 * Where the reply is shown, and whether it is resolved, are facts about the conversation it
 * belongs to — so they are reported once, on the root, and never repeated here.
 */
export interface ExportedReviewCommentReply {
  id: string;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One persisted comment, re-anchored against the patch as it exists right now.
 *
 * Lifecycle and anchor validity are separate fields because they are separate facts, and a
 * comment can be both resolved and outdated. Folding them into one status meant a resolved
 * comment whose anchor had gone stale reported itself resolved while carrying a fallback
 * line, so a client rendered it against unrelated code with nothing to warn the reader.
 */
export interface ExportedReviewComment {
  id: string;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  side: "old" | "new";
  /** Where the comment currently resolves; equals `originalLine` when outdated. */
  line: number;
  originalLine: number;
  /** Whether the reviewer has dismissed it. Never says anything about placement. */
  status: "active" | "resolved";
  /** True when re-anchoring could not place it on matching content. */
  outdated: boolean;
  /** Answers to this comment, oldest first. Empty when nobody has replied. */
  replies: ExportedReviewCommentReply[];
  /**
   * Set when this conversation answers an agent note, naming that note's `noteKey`.
   *
   * A client pairs the two and renders one exchange. It never has to decide which comment
   * belongs to which note by looking at line numbers, which is the same coincidence the
   * anchoring ladder exists to refuse.
   */
  noteKey?: string;
}

export interface ReviewExport {
  exportVersion: typeof REVIEW_EXPORT_VERSION;
  reviewCommentsVersion: typeof REVIEW_COMMENTS_VERSION;
  repoRoot: string | null;
  /** Exact source provenance for editor clients; old adapters default conservatively to Hunk. */
  sourceCapabilities: ExtensionVcsSourceCapabilities;
  /** The same payload shape `hunk session review --json` returns for a live session. */
  review: SessionReview;
  viewedFilePaths: string[];
  /**
   * False only when the comment store exists but could not be read.
   *
   * A client must not render "no comments" for an unreadable store — that is how an
   * editor silently invites a user to re-author work that is still on disk.
   */
  commentsAvailable: boolean;
  commentsUnavailableReason?: string;
  comments: Record<string, ExportedReviewComment[]>;
}

export interface ReviewExportOptions {
  repoRoot: string | null;
  includePatch?: boolean;
}

/**
 * Build the headless review payload an editor client consumes.
 *
 * Composes the *same* projection the daemon serves rather than re-deriving files or hunks,
 * so a client reading a file with no live session sees byte-identical structure to one
 * attached to a running TUI. This function only reads: viewed state and comments are
 * resolved against the current patches and never written back.
 */
export function buildReviewExport(
  bootstrap: AppBootstrap,
  { repoRoot, includePatch = false }: ReviewExportOptions,
): ReviewExport {
  const review = buildHunkSessionReview(
    {
      registration: createSessionRegistration(bootstrap),
      snapshot: createInitialSessionSnapshot(bootstrap),
    },
    // Notes are always included: they are the reason a client reads a Hunk review rather
    // than a plain diff, and they are cheap next to the patch text.
    { includePatch, includeNotes: true },
  );

  const viewedFilePaths = repoRoot
    ? resolveViewedPaths(
        bootstrap.changeset.files,
        readViewedState(resolveViewedStatePath(repoRoot)),
      )
    : [];

  const patchByPath = new Map(bootstrap.changeset.files.map((file) => [file.path, file.patch]));
  const comments: Record<string, ExportedReviewComment[]> = {};
  let commentsAvailable = true;
  let commentsUnavailableReason: string | undefined;

  if (repoRoot) {
    const read = readReviewComments(resolveReviewCommentsPath(repoRoot));
    if (read.kind === "unavailable") {
      commentsAvailable = false;
      commentsUnavailableReason = read.reason;
    } else {
      for (const [path, stored] of Object.entries(read.store.files)) {
        // Replies are grouped onto their root rather than exported alongside it: a client
        // renders one conversation per anchored line, and flattening the two would make
        // every consumer re-derive the same grouping to avoid drawing a reply as its own
        // comment on a line it was never written against.
        const repliesByParent = new Map<string, ExportedReviewCommentReply[]>();
        for (const reply of stored.filter(isReviewCommentReply)) {
          const siblings = repliesByParent.get(reply.parentId) ?? [];
          siblings.push({
            id: reply.id,
            body: reply.body,
            author: reply.author,
            createdAt: reply.createdAt,
            updatedAt: reply.updatedAt,
          });
          repliesByParent.set(reply.parentId, siblings);
        }

        comments[path] = stored.filter(isReviewRootComment).map((comment) => {
          const patch = patchByPath.get(path);
          // A comment on a file outside this changeset has nothing to re-anchor against, so
          // it keeps its authored line and is reported outdated rather than guessed at.
          const resolved = patch
            ? resolveReviewCommentAnchor(comment.anchor, patch)
            : { line: comment.anchor.originalLine, status: "outdated" as const };

          return {
            id: comment.id,
            body: comment.body,
            author: comment.author,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            side: comment.anchor.side,
            line: resolved.line,
            originalLine: comment.anchor.originalLine,
            // Lifecycle is the reviewer's; anchoring is the ladder's. Neither overrides the
            // other, so a resolved comment can still report that its line moved out from
            // under it.
            status: comment.status === "resolved" ? "resolved" : "active",
            outdated: resolved.status === "outdated",
            ...(comment.noteKey ? { noteKey: comment.noteKey } : {}),
            // Oldest first, so a conversation reads in the order it was written.
            replies: (repliesByParent.get(comment.id) ?? []).sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt),
            ),
          };
        });
      }
    }
  }

  return {
    exportVersion: REVIEW_EXPORT_VERSION,
    reviewCommentsVersion: REVIEW_COMMENTS_VERSION,
    repoRoot,
    sourceCapabilities: bootstrap.changeset.sourceCapabilities ?? { old: "hunk", new: "hunk" },
    review,
    viewedFilePaths,
    commentsAvailable,
    commentsUnavailableReason,
    comments,
  };
}
