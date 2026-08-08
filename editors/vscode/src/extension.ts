import * as vscode from "vscode";
import { HunkCli, type HunkRunner } from "./hunkCli";
import { HunkReviewError, type DiffSide, type ExportedFile } from "./reviewExport";
import { ReviewCommentSurface, type HunkComment } from "./reviewComments";
import { ReviewSession } from "./reviewSession";
import {
  reviewedPathsOf,
  ReviewTreeProvider,
  type ReviewFilter,
  type ReviewViewMode,
} from "./reviewTree";
import { ReviewDecorationProvider } from "./reviewDecorations";
import { sameReviewTarget } from "./reviewFocus";
import { ReviewSummaryView } from "./reviewSummaryView";
import {
  isReviewableExpression,
  parsePathspecInput,
  parseReviewTarget,
  targetLabel,
  type ReviewTarget,
} from "./reviewTarget";

/** Where the reviewer's last list/tree choice is remembered between windows. */
const VIEW_MODE_MEMENTO_KEY = "hunkReview.viewMode";
/** Where the reviewed changeset is remembered, so reopening resumes the same review. */
const TARGET_MEMENTO_KEY = "hunkReview.target";

/** Filename Hunk records an agent's pointer in, inside the repo's `.hunk/`. */
const REVIEW_FOCUS_FILENAME = "review-focus.json";

type PathspecReviewTarget = Extract<
  ReviewTarget,
  { kind: "working-tree" | "staged" | "range" | "show" }
>;

/** URI scheme serving reviewed file content from Hunk to the native diff editor. */
const PRE_IMAGE_SCHEME = "hunk-review";

/** Everything one open review owns, so a second `Open Review` replaces it cleanly. */
interface ActiveReview {
  session: ReviewSession;
  cli: HunkCli;
  /** The folder the user opened. This is what `--repo` points at. */
  workspaceRoot: string;
  /** The changeset this review covers, shown in the view header. */
  target: ReviewTarget;
  comments: ReviewCommentSurface;
}

let active: ActiveReview | null = null;
let tree: ReviewTreeProvider | null = null;
let treeView: vscode.TreeView<unknown> | null = null;
let decorations: ReviewDecorationProvider | null = null;
let summaryView: ReviewSummaryView | null = null;
/**
 * Invalidates the pre-image documents when the review reloads.
 *
 * VS Code caches virtual documents by URI, so without this a refresh after an edit leaves
 * the diff editor comparing the new file against a pre-image from the previous review.
 */
const preImageChanged = new vscode.EventEmitter<vscode.Uri>();

/** Test seam: lets the extension-host harness drive a scripted CLI instead of a binary. */
let runnerOverride: HunkRunner | undefined;

/**
 * The API `activate` returns to the extension host.
 *
 * Exists so the harness can drive a scripted CLI: the unit under test is this extension's
 * behavior against a payload, not the `hunk` binary, which has its own black-box coverage.
 */
export interface HunkReviewExtensionApi {
  __setHunkRunnerForTests(runner: HunkRunner | undefined): void;
  __getActiveReviewForTests(): ActiveReview | null;
}

/** Report one failure the way the user can act on it. */
function reportError(error: unknown): void {
  if (error instanceof HunkReviewError) {
    void vscode.window.showErrorMessage(error.message, { detail: error.detail, modal: false });
    return;
  }

  void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}

/** Run one review action, surfacing failures rather than letting them reject silently. */
async function guard(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    reportError(error);
  }
}

/** Resolve the folder the review is launched from. */
function resolveWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new HunkReviewError("Open a folder before starting a Hunk review.");
  }

  return folder.uri.fsPath;
}

/** Absolute on-disk URI for one repo-relative reviewed path. */
function workspaceUri(reviewRoot: string, path: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.file(reviewRoot), path);
}

/** URI whose content provider serves one side of a file, as Hunk sees it. */
function hunkSourceUri(path: string, side: DiffSide): vscode.Uri {
  return vscode.Uri.from({ scheme: PRE_IMAGE_SCHEME, path: `/${path}`, query: `side=${side}` });
}

/** The side a URI in our own scheme refers to; `old` is the pre-image default. */
function sideOfHunkUri(uri: vscode.Uri): DiffSide {
  return uri.query === "side=new" ? "new" : "old";
}

/**
 * The document one side of one file should be shown in.
 *
 * The new side is editable only when the export says it is the live workspace. Historical
 * and staged revisions have a real-looking "new" side too, but opening the workspace there
 * would compare the requested revision against unrelated current files. Hunk remains the
 * source of truth unless provenance explicitly grants the workspace side.
 */
function documentUri(review: ActiveReview, file: ExportedFile, side: DiffSide): vscode.Uri {
  return side === "new" &&
    file.changeType !== "deleted" &&
    review.session.export.sourceCapabilities?.new === "workspace"
    ? workspaceUri(review.session.reviewRoot(review.workspaceRoot), file.path)
    : hunkSourceUri(file.path, side);
}

/**
 * Where one anchored thing — a comment, an agent note — belongs.
 *
 * Every surface that places something at a line resolves through here, so a comment on a
 * deleted line lands in the pre-image beside the line it was written against instead of at
 * the same number in an unrelated new-side document.
 */
function anchorUri(path: string, side: DiffSide): vscode.Uri {
  const file = active?.session.files.find((entry) => entry.file.path === path)?.file;

  return active && file ? documentUri(active, file, side) : hunkSourceUri(path, side);
}

/**
 * Ask which changeset to review.
 *
 * Branch comparison is an input box rather than a list of refs on purpose: enumerating
 * branches means reading Git, and the extension is not allowed a second opinion about the
 * repository. It passes an expression through and lets Hunk resolve it.
 */
async function pickReviewTarget(current: ReviewTarget): Promise<ReviewTarget | undefined> {
  // Named `choice`, not `kind`: `kind` on a QuickPickItem is VS Code's separator marker.
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "Working tree",
        description: "uncommitted changes",
        choice: "working-tree" as const,
      },
      { label: "Staged changes", description: "the index", choice: "staged" as const },
      {
        label: "Compare with a branch…",
        description: "this branch since it left that one",
        choice: "branch" as const,
      },
      {
        label: "Custom range or revision…",
        description: "any target `hunk diff` accepts",
        choice: "custom" as const,
      },
      {
        label: "Show a revision…",
        description: "a committed snapshot, like `hunk show HEAD`",
        choice: "show" as const,
      },
      {
        label: "Show a stash entry…",
        description: "a saved worktree snapshot",
        choice: "stash-show" as const,
      },
    ],
    { title: "Review", placeHolder: `Currently reviewing ${targetLabel(current)}` },
  );

  if (!picked) {
    return undefined;
  }

  const pickPathspecs = async (
    base: PathspecReviewTarget,
  ): Promise<PathspecReviewTarget | undefined> => {
    const value = await vscode.window.showInputBox({
      title: "Limit paths (optional)",
      prompt: "Space-separated pathspecs; quote paths containing spaces",
      value: base.pathspecs?.join(" ") ?? "",
      validateInput: (input) =>
        input.trim().length === 0 || parsePathspecInput(input)
          ? undefined
          : "Enter valid space-separated pathspecs, or leave this blank.",
    });

    if (value === undefined) {
      return undefined;
    }

    if (value.trim().length === 0) {
      return base;
    }

    const pathspecs = parsePathspecInput(value);
    if (!pathspecs) {
      throw new HunkReviewError("The pathspec selection was not valid.");
    }

    return { ...base, pathspecs };
  };

  if (picked.choice === "working-tree" || picked.choice === "staged") {
    return pickPathspecs(
      picked.choice === "staged" ? { kind: "staged" } : { kind: "working-tree" },
    );
  }

  if (picked.choice === "show" || picked.choice === "stash-show") {
    const stash = picked.choice === "stash-show";
    const ref = await vscode.window.showInputBox({
      title: stash ? "Show stash entry" : "Show revision",
      prompt: stash ? "Stash ref (blank = latest)" : "Revision (blank = HEAD)",
      value:
        (stash && current.kind === "stash-show") || (!stash && current.kind === "show")
          ? (current.ref ?? "")
          : "",
      validateInput: (value) =>
        value.trim().length === 0 || isReviewableExpression(value)
          ? undefined
          : "Enter a revision. It cannot start with `-`.",
    });

    if (ref === undefined) {
      return undefined;
    }

    const normalizedRef = ref.trim();
    return stash
      ? { kind: "stash-show", ...(normalizedRef ? { ref: normalizedRef } : {}) }
      : pickPathspecs({
          kind: "show",
          ...(normalizedRef ? { ref: normalizedRef } : {}),
        });
  }

  const branchComparison = picked.choice === "branch";
  const expression = await vscode.window.showInputBox({
    title: branchComparison ? "Compare with branch" : "Review target",
    prompt: branchComparison
      ? "Changes on this branch since it diverged from"
      : "Any target `hunk diff` accepts, such as `main...HEAD` or `HEAD~3..HEAD`",
    value: branchComparison ? "main" : "",
    validateInput: (value) =>
      isReviewableExpression(value) ? undefined : "Enter a revision. It cannot start with `-`.",
  });

  if (!expression) {
    return undefined;
  }

  // Three dots, so a branch is compared against where it left its base rather than against
  // whatever that base has since become. That is the diff a pull request shows.
  return pickPathspecs({
    kind: "range",
    expression: branchComparison ? `${expression.trim()}...HEAD` : expression.trim(),
  });
}

/** Refresh every surface from the session's current payload. */
function renderReview(): void {
  if (!active) {
    return;
  }

  active.comments.render(active.session);
  decorations?.refresh();
  for (const { file } of active.session.files) {
    // Both sides: either can be a Hunk-served document, and a stale cached copy of either
    // makes the diff editor compare against the previous review.
    preImageChanged.fire(hunkSourceUri(file.path, "old"));
    preImageChanged.fire(hunkSourceUri(file.path, "new"));
  }
  tree?.refresh();
  if (treeView && tree) {
    // Drives which welcome content the empty view shows. Set from here rather than beside
    // each mutation so it can never describe a state the rows have already left.
    void vscode.commands.executeCommand("setContext", "hunkReview.empty", tree.emptyReason ?? "");
    summaryView?.setSummary(tree.summaryMessage);
    treeView.title = tree.progressLabel;
    // The target and any filter belong beside the progress, not inside it: a reviewer who
    // cannot see which changeset they are reading, or that rows are being hidden, has no way
    // to tell an empty review from a wrong one.
    treeView.description = [targetLabel(active.target), tree.filterLabel]
      .filter(Boolean)
      .join(" · ");
  }

  const unavailable = active.session.commentsUnavailableReason;
  if (unavailable) {
    // Never silently show an empty comment list for a store that exists but cannot be read.
    void vscode.window.showWarningMessage(
      `Hunk could not read your review comments: ${unavailable}`,
    );
  }
}

/**
 * Which reviewed file and side a document URI refers to, or nothing if it is not in review.
 *
 * The inverse of `documentUri`, and written as one: a workspace document is matched by
 * comparing against the URI the review itself built for each file. Deriving the key from
 * the path instead — with `asRelativePath`, which is relative to the opened folder rather
 * than the repository root — produces a different key than the export uses whenever the
 * workspace is a subdirectory of the repo, so the file opens correctly and then every write
 * against it is refused.
 */
function locateDocument(uri: vscode.Uri): { path: string; side: DiffSide } | undefined {
  if (!active) {
    return undefined;
  }

  if (uri.scheme === PRE_IMAGE_SCHEME) {
    const path = uri.path.replace(/^\//, "");
    return active.session.files.some((entry) => entry.file.path === path)
      ? { path, side: sideOfHunkUri(uri) }
      : undefined;
  }

  const match = active.session.files.find(
    (entry) => documentUri(active as ActiveReview, entry.file, "new").fsPath === uri.fsPath,
  );

  return match ? { path: match.file.path, side: "new" } : undefined;
}

/** Look up which reviewed file and line the active editor's cursor points at. */
function locateSelection(): { path: string; line: number; side: DiffSide } | undefined {
  const editor = vscode.window.activeTextEditor;
  const located = editor ? locateDocument(editor.document.uri) : undefined;

  return editor && located ? { ...located, line: editor.selection.active.line + 1 } : undefined;
}

/**
 * What one thread is a conversation about, when it is about anything yet.
 *
 * Three cases, and they take different write paths: a thread opened by an agent note answers
 * that note, a thread holding a persisted comment answers that comment, and a thread VS Code
 * just created for a fresh comment answers nothing and starts one. The first entry decides,
 * by construction — the surface renders the opening message followed by its replies — and a
 * reply is never mistaken for an opening, so a conversation stays one level deep.
 */
type ConversationTarget =
  | { kind: "note"; noteId: string; filePath: string }
  | { kind: "comment"; id: string; filePath: string };

function conversationTargetOf(thread: vscode.CommentThread): ConversationTarget | undefined {
  const opening = thread.comments[0] as Partial<HunkComment> | undefined;

  if (!opening?.filePath || opening.contextValue === "reply") {
    return undefined;
  }

  if (opening.noteId) {
    return { kind: "note", noteId: opening.noteId, filePath: opening.filePath };
  }

  return opening.commentId
    ? { kind: "comment", id: opening.commentId, filePath: opening.filePath }
    : undefined;
}

/** How long to wait for a compare pane to show up after `vscode.diff` resolves. */
const REVEAL_WAIT_MS = 2000;

/**
 * Put the cursor on one line of an already-open reviewed file.
 *
 * Resolved through `anchorUri` so a line an agent named against the old side lands in the
 * pre-image, beside the code it was talking about, rather than at the same number in an
 * unrelated new-side document (REQ-VSCODE-008).
 *
 * Polls briefly: `vscode.diff` can resolve before both panes are in `visibleTextEditors`,
 * and a silent miss would leave REQ-VSCODE-022's "reveal the line" half unfinished.
 */
async function revealLine(path: string, side: DiffSide, line: number | undefined): Promise<void> {
  if (line === undefined) {
    return;
  }

  const uri = anchorUri(path, side);
  const deadline = Date.now() + REVEAL_WAIT_MS;
  let editor: vscode.TextEditor | undefined;
  while (Date.now() < deadline) {
    editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === uri.toString(),
    );
    if (editor) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (!editor) {
    return;
  }

  // Clamped to the document: a stale focus naming a line past the end must land at the end
  // rather than throw and abandon the rest of the instruction.
  const target = new vscode.Position(
    Math.min(line - 1, Math.max(0, editor.document.lineCount - 1)),
    0,
  );
  editor.selection = new vscode.Selection(target, target);
  editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);

  // Compare editors activate the modified side by default; an old-side anchor must take the
  // primary pane or the reviewer still stares at the wrong half of the pair.
  if (side === "old") {
    await vscode.commands.executeCommand("workbench.action.compareEditor.focusPrimarySide");
  }
}

/**
 * Whether the active tab is already a side-by-side diff.
 *
 * Comment threads live on a single URI (the side they were resolved against). VS Code's
 * Comments panel opens that URI as a plain text tab. The review surface is the diff, so a
 * plain open of a reviewed document must be promoted — but only when the tab is not already
 * the review (or any) diff, or every click inside an open review would re-open the same pair.
 */
function activeTabIsTextDiff(): boolean {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab?.input instanceof vscode.TabInputTextDiff;
}

/**
 * Close orphan plain-text tabs for a URI in the active group only.
 *
 * Limited to the active group so a plain working-tree tab the reviewer kept open in another
 * group is not collateral damage of Comments-panel promotion.
 */
async function closePlainTabsFor(uri: vscode.Uri): Promise<void> {
  const target = uri.toString();
  const toClose = vscode.window.tabGroups.activeTabGroup.tabs.filter(
    (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === target,
  );

  if (toClose.length > 0) {
    await vscode.window.tabGroups.close(toClose);
  }
}

/**
 * Open the review side-by-side for one path.
 *
 * Throws on failure so callers that must not run cleanup after a failed open (promotion)
 * can await a real result. The palette/tree command wraps this in `guard`; promotion must
 * not, or a swallowed error would still close the plain tab the comment landed on.
 */
async function openReviewDiff(path: string): Promise<void> {
  const review = requireActive();
  const file = review.session.files.find((entry) => entry.file.path === path)?.file;

  if (!file) {
    throw new HunkReviewError(`\`${path}\` is not part of this Hunk review.`);
  }

  await vscode.commands.executeCommand(
    "vscode.diff",
    documentUri(review, file, "old"),
    documentUri(review, file, "new"),
    `${path} (Hunk review)`,
  );
}

/**
 * Re-route a plain open of a reviewed document into the review diff (REQ-VSCODE-022).
 *
 * Covers the Comments panel (and any other "open this URI" path): threads are anchored to one
 * side's document, so native reveal lands on a lone file. Opening the same path via the
 * sidebar already goes through `openReviewDiff`; this is the missing half.
 *
 * `closePlainTabsFor` runs only after a successful open — a failed `vscode.diff` must leave
 * the comment anchor open rather than leave the reviewer with neither surface.
 */
async function promoteReviewedEditorToDiff(editor: vscode.TextEditor): Promise<void> {
  if (!active || activeTabIsTextDiff()) {
    return;
  }

  const located = locateDocument(editor.document.uri);
  if (!located) {
    return;
  }

  // Capture before open replaces the editor; the Comments panel has already placed the
  // cursor on the anchored line.
  const line = editor.selection.active.line + 1;
  const sourceUri = editor.document.uri;

  await openReviewDiff(located.path);
  await revealLine(located.path, located.side, line);
  await closePlainTabsFor(sourceUri);
}

/**
 * The one reviewed path a command was invoked on, however VS Code delivered it.
 *
 * A command reachable from both a tree menu and the palette receives a `TreeItem` in the
 * first case and nothing in the second, while internal callers pass a path. Resolving all
 * three here is what keeps a menu contribution from silently disagreeing with its handler's
 * parameter type — the failure is invisible to the compiler, because the argument arrives
 * as `any` from VS Code.
 */
function reviewTargetPath(invokedOn: unknown): string | undefined {
  if (typeof invokedOn === "string") {
    return invokedOn;
  }

  // Exactly one, so a directory row never silently resolves to its first file.
  const paths = reviewedPathsOf(invokedOn);
  return paths.length === 1 ? paths[0] : undefined;
}

/** Require an open review before an action that depends on one. */
function requireActive(): ActiveReview {
  if (!active) {
    throw new HunkReviewError("No Hunk review is open.", "Run `Hunk: Open Review` first.");
  }

  return active;
}

/**
 * Apply one arrangement to the sidebar and remember it.
 *
 * The context key is what drives which toggle the view title offers, so it is set from the
 * same place the mode changes rather than alongside each call site — the two drifting apart
 * would leave the button offering the mode already in effect.
 */
async function applyViewMode(
  context: vscode.ExtensionContext,
  mode: ReviewViewMode,
): Promise<void> {
  tree?.setViewMode(mode);
  await context.workspaceState.update(VIEW_MODE_MEMENTO_KEY, mode);
  await vscode.commands.executeCommand("setContext", "hunkReview.viewMode", mode);
}

export function activate(context: vscode.ExtensionContext): HunkReviewExtensionApi {
  tree = new ReviewTreeProvider(null);
  treeView = vscode.window.createTreeView("hunkReview.files", { treeDataProvider: tree });
  context.subscriptions.push(treeView);

  summaryView = new ReviewSummaryView();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ReviewSummaryView.viewId, summaryView),
  );

  decorations = new ReviewDecorationProvider();
  context.subscriptions.push(decorations);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));

  const remembered = context.workspaceState.get<ReviewViewMode>(VIEW_MODE_MEMENTO_KEY);
  void applyViewMode(context, remembered === "tree" ? "tree" : "list");

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.viewAsTree", () =>
      guard(() => applyViewMode(context, "tree")),
    ),
    vscode.commands.registerCommand("hunkReview.viewAsList", () =>
      guard(() => applyViewMode(context, "list")),
    ),
  );

  // The pre-image comes from Hunk, not from git: each VCS backend owns its own object
  // reads, and reconstructing the old side here would only ever work for Git.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PRE_IMAGE_SCHEME, {
      onDidChange: preImageChanged.event,
      async provideTextDocumentContent(uri) {
        // A missing side is empty, not an error: that is exactly what an added file's old
        // side and a deleted file's new side are.
        return active
          ? ((await active.cli.fileSource(uri.path.replace(/^\//, ""), sideOfHunkUri(uri))) ?? "")
          : "";
      },
    }),
  );
  context.subscriptions.push(preImageChanged);

  /** Open (or reopen) the review for one target. */
  const openReview = async (target: ReviewTarget): Promise<void> => {
    const workspaceRoot = resolveWorkspaceRoot();
    const binaryPath = vscode.workspace.getConfiguration("hunkReview").get<string>("binaryPath");
    const cli = new HunkCli({
      repoRoot: workspaceRoot,
      target,
      ...(binaryPath ? { binaryPath } : {}),
      ...(runnerOverride ? { run: runnerOverride } : {}),
    });

    // Load and validate the replacement before touching the current review. A failed target
    // selection must leave the reviewer on the last known-good changeset, not on an empty
    // sidebar with every comment controller already disposed.
    const exported = await cli.export(false);
    const controller = vscode.comments.createCommentController("hunkReview", "Hunk Review");
    controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => [
        new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0),
      ],
    };

    const next: ActiveReview = {
      cli,
      workspaceRoot,
      target,
      session: new ReviewSession(cli, exported),
      comments: new ReviewCommentSurface(controller, anchorUri),
    };
    active?.comments.dispose();
    active = next;
    watchFocusRoot(active.session.reviewRoot(workspaceRoot));
    tree?.setSession(active.session);
    decorations?.setSession(active.session);
    // Drives the welcome view: an empty panel with no explanation is what a first-time
    // reviewer sees otherwise, and it looks like a broken extension rather than an idle one.
    await vscode.commands.executeCommand("setContext", "hunkReview.reviewOpen", true);
    renderReview();
  };

  /** Apply an agent's file pointer without turning a stale target into a hard failure. */
  const openFocusedLocation = async (
    path: string,
    side: DiffSide,
    line: number | undefined,
  ): Promise<void> => {
    const review = requireActive();
    const isInReview = review.session.files.some((entry) => entry.file.path === path);
    if (!isInReview) {
      const action = await vscode.window.showWarningMessage(
        `Focus points to \`${path}\`, but it is not part of the ${targetLabel(review.target)} review. Choose what to review to select another changeset.`,
        "Choose what to review",
      );
      if (action === "Choose what to review") {
        await vscode.commands.executeCommand("hunkReview.selectTarget");
      }
      return;
    }

    await vscode.commands.executeCommand("hunkReview.openFile", path);
    await revealLine(path, side, line);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.openReview", () =>
      guard(async () => {
        // An agent's standing instruction outranks the remembered target: it is the newer
        // statement of what this pair is reviewing, and it is why the file exists.
        const remembered = parseReviewTarget(context.workspaceState.get(TARGET_MEMENTO_KEY));
        let pointed = await readStandingFocus();
        await openReview(pointed?.target ?? remembered);

        // A workspace may be a subdirectory of the repository. Once export has resolved the
        // canonical root, check there too; this second probe only spawns Hunk when the file
        // actually exists, preserving the cheap no-focus open path.
        if (!pointed) {
          pointed = await readStandingFocus(
            requireActive().session.reviewRoot(resolveWorkspaceRoot()),
          );
          if (pointed && !sameReviewTarget(pointed.target, requireActive().target)) {
            await openReview(pointed.target);
          }
        }

        if (pointed) {
          appliedFocusRevision = pointed.revision;
          if (pointed.file) {
            await openFocusedLocation(pointed.file, pointed.side ?? "new", pointed.line);
          }
        }
      }),
    ),
    vscode.commands.registerCommand("hunkReview.selectTarget", () =>
      guard(async () => {
        const current =
          active?.target ?? parseReviewTarget(context.workspaceState.get(TARGET_MEMENTO_KEY));
        const target = await pickReviewTarget(current);
        if (!target) {
          return;
        }

        // Reopened rather than refreshed: a different target is a different changeset, so
        // every anchor, viewed flag, and open diff belongs to a review that no longer exists.
        await openReview(target);
        // Remember only a target that actually loaded. A failed replacement must not make the
        // next open attempt resume a changeset the user never saw.
        await context.workspaceState.update(TARGET_MEMENTO_KEY, target);
      }),
    ),
  );

  /**
   * Follow wherever an agent points this reviewer.
   *
   * Hunk is a pairing tool, so the agent that wrote the notes should be able to say "read
   * this changeset, starting at this line" without the human re-deriving it from chat. The
   * instruction arrives as a file in `.hunk/` rather than through the daemon: the daemon
   * needs a live TUI, and durable review state is the ratified spine.
   *
   * Applied without asking, per the reviewer's own choice. `revision` is what makes a
   * repeated instruction land — an agent pointing at the same line twice writes identical
   * content, which a content comparison would correctly call unchanged.
   */
  let appliedFocusRevision: number | undefined;
  let focusWatcher: vscode.FileSystemWatcher | undefined;

  const watchFocusRoot = (root: string): void => {
    focusWatcher?.dispose();
    focusWatcher = vscode.workspace.createFileSystemWatcher(
      // Hunk has already resolved the canonical root in the export. Watching that root keeps
      // an opened subdirectory from missing an agent instruction stored at the repository root.
      new vscode.RelativePattern(vscode.Uri.file(root), `.hunk/${REVIEW_FOCUS_FILENAME}`),
    );
    context.subscriptions.push(focusWatcher);
    focusWatcher.onDidCreate(followFocus, undefined, context.subscriptions);
    focusWatcher.onDidChange(followFocus, undefined, context.subscriptions);
    focusWatcher.onDidDelete(followFocus, undefined, context.subscriptions);
  };

  /**
   * Read the standing instruction before any review is open.
   *
   * Needs its own client because there is no active review to borrow one from yet. The
   * target it is built with is irrelevant — `focus get` reads a pointer, not a changeset —
   * and a repo with no focus is the ordinary case, so a failure here must never stop the
   * review from opening on the remembered target instead.
   */
  const readStandingFocus = async (root = resolveWorkspaceRoot()) => {
    try {
      // Existence first, then the CLI. Most repos are never pointed anywhere, and opening a
      // review must not pay for a process spawn to learn that. Before export, the opened folder
      // is the only root we can identify without parsing VCS state; after export the caller
      // checks the canonical root Hunk reports.
      await vscode.workspace.fs.stat(
        vscode.Uri.joinPath(vscode.Uri.file(root), ".hunk", REVIEW_FOCUS_FILENAME),
      );

      const binaryPath = vscode.workspace.getConfiguration("hunkReview").get<string>("binaryPath");

      return await new HunkCli({
        repoRoot: root,
        ...(binaryPath ? { binaryPath } : {}),
        ...(runnerOverride ? { run: runnerOverride } : {}),
      }).focus();
    } catch {
      return null;
    }
  };

  const followFocus = () =>
    guard(async () => {
      const review = active;
      if (!review) {
        return;
      }

      const focus = await review.cli.focus();
      if (!focus || focus.revision === appliedFocusRevision) {
        return;
      }

      appliedFocusRevision = focus.revision;

      if (!sameReviewTarget(focus.target, review.target)) {
        await context.workspaceState.update(TARGET_MEMENTO_KEY, focus.target);
        await openReview(focus.target);
      }

      if (focus.file) {
        await openFocusedLocation(focus.file, focus.side ?? "new", focus.line);
      }
    });

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.followFocus", followFocus),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.refresh", () =>
      guard(async () => {
        await requireActive().session.refresh();
        renderReview();
      }),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.filter", () =>
      guard(async () => {
        const choices: (vscode.QuickPickItem & { filter: ReviewFilter })[] = [
          { label: "All files", filter: "all" },
          { label: "Unviewed only", filter: "unviewed" },
          { label: "With unresolved comments", filter: "commented" },
          { label: "With agent notes", filter: "annotated" },
        ];
        const picked = await vscode.window.showQuickPick(choices, {
          title: "Show",
          placeHolder: "Which files the sidebar lists",
        });

        if (picked) {
          tree?.setFilter(picked.filter);
          renderReview();
        }
      }),
    ),
    // The way out of a filter that hid everything, offered by the empty view itself.
    vscode.commands.registerCommand("hunkReview.showAllFiles", () =>
      guard(async () => {
        tree?.setFilter("all");
        renderReview();
      }),
    ),
  );

  /**
   * Open the next unviewed file, wrapping, so a review can be walked end to end.
   *
   * Walks the whole review rather than the rows the filter admits, matching the progress
   * counter: a reviewer who filtered to one slice and then walked it to the end would
   * otherwise be told the review is done while files outside the filter sit unviewed.
   */
  const goToUnviewed = (step: 1 | -1) =>
    guard(async () => {
      const review = requireActive();
      const files = review.session.files;
      const here = locateSelection()?.path;
      const current = here ? files.findIndex((entry) => entry.file.path === here) : -1;
      // With no file open, step forward from before the first and back from past the last.
      const start = current >= 0 ? current : step === 1 ? -1 : files.length;

      // Bounded by the file count: every candidate is tried exactly once, so a review with
      // nothing left unviewed reports that instead of looping.
      for (let offset = 1; offset <= files.length; offset += 1) {
        const index = (((start + step * offset) % files.length) + files.length) % files.length;
        const candidate = files[index];
        if (candidate && !candidate.viewed) {
          await vscode.commands.executeCommand("hunkReview.openFile", candidate.file.path);
          return;
        }
      }

      void vscode.window.showInformationMessage("Every file in this review is marked viewed.");
    });

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.nextUnviewed", () => goToUnviewed(1)),
    vscode.commands.registerCommand("hunkReview.previousUnviewed", () => goToUnviewed(-1)),
  );

  /** Mark a set of files viewed or unviewed in one write. */
  const markViewed = (paths: readonly string[], viewed: boolean) =>
    guard(async () => {
      const review = requireActive();
      if (paths.length === 0) {
        return;
      }

      await review.session.setViewed(paths, viewed);
      renderReview();
    });

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.markFolderViewed", (item: unknown) =>
      markViewed(reviewedPathsOf(item), true),
    ),
    vscode.commands.registerCommand("hunkReview.markFolderUnviewed", (item: unknown) =>
      markViewed(reviewedPathsOf(item), false),
    ),
    vscode.commands.registerCommand("hunkReview.markAllViewed", () =>
      markViewed(active?.session.files.map((entry) => entry.file.path) ?? [], true),
    ),
    vscode.commands.registerCommand("hunkReview.markAllUnviewed", () =>
      markViewed(active?.session.files.map((entry) => entry.file.path) ?? [], false),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.openFile", (path: string) =>
      guard(async () => {
        await openReviewDiff(path);
      }),
    ),
  );

  // Comments panel / "open URI" reveal opens the thread's single-document anchor. While a
  // review is open, promote that plain tab into the review diff so the reviewer keeps the
  // change context the note or comment is about (REQ-VSCODE-022).
  //
  // Latest-wins queue, not a hard drop lock: rapid Comments navigation (A then B) must end
  // on B's promote, not leave B as an unpromoted plain tab because A was still in flight.
  let promoteInFlight = false;
  let queuedPromoteEditor: vscode.TextEditor | undefined;

  const flushPromoteQueue = async (): Promise<void> => {
    if (promoteInFlight) {
      return;
    }
    promoteInFlight = true;
    try {
      while (queuedPromoteEditor) {
        const editor = queuedPromoteEditor;
        queuedPromoteEditor = undefined;
        try {
          await promoteReviewedEditorToDiff(editor);
        } catch (error) {
          reportError(error);
        }
      }
    } finally {
      promoteInFlight = false;
    }
    // Something may have queued between the last while-check and clearing the flag.
    if (queuedPromoteEditor) {
      await flushPromoteQueue();
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        return;
      }

      queuedPromoteEditor = editor;
      void flushPromoteQueue();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.toggleViewed", (invokedOn?: unknown) =>
      guard(async () => {
        const review = requireActive();
        // A tree menu command is handed the row, not a path: the inline check mark passed a
        // `ReviewFileItem` into a parameter typed `string`, so the lookup compared a path
        // against an object, never matched, and told the user to select a file they had
        // just clicked. Every caller now resolves through one function.
        const target = reviewTargetPath(invokedOn) ?? locateSelection()?.path;
        const state = review.session.files.find((entry) => entry.file.path === target);

        if (!state) {
          throw new HunkReviewError("Select a file in the Hunk review first.");
        }

        await review.session.setViewed([state.file.path], !state.viewed);
        renderReview();
      }),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "hunkReview.addComment",
      (reply: vscode.CommentReply | undefined) =>
        guard(async () => {
          const review = requireActive();
          const repliedTo = reply ? locateDocument(reply.thread.uri) : undefined;
          const located = repliedTo
            ? { ...repliedTo, line: (reply?.thread.range?.start.line ?? 0) + 1 }
            : locateSelection();

          if (!located) {
            throw new HunkReviewError("Put the cursor on a line inside a reviewed file first.");
          }

          const body =
            reply?.text ??
            (await vscode.window.showInputBox({ prompt: `Comment on ${located.path}` }));
          if (!body) {
            return;
          }

          // VS Code spells "reply", "answer an agent note", and "new comment on an empty
          // thread" as the same command, so the thread's existing content is what tells them
          // apart. Writing any of them as a new root would put a second conversation on the
          // line instead of an answer in the one the user typed into.
          const answering = reply ? conversationTargetOf(reply.thread) : undefined;

          if (answering?.kind === "note") {
            await review.session.replyToNote({
              file: answering.filePath,
              note: answering.noteId,
              body,
            });
          } else if (answering) {
            await review.session.replyToComment({
              file: answering.filePath,
              id: answering.id,
              body,
            });
          } else {
            await review.session.addComment({
              file: located.path,
              side: located.side,
              line: located.line,
              body,
            });
          }

          reply?.thread.dispose();
          renderReview();
        }),
    ),
  );

  // Resolving and reopening are one operation with two arguments, registered as two commands
  // only because a menu entry cannot compute its own. A review that could close a
  // conversation but never reopen one would make a misclick permanent, leaving deletion —
  // which destroys the discussion — as the only way back.
  for (const [command, status] of [
    ["hunkReview.resolveComment", "resolved"],
    ["hunkReview.unresolveComment", "active"],
  ] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, (comment: HunkComment) =>
        guard(async () => {
          const review = requireActive();

          // An agent note is resolved by naming the note. Hunk opens the conversation that
          // records it, so the reviewer never has to say something just to mark a note read.
          if (comment?.noteId) {
            await review.session.setNoteStatus(comment.filePath, comment.noteId, status);
            renderReview();
            return;
          }

          if (!comment?.commentId) {
            throw new HunkReviewError("This comment cannot be resolved.");
          }

          await review.session.setCommentStatus(comment.filePath, comment.commentId, status);
          renderReview();
        }),
      ),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("hunkReview.deleteComment", (comment: HunkComment) =>
      guard(async () => {
        const review = requireActive();
        if (!comment?.commentId) {
          throw new HunkReviewError("Agent notes cannot be deleted.");
        }

        await review.session.deleteComment(comment.filePath, comment.commentId);
        renderReview();
      }),
    ),
  );

  return {
    __setHunkRunnerForTests: (runner) => {
      runnerOverride = runner;
    },
    __getActiveReviewForTests: () => active,
  };
}

export function deactivate(): void {
  active?.comments.dispose();
  active = null;
  decorations?.setSession(null);
}
