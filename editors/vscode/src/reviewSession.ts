import type { HunkCli } from "./hunkCli";
import type { ExportedComment, ExportedFile, ReviewExport } from "./reviewExport";

/** One file as the review UI needs it: Hunk's data plus the derived flags it displays. */
export interface ReviewFileState {
  file: ExportedFile;
  viewed: boolean;
  comments: ExportedComment[];
}

/**
 * The loaded review, and the only place the extension holds review state.
 *
 * Every mutation goes back through the CLI and replaces the whole payload with what the
 * write produced, so the extension never maintains an optimistic copy that can disagree
 * with `.hunk/`. That is what keeps REQ-VSCODE-007 true in practice rather than in
 * principle: there is nothing here to drift.
 */
export class ReviewSession {
  private current: ReviewExport;

  constructor(
    private readonly cli: HunkCli,
    initial: ReviewExport,
  ) {
    this.current = initial;
  }

  get export(): ReviewExport {
    return this.current;
  }

  /**
   * The root that reviewed paths are relative to.
   *
   * Hunk resolves the canonical VCS root, which is not necessarily the folder the user
   * opened — opening a subdirectory of a repository is ordinary. Joining repo-relative
   * paths onto the workspace folder would then point at files that do not exist, so the
   * payload's own root wins whenever it has one.
   */
  reviewRoot(workspaceRoot: string): string {
    return this.current.repoRoot ?? workspaceRoot;
  }

  /** Files in Hunk's order, which is the sidecar order when one is present. */
  get files(): ReviewFileState[] {
    const viewed = new Set(this.current.viewedFilePaths);

    return this.current.review.files.map((file) => ({
      file,
      viewed: viewed.has(file.path),
      comments: this.current.comments[file.path] ?? [],
    }));
  }

  /** True only when the store exists and could not be read (never for "no comments"). */
  get commentsUnavailableReason(): string | undefined {
    return this.current.commentsAvailable ? undefined : this.current.commentsUnavailableReason;
  }

  /** Agent notes for one file, in the order Hunk matched them. */
  notesFor(path: string) {
    return (this.current.review.reviewNotes ?? []).filter((note) => note.filePath === path);
  }

  async refresh(): Promise<void> {
    this.current = await this.cli.export(true);
  }

  async addComment(input: {
    file: string;
    side: "old" | "new";
    line: number;
    body: string;
    author?: string;
  }): Promise<void> {
    this.current = await this.cli.addComment(input);
  }

  async replyToComment(input: {
    file: string;
    id: string;
    body: string;
    author?: string;
  }): Promise<void> {
    this.current = await this.cli.replyToComment(input);
  }

  async replyToNote(input: {
    file: string;
    note: string;
    body: string;
    author?: string;
  }): Promise<void> {
    this.current = await this.cli.replyToNote(input);
  }

  async setNoteStatus(file: string, note: string, status: "active" | "resolved"): Promise<void> {
    this.current = await this.cli.setNoteStatus(file, note, status);
  }

  async setCommentStatus(file: string, id: string, status: "active" | "resolved"): Promise<void> {
    this.current = await this.cli.setCommentStatus(file, id, status);
  }

  async deleteComment(file: string, id: string): Promise<void> {
    this.current = await this.cli.deleteComment(file, id);
  }

  async setViewed(files: readonly string[], viewed: boolean): Promise<void> {
    this.current = await this.cli.setViewed(files, viewed);
  }
}

/** Count of files whose review is done, for the tree view's progress label. */
export function viewedProgress(files: ReviewFileState[]): { viewed: number; total: number } {
  return { viewed: files.filter((entry) => entry.viewed).length, total: files.length };
}
