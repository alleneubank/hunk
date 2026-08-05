import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { resolveConfiguredCliInput } from "../core/config";
import {
  clearReviewFocus,
  readReviewFocus,
  writeReviewFocus,
  type ReviewFocus,
  type ReviewFocusTarget,
} from "../core/reviewFocus";
import { HunkUserError, isUserFacingError } from "../core/errors";
import { captureReviewCommentAnchor } from "../core/reviewCommentAnchor";
import {
  isReviewCommentReply,
  isReviewRootComment,
  mutateReviewComments,
  type ReviewComment,
  type ReviewCommentReply,
  type ReviewCommentsStore,
  type ReviewRootComment,
} from "../core/reviewComments";
import { buildSidecarReviewNotes } from "../session/app/reviewNotes";
import type { SessionReviewNoteSummary } from "../session/types";
import { buildReviewExport, type ReviewExport } from "../core/reviewExport";
import {
  resolveReviewCommentsPath,
  resolveReviewStoreRepoRoot,
  resolveViewedStatePath,
} from "../core/reviewStore";
import { fileSideExists } from "../core/fileSource";
import { resolveRuntimeCliInput } from "../core/terminal";
import type { DiffSide } from "../core/liveComments";
import type { AppBootstrap, DiffFile, ReviewCommandInput, ReviewOperation } from "../core/types";
import { buildNextViewedState, mutateViewedState, resolveViewedPaths } from "../core/viewedState";
import { loadStartupExtensions } from "../extensions/startup";
import { loadConfiguredSessionBootstrap } from "./sessionBootstrap";

export interface ReviewCommandDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  newCommentId?: () => string;
  readStdinText?: () => Promise<string>;
  resolveConfiguredCliInputImpl?: typeof resolveConfiguredCliInput;
  loadStartupExtensionsImpl?: typeof loadStartupExtensions;
  loadConfiguredSessionBootstrapImpl?: typeof loadConfiguredSessionBootstrap;
}

/**
 * Result of one review operation.
 *
 * A union rather than one shape with optional fields: reading a file's full text produces
 * text, not a review, and folding both into one record would let a caller ask a
 * `file-source` result for a file list that was never built.
 */
export type ReviewCommandResult =
  | {
      kind: "review";
      operation: ReviewOperation["name"];
      /** Present for `comment-add`, so a client learns the id it must use later. */
      commentId?: string;
      review: ReviewExport;
    }
  | {
      kind: "file-source";
      path: string;
      side: DiffSide;
      /** Null when the side does not exist — an added file has no old side. */
      text: string | null;
    }
  | {
      kind: "focus";
      /** Null when nothing is being pointed at, which a cleared focus also is. */
      focus: ReviewFocus | null;
    };

/**
 * Load one review headlessly.
 *
 * Runs the same config resolution, extension loading, and changeset pipeline the
 * interactive commands run — an extension-contributed VCS backend or changeset transform
 * must not change what a review looks like just because no TTY is attached. Nothing here
 * opens a terminal, registers a session, or contacts the daemon.
 */
async function loadHeadlessReview(command: ReviewCommandInput, deps: ReviewCommandDeps) {
  const resolveConfiguredCliInputImpl =
    deps.resolveConfiguredCliInputImpl ?? resolveConfiguredCliInput;
  const loadStartupExtensionsImpl = deps.loadStartupExtensionsImpl ?? loadStartupExtensions;
  const loadConfiguredSessionBootstrapImpl =
    deps.loadConfiguredSessionBootstrapImpl ?? loadConfiguredSessionBootstrap;
  const env = deps.env ?? process.env;
  // `--repo` is resolved against the caller's cwd, then used as the cwd for every layer, so
  // config discovery, VCS detection, and changeset loading all agree on one directory.
  const cwd = command.repo
    ? resolve(deps.cwd ?? process.cwd(), command.repo)
    : (deps.cwd ?? process.cwd());

  const configured = resolveConfiguredCliInputImpl(resolveRuntimeCliInput(command.input), {
    cwd,
    env,
  });
  const extensions = await loadStartupExtensionsImpl({
    extensions: configured.extensions,
    cwd,
    env,
    cliExtensionPaths: configured.input.options.extensionPaths,
  });
  const { bootstrap } = await loadConfiguredSessionBootstrapImpl({
    configured,
    cwd,
    extensions,
    loadAtCwd: true,
  });

  return { bootstrap, repoRoot: resolveReviewStoreRepoRoot(bootstrap) };
}

/**
 * Find the reviewed file one operation targets.
 *
 * A write against a file that is not in the changeset is refused rather than accepted: an
 * anchor needs that file's patch, and viewed state is keyed on its patch hash, so silently
 * accepting an unknown path would persist an entry nothing can ever resolve.
 */
function requireReviewedFile(bootstrap: AppBootstrap, path: string): DiffFile {
  const file = bootstrap.changeset.files.find(
    (candidate) => candidate.path === path || candidate.previousPath === path,
  );

  if (!file) {
    throw new HunkUserError(`\`${path}\` is not part of this review.`, [
      "Run `hunk review export --json` to list the files this review contains.",
    ]);
  }

  return file;
}

/** Require a repo-backed review, since every write targets a repo-local `.hunk/` store. */
function requireRepoRoot(repoRoot: string | null): string {
  if (!repoRoot) {
    throw new HunkUserError("This review is not backed by a repository working tree.", [
      "Run `hunk review` inside a repository, or pass --repo <path>.",
    ]);
  }

  return repoRoot;
}

/** Apply one comment mutation, converting a strict-preserve refusal into a clean failure. */
function mutateComments(
  repoRoot: string,
  mutate: (store: ReviewCommentsStore) => ReviewCommentsStore,
): void {
  const result = mutateReviewComments(resolveReviewCommentsPath(repoRoot), mutate);

  if (result.kind === "unavailable") {
    // The store was left byte-intact; surfacing the reason is the whole point of refusing.
    throw new HunkUserError(result.reason, [
      "Fix or move the file, then retry. Hunk never overwrites a comment store it cannot read.",
    ]);
  }

  if (result.kind === "contended") {
    // A different remedy from `unavailable`: nothing is broken, so the client just retries.
    throw new HunkUserError(result.reason, [
      "Retry the command. Hunk refuses to write a comment store it does not hold the lock on.",
    ]);
  }
}

/** Add one comment, anchored against the file's current patch. */
function addComment(
  repoRoot: string,
  file: DiffFile,
  operation: Extract<ReviewOperation, { name: "comment-add" }>,
  body: string,
  deps: ReviewCommandDeps,
): string {
  const anchor = captureReviewCommentAnchor(file.patch, operation.side, operation.line);

  if (!anchor) {
    throw new HunkUserError(
      `Line ${operation.line} is not on the ${operation.side} side of \`${file.path}\` in this review.`,
      ["Comments anchor to lines the diff actually contains."],
    );
  }

  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const id = (deps.newCommentId ?? randomUUID)();
  const comment: ReviewComment = {
    id,
    anchor,
    body,
    ...(operation.author ? { author: operation.author } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "active",
  };

  mutateComments(repoRoot, (store) => ({
    ...store,
    files: {
      ...store.files,
      [file.path]: [...(store.files[file.path] ?? []), comment],
    },
  }));

  return id;
}

/**
 * Add one reply to an existing comment.
 *
 * The reply is written under the same lock as any other mutation and carries no anchor of
 * its own — where it appears is entirely its root's business. Replying to a reply is refused
 * rather than silently re-pointed at the root, which keeps a conversation exactly one level
 * deep by construction: no client ever has to render, or bound, a tree.
 */
function replyToComment(
  repoRoot: string,
  file: DiffFile,
  operation: Extract<ReviewOperation, { name: "comment-reply" }>,
  body: string,
  deps: ReviewCommandDeps,
): string {
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const id = (deps.newCommentId ?? randomUUID)();

  mutateComments(repoRoot, (store) => {
    const parent = requireComment(store, file.path, operation.id);

    if (isReviewCommentReply(parent)) {
      throw new HunkUserError(`\`${operation.id}\` is itself a reply.`, [
        `Reply to the comment it answers: \`${parent.parentId}\`.`,
      ]);
    }

    const reply: ReviewCommentReply = {
      id,
      parentId: parent.id,
      body,
      ...(operation.author ? { author: operation.author } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return {
      ...store,
      files: { ...store.files, [file.path]: [...(store.files[file.path] ?? []), reply] },
    };
  });

  return id;
}

/**
 * Find the note one operation names, in the changeset as it exists right now.
 *
 * Looked up by `noteId` because that is what the client just read off the same payload, and
 * carried forward as `noteKey` because that is what survives being written down — see
 * `reviewNoteKey`. Every note operation crosses that boundary exactly here.
 */
function requireReviewedNote(
  bootstrap: AppBootstrap,
  file: DiffFile,
  noteId: string,
): SessionReviewNoteSummary {
  const note = buildSidecarReviewNotes(bootstrap.changeset.files).find(
    (candidate) => candidate.noteId === noteId && candidate.filePath === file.path,
  );

  if (!note) {
    throw new HunkUserError(`No agent note \`${noteId}\` on \`${file.path}\`.`, [
      "Note ids are only valid within one review payload. Re-read the review and use the id it reports.",
    ]);
  }

  return note;
}

/**
 * The conversation about one note, opening it if this is the first thing said.
 *
 * A note is sidecar content Hunk never edits, so everything the reviewer adds — their answer,
 * and whether they are done with it — lives in an ordinary anchored comment tagged with the
 * note's key. The comment is created lazily: a note nobody has responded to costs nothing on
 * disk, which is what keeps a review of eighty annotated files from writing eighty rows the
 * moment it is opened.
 */
function openNoteConversation(
  store: ReviewCommentsStore,
  file: DiffFile,
  note: SessionReviewNoteSummary,
  body: string,
  timestamp: string,
  newId: () => string,
): { store: ReviewCommentsStore; root: ReviewRootComment } {
  const existing = (store.files[file.path] ?? [])
    .filter(isReviewRootComment)
    .find((comment) => comment.noteKey === note.noteKey);

  if (existing) {
    return { store, root: existing };
  }

  // The note's own range, so the conversation lands on the code the note is about. An anchor
  // is required rather than optional: it is what lets the answer follow the code when the
  // diff moves under it, exactly as any other comment does.
  const side: DiffSide = note.newRange ? "new" : "old";
  const line = (side === "new" ? note.newRange?.[0] : note.oldRange?.[0]) ?? 1;
  const anchor = captureReviewCommentAnchor(file.patch, side, line);

  if (!anchor) {
    throw new HunkUserError(
      `The note on \`${file.path}\` points at ${side}-side line ${line}, which this diff does not contain.`,
      ["The sidecar is describing a different version of this file than the review shows."],
    );
  }

  const root: ReviewRootComment = {
    id: newId(),
    anchor,
    noteKey: note.noteKey,
    body,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "active",
  };

  return {
    store: {
      ...store,
      files: { ...store.files, [file.path]: [...(store.files[file.path] ?? []), root] },
    },
    root,
  };
}

/** Require that one comment id exists on one file before mutating it. */
function requireComment(store: ReviewCommentsStore, path: string, id: string): ReviewComment {
  const comment = store.files[path]?.find((entry) => entry.id === id);

  if (!comment) {
    throw new HunkUserError(`No comment \`${id}\` on \`${path}\`.`);
  }

  return comment;
}

/**
 * Toggle one file's viewed state, preserving every other file's entry.
 *
 * The whole read-modify-write runs under the shared lock through `mutateViewedState`, the
 * same path the TUI writes on. Unlike the TUI, which treats review progress as best-effort
 * metadata, a failure here is reported — the client's whole contract is the result it gets
 * back, so a write that did not land must not look like one that did.
 */
function setViewed(
  repoRoot: string,
  bootstrap: AppBootstrap,
  paths: readonly string[],
  viewed: boolean,
  deps: ReviewCommandDeps,
): void {
  const files = bootstrap.changeset.files;
  const write = mutateViewedState(resolveViewedStatePath(repoRoot), (previous) => {
    // Start from what is already viewed rather than from empty: this command owns only the
    // named files' entries, and rewriting the set from scratch would silently unview the rest.
    const viewedPaths = new Set(resolveViewedPaths(files, previous));

    for (const path of paths) {
      if (viewed) {
        viewedPaths.add(path);
      } else {
        viewedPaths.delete(path);
      }
    }

    return buildNextViewedState(files, viewedPaths, previous, (deps.now ?? (() => new Date()))());
  });

  if (write.kind === "contended") {
    throw new HunkUserError(write.reason, ["Retry the command."]);
  }

  if (write.kind === "unavailable") {
    throw new HunkUserError(write.reason, [
      "Check that the review directory is writable, then retry.",
    ]);
  }
}

/** Read a comment body piped on stdin. */
function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

/**
 * Run one headless review operation and return the resulting review.
 *
 * Every operation ends by rebuilding the export, so a client always receives the state its
 * write produced rather than having to guess or re-query. Writes reuse the same store,
 * anchoring, and viewed-state code the TUI runs; nothing about a comment's placement is
 * decided here.
 */
/**
 * The changeset one review command names, in the shape a focus records.
 *
 * Read off the same parsed input every other operation runs against, so an agent that
 * points at `main...HEAD` records exactly the target `export main...HEAD` would open. The
 * expression is kept verbatim rather than resolved — see `ReviewFocusTarget`.
 */
function focusTargetOf(input: ReviewCommandInput["input"]): ReviewFocusTarget {
  if (input.kind !== "vcs") {
    return { kind: "working-tree" };
  }

  if (input.range) {
    return { kind: "range", expression: input.range };
  }

  return input.staged ? { kind: "staged" } : { kind: "working-tree" };
}

export async function runReviewCommand(
  command: ReviewCommandInput,
  deps: ReviewCommandDeps = {},
): Promise<ReviewCommandResult> {
  const { bootstrap, repoRoot } = await loadHeadlessReview(command, deps);
  const { operation } = command;
  let commentId: string | undefined;

  if (operation.name === "file-source") {
    const file = requireReviewedFile(bootstrap, operation.file);

    // A file with no fetcher is not a file with no content: this input source cannot read
    // full text at all. Reporting it as `null` would be indistinguishable from an added
    // file's absent old side, and a client that renders null as empty would show a
    // confidently blank document instead of the source it asked for.
    if (!file.sourceFetcher) {
      throw new HunkUserError(`This review cannot read the full source of \`${file.path}\`.`, [
        "Full-text reads need a repository-backed review; a review loaded from a patch or two files has no source to read.",
      ]);
    }

    // Read through the file's own fetcher so each VCS backend keeps owning object reads;
    // a client reconstructing the pre-image itself would only work for Git.
    const text = await file.sourceFetcher.getFullText(operation.side);

    // The fetcher answers `null` both for a side that does not exist and for one it could
    // not read, so the change kind decides which happened. Null on a side that should exist
    // is a failed read, and returning it would render as an empty document.
    if (text === null && fileSideExists(file.metadata.type, operation.side)) {
      throw new HunkUserError(`Could not read the ${operation.side} side of \`${file.path}\`.`, [
        "The file should have content on this side, so the read failed rather than finding none.",
      ]);
    }

    return { kind: "file-source", path: file.path, side: operation.side, text };
  }

  if (operation.name === "comment-add") {
    const root = requireRepoRoot(repoRoot);
    const file = requireReviewedFile(bootstrap, operation.file);
    const body = operation.body || (await (deps.readStdinText ?? readStdin)());

    if (!body.trim()) {
      throw new HunkUserError("A comment body cannot be empty.");
    }

    commentId = addComment(root, file, operation, body, deps);
  }

  if (operation.name === "comment-reply") {
    const root = requireRepoRoot(repoRoot);
    const file = requireReviewedFile(bootstrap, operation.file);
    const body = operation.body || (await (deps.readStdinText ?? readStdin)());

    if (!body.trim()) {
      throw new HunkUserError("A comment body cannot be empty.");
    }

    commentId = replyToComment(root, file, operation, body, deps);
  }

  if (operation.name === "note-reply") {
    const root = requireRepoRoot(repoRoot);
    const file = requireReviewedFile(bootstrap, operation.file);
    const note = requireReviewedNote(bootstrap, file, operation.note);
    const body = operation.body || (await (deps.readStdinText ?? readStdin)());

    if (!body.trim()) {
      throw new HunkUserError("A comment body cannot be empty.");
    }

    const timestamp = (deps.now ?? (() => new Date()))().toISOString();
    const newId = deps.newCommentId ?? randomUUID;
    const id = newId();
    commentId = id;

    mutateComments(root, (store) => {
      // The first thing said about a note becomes the conversation itself, so answering a
      // note never leaves an empty container behind. Anything after it is an ordinary reply.
      const opened = openNoteConversation(store, file, note, body, timestamp, () => id);
      if (opened.root.id === id) {
        return opened.store;
      }

      const reply: ReviewCommentReply = {
        id,
        parentId: opened.root.id,
        body,
        ...(operation.author ? { author: operation.author } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return {
        ...opened.store,
        files: {
          ...opened.store.files,
          [file.path]: [...(opened.store.files[file.path] ?? []), reply],
        },
      };
    });
  }

  if (operation.name === "note-status") {
    const root = requireRepoRoot(repoRoot);
    const file = requireReviewedFile(bootstrap, operation.file);
    const note = requireReviewedNote(bootstrap, file, operation.note);
    const timestamp = (deps.now ?? (() => new Date()))().toISOString();
    const newId = deps.newCommentId ?? randomUUID;

    mutateComments(root, (store) => {
      // Marking a note done before saying anything about it is the common case — most notes
      // are read and accepted. That opens the conversation with an empty body, which every
      // surface renders as the note alone carrying a resolved state.
      const opened = openNoteConversation(store, file, note, "", timestamp, newId);

      return {
        ...opened.store,
        files: {
          ...opened.store.files,
          [file.path]: (opened.store.files[file.path] ?? []).map((entry) =>
            entry.id === opened.root.id && isReviewRootComment(entry)
              ? { ...entry, status: operation.status, updatedAt: timestamp }
              : entry,
          ),
        },
      };
    });
  }

  if (operation.name === "comment-status") {
    const root = requireRepoRoot(repoRoot);
    const file = requireReviewedFile(bootstrap, operation.file);
    const updatedAt = (deps.now ?? (() => new Date()))().toISOString();

    mutateComments(root, (store) => {
      const target = requireComment(store, file.path, operation.id);

      // Resolution belongs to the conversation, not to one message inside it. Pointing this
      // at a reply would either do nothing visible or, worse, resolve a thread from a child
      // whose own state no client reads.
      if (isReviewCommentReply(target)) {
        throw new HunkUserError(`\`${operation.id}\` is a reply, which has no status of its own.`, [
          `Set the status on the comment it answers: \`${target.parentId}\`.`,
        ]);
      }

      return {
        ...store,
        files: {
          ...store.files,
          [file.path]: (store.files[file.path] ?? []).map((entry) =>
            entry.id === operation.id && isReviewRootComment(entry)
              ? { ...entry, status: operation.status, updatedAt }
              : entry,
          ),
        },
      };
    });
  }

  if (operation.name === "comment-delete") {
    const root = requireRepoRoot(repoRoot);
    const file = requireReviewedFile(bootstrap, operation.file);

    mutateComments(root, (store) => {
      requireComment(store, file.path, operation.id);

      return {
        ...store,
        files: {
          ...store.files,
          // Replies go with the comment they answer. Left behind they would be unreachable —
          // no anchor of their own, and no root to be shown under — while still counting
          // against the store, so deletion takes the whole conversation or none of it.
          [file.path]: (store.files[file.path] ?? []).filter(
            (entry) => entry.id !== operation.id && entry.parentId !== operation.id,
          ),
        },
      };
    });
  }

  if (operation.name === "focus-get") {
    return { kind: "focus", focus: readReviewFocus(requireRepoRoot(repoRoot)) ?? null };
  }

  if (operation.name === "focus-clear") {
    clearReviewFocus(requireRepoRoot(repoRoot));
    return { kind: "focus", focus: null };
  }

  if (operation.name === "focus-set") {
    const root = requireRepoRoot(repoRoot);
    // Validated against this very review, so an agent cannot point a partner at a file that
    // is not in the changeset it just named — the pointer would silently do nothing.
    const file = operation.file ? requireReviewedFile(bootstrap, operation.file).path : undefined;

    return {
      kind: "focus",
      focus: writeReviewFocus(
        root,
        {
          target: focusTargetOf(command.input),
          ...(file !== undefined ? { file } : {}),
          ...(operation.side !== undefined ? { side: operation.side } : {}),
          ...(operation.line !== undefined ? { line: operation.line } : {}),
        },
        deps.now,
      ),
    };
  }

  if (operation.name === "viewed-set") {
    const root = requireRepoRoot(repoRoot);
    // Every path is validated before anything is written, so a request naming one unknown
    // file fails whole rather than half-applying and reporting success.
    const paths = operation.files.map((path) => requireReviewedFile(bootstrap, path).path);
    setViewed(root, bootstrap, paths, operation.viewed, deps);
  }

  return {
    kind: "review",
    operation: operation.name,
    ...(commentId ? { commentId } : {}),
    review: buildReviewExport(bootstrap, {
      repoRoot,
      includePatch: operation.name === "export" ? operation.includePatch : false,
    }),
  };
}

/** Render one review result as the single JSON document the CLI writes to stdout. */
export function formatReviewResult(result: ReviewCommandResult): string {
  if (result.kind === "focus") {
    return `${JSON.stringify({ focus: result.focus }, null, 2)}\n`;
  }

  if (result.kind === "file-source") {
    return `${JSON.stringify({ path: result.path, side: result.side, text: result.text }, null, 2)}\n`;
  }

  // `export` returns the payload bare so the common case has no envelope to unwrap; write
  // operations wrap it, because their caller also needs to know what the write produced.
  const payload =
    result.operation === "export"
      ? result.review
      : {
          operation: result.operation,
          ...(result.commentId ? { commentId: result.commentId } : {}),
          review: result.review,
        };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Render one review failure as JSON on stderr.
 *
 * The caller is a program, not a person: a partial payload on stdout or a bare message it
 * cannot classify both read as "the review is empty". Stdout stays untouched on failure so
 * a client can trust that anything it parses there is a complete result.
 */
export function formatReviewError(error: unknown): string {
  const userFacing = isUserFacingError(error);

  return `${JSON.stringify(
    {
      error: {
        kind: userFacing ? "user" : "unexpected",
        message: error instanceof Error ? error.message : String(error),
        suggestions:
          userFacing && Array.isArray(error.suggestions)
            ? error.suggestions.filter((entry): entry is string => typeof entry === "string")
            : [],
      },
    },
    null,
    2,
  )}\n`;
}
