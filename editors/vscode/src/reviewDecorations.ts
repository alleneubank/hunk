import * as vscode from "vscode";
import type { ReviewSession } from "./reviewSession";

/**
 * Badges the sidebar rows with review state.
 *
 * Scoped to the rows' own URIs, which are repo-relative paths rather than workspace files:
 * decorating the real file would put Hunk's badge on the explorer and on editor tabs, where
 * it would sit beside Git's own decoration for the same file saying something different.
 * Review state belongs to the review.
 */
export const REVIEW_DECORATION_SCHEME = "hunk-review-file";

/** The URI a sidebar row is decorated by. */
export function decoratedUri(path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REVIEW_DECORATION_SCHEME, path: `/${path}` });
}

export class ReviewDecorationProvider implements vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private session: ReviewSession | null = null;

  setSession(session: ReviewSession | null): void {
    this.session = session;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== REVIEW_DECORATION_SCHEME || !this.session) {
      return undefined;
    }

    const path = uri.path.replace(/^\//, "");
    const state = this.session.files.find((entry) => entry.file.path === path);
    if (!state) {
      return undefined;
    }

    const unresolved = state.comments.filter((comment) => comment.status !== "resolved").length;
    if (unresolved > 0) {
      // Comments outrank viewed: a file marked done that still holds an unanswered comment
      // is exactly the one a reviewer must not lose track of.
      return new vscode.FileDecoration(
        String(Math.min(unresolved, 99)),
        `${unresolved} unresolved comment${unresolved === 1 ? "" : "s"}`,
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      );
    }

    return state.viewed
      ? new vscode.FileDecoration(
          "✓",
          "Viewed",
          new vscode.ThemeColor("gitDecoration.ignoredResourceForeground"),
        )
      : undefined;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
