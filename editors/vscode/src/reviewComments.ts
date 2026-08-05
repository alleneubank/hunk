import * as vscode from "vscode";
import type {
  DiffSide,
  ExportedComment,
  ExportedCommentReply,
  ExportedReviewNote,
} from "./reviewExport";
import type { ReviewSession } from "./reviewSession";

/** Author shown on Hunk's agent notes, so they read as a distinct voice. */
const AGENT_AUTHOR = "Hunk agent note";

/**
 * What a rendered comment is, as the menu `when` clauses read it.
 *
 * Named after the role rather than the status, because the actions differ by role: only the
 * root of a conversation can be resolved, and only a persisted comment can be mutated at
 * all. Encoding that as one value keeps `package.json` free of clauses that try to infer a
 * comment's role from a combination of other fields.
 */
export type HunkCommentRole =
  | "root-active"
  | "root-resolved"
  | "reply"
  | "note-active"
  | "note-resolved";

/** One comment as VS Code renders it, carrying enough identity to mutate it later. */
export interface HunkComment extends vscode.Comment {
  /** Absent for agent notes, whose text lives in the sidecar and is never mutated here. */
  commentId?: string;
  /** Present only on an agent note, naming it for the operations that answer it. */
  noteId?: string;
  filePath: string;
  contextValue: HunkCommentRole;
}

/** Convert one exported comment into the root of a rendered conversation. */
function toVsCodeComment(filePath: string, comment: ExportedComment): HunkComment {
  const prefix = comment.outdated
    ? // Marked in the body rather than only in a badge: VS Code collapses thread
      // decorations, and REQ-VSCODE-005 requires the state to stay visible. Shown for a
      // resolved comment too — its placement is just as stale, and hiding that would put
      // it beside unrelated code with nothing to say so.
      `_Outdated — written against line ${comment.originalLine}, which has since changed._\n\n`
    : "";

  return {
    commentId: comment.id,
    filePath,
    author: { name: comment.author ?? "You" },
    body: new vscode.MarkdownString(`${prefix}${comment.body}`),
    mode: vscode.CommentMode.Preview,
    contextValue: comment.status === "resolved" ? "root-resolved" : "root-active",
    label: comment.status === "resolved" ? "resolved" : undefined,
  };
}

/**
 * Convert one reply into a rendered comment.
 *
 * No outdated prefix and no resolved label: both are facts about the conversation, already
 * stated once on its root. Repeating them here would say the same thing several times in one
 * thread and, worse, invite a reader to treat them as separate per-message state.
 */
function toReplyComment(filePath: string, reply: ExportedCommentReply): HunkComment {
  return {
    commentId: reply.id,
    filePath,
    author: { name: reply.author ?? "You" },
    body: new vscode.MarkdownString(reply.body),
    mode: vscode.CommentMode.Preview,
    contextValue: "reply",
  };
}

/**
 * Convert one agent note into the opening message of an exchange.
 *
 * The note's own text stays read-only — it is the agent's, authored in the sidecar and never
 * edited here — but the comment carries `noteId` so the reviewer's actions have something to
 * name. Its role reflects whether the reviewer has marked the note dealt with, which is a
 * fact about the conversation and lives in the paired comment.
 */
function toAgentComment(
  filePath: string,
  note: ExportedReviewNote,
  answered: ExportedComment | undefined,
): HunkComment {
  // Hunk already joined summary and rationale into `body`; re-deriving it here would be a
  // second opinion about how a note reads.
  const heading = note.title ? `**${note.title}**\n\n` : "";

  return {
    filePath,
    noteId: note.noteId,
    author: { name: note.author ?? AGENT_AUTHOR },
    body: new vscode.MarkdownString(`${heading}${note.body || "_No rationale recorded._"}`),
    mode: vscode.CommentMode.Preview,
    contextValue: answered?.status === "resolved" ? "note-resolved" : "note-active",
  };
}

/** Zero-based VS Code range for a one-based diff line. */
function lineRange(line: number): vscode.Range {
  const zeroBased = Math.max(0, line - 1);
  return new vscode.Range(zeroBased, 0, zeroBased, 0);
}

/**
 * Owns every comment thread the review shows.
 *
 * Threads are rebuilt wholesale from the payload after any change rather than patched in
 * place: the resolved line of a comment can move on any refresh, and reconciling that
 * incrementally would mean this file forming its own opinion about where a comment
 * belongs — exactly what REQ-VSCODE-007 forbids.
 */
export class ReviewCommentSurface {
  /** Readable so a test can assert where a thread landed, which is the whole contract. */
  readonly threads: vscode.CommentThread[] = [];

  constructor(
    readonly controller: vscode.CommentController,
    private readonly resolveUri: (path: string, side: DiffSide) => vscode.Uri,
  ) {}

  /** Rebuild every thread from the session's current payload. */
  render(session: ReviewSession): void {
    this.clear();

    for (const { file, comments } of session.files) {
      const notes = session.notesFor(file.path);
      // The reviewer's half of an exchange is an ordinary comment tagged with the note's key,
      // so pairing is an id lookup rather than a guess from line numbers — two things at one
      // line are not thereby about each other.
      const answers = new Map(
        comments.filter((comment) => comment.noteKey).map((comment) => [comment.noteKey!, comment]),
      );
      const noteKeys = new Set(notes.map((note) => note.noteKey));

      for (const note of notes) {
        // A note that only carries an old range describes code that is gone, so it belongs
        // in the pre-image. Anywhere else it would sit beside an unrelated line.
        const side: DiffSide = note.newRange ? "new" : "old";
        const line = (side === "new" ? note.newRange?.[0] : note.oldRange?.[0]) ?? 1;
        const answered = answers.get(note.noteKey);
        const thread = this.controller.createCommentThread(
          this.resolveUri(file.path, side),
          lineRange(line),
          [
            toAgentComment(file.path, note, answered),
            // An answer with no text is the record that the reviewer marked the note dealt
            // with; there is no message to draw for it, only a state the thread already shows.
            ...(answered && answered.body ? [toVsCodeComment(file.path, answered)] : []),
            ...(answered?.replies ?? []).map((reply) => toReplyComment(file.path, reply)),
          ],
        );
        thread.label = AGENT_AUTHOR;
        // The whole point of the pairing: an agent explaining itself is half a conversation,
        // and the reviewer needs somewhere to say the other half.
        thread.canReply = true;
        thread.state =
          answered?.status === "resolved"
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        this.threads.push(thread);
      }

      // A comment answering a note is drawn inside that note's thread, above. Drawing it here
      // too would put the reviewer's reply on the line a second time, detached from what it
      // answers. One whose note is gone — the agent rewrote it — falls through and renders as
      // the plain anchored comment it still is.
      for (const comment of comments.filter(
        (candidate) => !candidate.noteKey || !noteKeys.has(candidate.noteKey),
      )) {
        // Hunk resolved this comment against one side; showing it on the other would put it
        // at a line number that means something different.
        const thread = this.controller.createCommentThread(
          this.resolveUri(file.path, comment.side),
          lineRange(comment.line),
          // One thread per conversation. Hunk already ordered the replies; re-sorting them
          // here would be this file forming a second opinion about a payload it consumes.
          [
            toVsCodeComment(file.path, comment),
            ...(comment.replies ?? []).map((reply) => toReplyComment(file.path, reply)),
          ],
        );
        thread.label = comment.outdated ? "Outdated comment" : "Review comment";
        // The native affordance, so a resolved conversation is dimmed in the gutter the way
        // every other VS Code review surface dims one, rather than only in its own label.
        thread.state =
          comment.status === "resolved"
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.collapsibleState =
          comment.status === "resolved"
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;
        this.threads.push(thread);
      }
    }
  }

  clear(): void {
    for (const thread of this.threads.splice(0)) {
      thread.dispose();
    }
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}
