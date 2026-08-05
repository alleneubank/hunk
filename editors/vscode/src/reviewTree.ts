import * as vscode from "vscode";
import { decoratedUri } from "./reviewDecorations";
import type { ReviewFileState, ReviewSession } from "./reviewSession";
import { viewedProgress } from "./reviewSession";

/**
 * How the sidebar arranges the review.
 *
 * `list` is the review's own order — the sidecar's narrative sequence, which is authored
 * and therefore meaningful. `tree` trades that ordering for the shape of the repository.
 * Neither is a better default for every changeset, which is why this is a toggle rather
 * than a replacement: a 60-file branch is easier to navigate by folder, and a hand-ordered
 * agent review is easier to follow in the order it was written.
 */
export type ReviewViewMode = "list" | "tree";

/**
 * Which files the sidebar shows.
 *
 * A filter hides work, so the view always says one is on (see `filterLabel`). Silently
 * showing a subset is how a reviewer concludes a branch is smaller than it is.
 */
export type ReviewFilter = "all" | "unviewed" | "commented" | "annotated";

/**
 * Which kind of nothing the sidebar is showing.
 *
 * `no-changes` is the target itself being empty; `filtered` is the reviewer's own filter
 * hiding every row. Naming them apart is what lets the empty view offer the action that
 * actually helps rather than a generic shrug.
 */
export type ReviewEmptyReason = "no-changes" | "filtered";

/** Reviewed paths are repo-relative and always POSIX-separated, whatever the host OS. */
const PATH_SEPARATOR = "/";

/** The last segment of a repo-relative path. */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf(PATH_SEPARATOR) + 1);
}

/** Tree item for one reviewed file. */
export class ReviewFileItem extends vscode.TreeItem {
  constructor(
    readonly state: ReviewFileState,
    // Full path in list mode; the file name alone once a directory row carries the rest.
    label: string = state.file.path,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    const unresolved = state.comments.filter((comment) => comment.status !== "resolved").length;
    const outdated = state.comments.filter((comment) => comment.outdated).length;

    this.id = state.file.id;
    // The review's own scheme, so the decoration provider badges this row without also
    // stamping Hunk's opinion onto the explorer entry and editor tab for the same file.
    // The path keeps its real extension, which is also what the icon theme resolves against.
    this.resourceUri = decoratedUri(state.file.path);
    // The workspace's own file icons, not a generic diff glyph: a reviewer already reads
    // this repo by those icons everywhere else, and a column of identical marks carries no
    // information. Viewed state is the row's badge, which is where VS Code puts it.
    this.iconPath = vscode.ThemeIcon.File;
    this.description = [
      `+${state.file.additions} −${state.file.deletions}`,
      unresolved > 0 ? `${unresolved} comment${unresolved === 1 ? "" : "s"}` : undefined,
      // Surfaced in the tree, not only in the editor: an outdated comment the reviewer
      // never opens the file for would otherwise be invisible (REQ-VSCODE-005).
      outdated > 0 ? `${outdated} outdated` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    this.contextValue = state.viewed ? "hunkFile.viewed" : "hunkFile.unviewed";
    // Why this file is in the change, on hover — the row itself stays scannable.
    this.tooltip = state.file.agentSummary
      ? new vscode.MarkdownString(`**${state.file.path}**\n\n${state.file.agentSummary}`)
      : state.file.path;
    this.command = {
      command: "hunkReview.openFile",
      title: "Open Diff",
      arguments: [state.file.path],
    };
  }
}

/** Tree item for one directory holding reviewed files. */
export class ReviewDirectoryItem extends vscode.TreeItem {
  constructor(
    readonly path: string,
    label: string,
    readonly children: ReviewTreeItem[],
    files: readonly ReviewFileState[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);

    const additions = files.reduce((total, state) => total + state.file.additions, 0);
    const deletions = files.reduce((total, state) => total + state.file.deletions, 0);

    // Stable across refreshes so VS Code can restore which folders the reviewer collapsed.
    this.id = `directory:${path}`;
    this.description = `+${additions} −${deletions}`;
    this.contextValue = "hunkDirectory";
  }
}

export type ReviewTreeItem = ReviewFileItem | ReviewDirectoryItem;

/**
 * Every reviewed path one row stands for.
 *
 * A directory row stands for its whole subtree, which is what makes "mark this folder
 * viewed" one write rather than a walk the caller has to do itself.
 */
export function reviewedPathsOf(item: unknown): string[] {
  if (item instanceof ReviewFileItem) {
    return [item.state.file.path];
  }

  return item instanceof ReviewDirectoryItem ? item.children.flatMap(reviewedPathsOf) : [];
}

/** One directory while the tree is being assembled, before it becomes tree items. */
interface DirectoryDraft {
  path: string;
  /** Insertion-ordered, so a directory appears where its first reviewed file appears. */
  directories: Map<string, DirectoryDraft>;
  files: ReviewFileState[];
}

function createDirectoryDraft(path: string): DirectoryDraft {
  return { path, directories: new Map(), files: [] };
}

/**
 * Group reviewed files by directory.
 *
 * Recursion is bounded by path depth: every level consumes exactly one path segment, and a
 * path has finitely many.
 */
function buildDirectoryDraft(states: readonly ReviewFileState[]): DirectoryDraft {
  const root = createDirectoryDraft("");

  for (const state of states) {
    const segments = state.file.path.split(PATH_SEPARATOR);
    // The file name itself is not a directory level.
    segments.pop();

    let cursor = root;
    for (const segment of segments) {
      const childPath = cursor.path ? `${cursor.path}${PATH_SEPARATOR}${segment}` : segment;
      const existing = cursor.directories.get(segment);
      const child = existing ?? createDirectoryDraft(childPath);

      if (!existing) {
        cursor.directories.set(segment, child);
      }

      cursor = child;
    }

    cursor.files.push(state);
  }

  return root;
}

/**
 * Collapse a chain of directories that hold nothing but one another into a single row.
 *
 * Without this, a changeset touching `src/ui/hooks/useViewedStatePersistence.ts` costs three
 * rows of nothing before the file appears. This is what the file explorer's compact folders
 * do, and a review tree needs it more: changed files cluster in deep, narrow paths.
 */
function compactDirectory(draft: DirectoryDraft): { label: string; directory: DirectoryDraft } {
  let directory = draft;
  const labels = [lastSegment(draft.path)];

  while (directory.files.length === 0 && directory.directories.size === 1) {
    const [onlyChild] = [...directory.directories.values()];
    if (!onlyChild) {
      break;
    }

    labels.push(lastSegment(onlyChild.path));
    directory = onlyChild;
  }

  return { label: labels.join(PATH_SEPARATOR), directory };
}

/** Every reviewed file at or below one directory. */
function directoryFiles(draft: DirectoryDraft): ReviewFileState[] {
  return [...draft.files, ...[...draft.directories.values()].flatMap(directoryFiles)];
}

/** Turn one assembled directory into its rows: directories first, then files. */
function toTreeItems(draft: DirectoryDraft): ReviewTreeItem[] {
  const directories = [...draft.directories.values()].map((child) => {
    const { label, directory } = compactDirectory(child);

    return new ReviewDirectoryItem(
      directory.path,
      label,
      toTreeItems(directory),
      directoryFiles(directory),
    );
  });

  // Directories first matches every file tree the reviewer already knows. Within each
  // group the review's own order survives, which is the most of it a tree can keep.
  return [
    ...directories,
    ...draft.files.map((state) => new ReviewFileItem(state, lastSegment(state.file.path))),
  ];
}

/** Sidebar listing every file in the review, in Hunk's order or grouped by directory. */
export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeItem> {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private mode: ReviewViewMode = "list";
  private filter: ReviewFilter = "all";

  constructor(private session: ReviewSession | null) {}

  setSession(session: ReviewSession | null): void {
    this.session = session;
    this.refresh();
  }

  get activeFilter(): ReviewFilter {
    return this.filter;
  }

  setFilter(filter: ReviewFilter): void {
    if (filter === this.filter) {
      return;
    }

    this.filter = filter;
    this.refresh();
  }

  get viewMode(): ReviewViewMode {
    return this.mode;
  }

  setViewMode(mode: ReviewViewMode): void {
    if (mode === this.mode) {
      return;
    }

    this.mode = mode;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** Every file in the review, whatever the filter hides. */
  getTreeData(): ReviewFileState[] {
    return this.session?.files ?? [];
  }

  /** The files the current filter admits, in review order. */
  visibleFiles(): ReviewFileState[] {
    const session = this.session;
    if (!session || this.filter === "all") {
      return this.getTreeData();
    }

    return this.getTreeData().filter((state) => {
      if (this.filter === "unviewed") {
        return !state.viewed;
      }

      return this.filter === "commented"
        ? state.comments.some((comment) => comment.status !== "resolved")
        : session.notesFor(state.file.path).length > 0;
    });
  }

  getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
    if (element) {
      return element instanceof ReviewDirectoryItem ? element.children : [];
    }

    const states = this.visibleFiles();
    // No rows at all when there is nothing to review, rather than a summary row standing
    // alone: that sentence describes files that are not on screen, and it is what makes an
    // empty target read as a broken review. Returning nothing is what lets VS Code show the
    // welcome content that says which kind of empty this is.
    if (states.length === 0) {
      return [];
    }

    return this.mode === "tree"
      ? toTreeItems(buildDirectoryDraft(states))
      : states.map((state) => new ReviewFileItem(state));
  }

  /**
   * The agent's account of the whole change, for the view's message area.
   *
   * Not a tree row: a row is one clipped line with no wrapping, which turned a paragraph
   * into `Adds a durable local review contract and the VS Code client that con…`. The
   * message area wraps, so the summary is readable at any panel width. It is withheld when
   * there are no files, because it would then describe a change that is not on screen.
   */
  get summaryMessage(): string | undefined {
    return this.visibleFiles().length === 0 ? undefined : this.session?.export.review.agentSummary;
  }

  /**
   * Why the sidebar has no rows, or nothing when it has some.
   *
   * The two emptinesses need different words because they need different actions: one is
   * fixed by choosing another target, the other by clearing the filter. An open review with
   * no files is never reported before a review has been opened at all — that state has its
   * own welcome content, and calling it "no changes" would describe a review never run.
   */
  get emptyReason(): ReviewEmptyReason | undefined {
    if (!this.session) {
      return undefined;
    }

    if (this.getTreeData().length === 0) {
      return "no-changes";
    }

    return this.visibleFiles().length === 0 ? "filtered" : undefined;
  }

  /** Label showing review progress, mirroring Hunk's own viewed counter. */
  get progressLabel(): string {
    // Counted over the whole review, never over what the filter admits: progress that moves
    // because a filter changed would be measuring the sidebar rather than the review.
    const { viewed, total } = viewedProgress(this.getTreeData());
    return total === 0 ? "Hunk Review" : `Hunk Review — ${viewed}/${total} viewed`;
  }

  /** How the header names the active filter, or nothing when everything is shown. */
  get filterLabel(): string | undefined {
    switch (this.filter) {
      case "unviewed":
        return "unviewed only";
      case "commented":
        return "with comments";
      case "annotated":
        return "with agent notes";
      default:
        return undefined;
    }
  }
}
