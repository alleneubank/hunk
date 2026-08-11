import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HunkReviewError,
  parseReviewError,
  readReviewPayload,
  type ReviewExport,
} from "./reviewExport";
import {
  targetArguments,
  targetPathspecArguments,
  WORKING_TREE_TARGET,
  type ReviewTarget,
} from "./reviewTarget";
import { isReviewFocusPayload, type ReviewFocusPayload } from "./reviewFocus";

/** Hard ceiling on one CLI call, so a wedged binary never hangs the extension host. */
const HUNK_TIMEOUT_MS = 30_000;
/** A large changeset with `--include-patch` can be several megabytes of JSON. */
const HUNK_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

export interface HunkCliOptions {
  /** Explicit binary path, from the `hunkReview.binaryPath` setting. */
  binaryPath?: string;
  repoRoot: string;
  /**
   * The changeset every invocation names.
   *
   * Held here rather than passed per call because a comment must be anchored against the
   * same changeset the export resolved it in. Splitting the target across call sites is how
   * a write ends up written against a diff the reviewer was never looking at.
   */
  target?: ReviewTarget;
  /** Injected in tests so the harness never spawns a real binary. */
  run?: HunkRunner;
}

export interface HunkRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type HunkRunner = (binary: string, args: string[], input?: string) => Promise<HunkRunResult>;

/**
 * Run one `hunk` invocation.
 *
 * `execFile` rather than a shell: arguments carry user-authored comment bodies and repo
 * paths, and neither should ever be parsed by a shell.
 */
const spawnHunk: HunkRunner = (binary, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: HUNK_TIMEOUT_MS, maxBuffer: HUNK_OUTPUT_MAX_BYTES },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new HunkReviewError(
              `Could not run \`${binary}\`.`,
              "Install Hunk, or set `hunkReview.binaryPath` to its full path.",
            ),
          );
          return;
        }

        if (error && (error as { killed?: boolean }).killed) {
          reject(
            new HunkReviewError(
              `\`${binary}\` did not finish within ${HUNK_TIMEOUT_MS / 1000}s.`,
              "The review may be very large. Try a narrower range.",
            ),
          );
          return;
        }

        // A non-zero exit is a normal outcome here: the payload on stderr is the answer.
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      },
    );

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });

/** Candidate binaries tried in order when no explicit path is configured. */
function candidateBinaries(binaryPath: string | undefined, repoRoot: string): string[] {
  if (binaryPath) {
    return [binaryPath];
  }

  // A repo-local install wins over PATH so a checkout pinned to one Hunk version is
  // reviewed by that version rather than whatever happens to be installed globally.
  const local = join(repoRoot, "node_modules", ".bin", "hunk");
  return existsSync(local) ? [local, "hunk"] : ["hunk"];
}

/**
 * Client for the `hunk review` command group.
 *
 * Every review operation goes through here, and none of them reimplements what Hunk
 * already decides: file identity, hunk ranges, anchoring, and viewed invalidation all
 * arrive in the payload (REQ-VSCODE-007).
 */
export class HunkCli {
  private readonly run: HunkRunner;

  constructor(private readonly options: HunkCliOptions) {
    this.run = options.run ?? spawnHunk;
  }

  /** Read the current review. */
  export(includePatch: boolean): Promise<ReviewExport> {
    return this.review(["export", ...(includePatch ? ["--include-patch"] : [])]);
  }

  /** Add one comment, returning the review the write produced. */
  addComment(input: {
    file: string;
    side: "old" | "new";
    line: number;
    body: string;
    author?: string;
  }): Promise<ReviewExport> {
    return this.review(
      [
        "comment",
        "add",
        "--file",
        input.file,
        "--side",
        input.side,
        "--line",
        String(input.line),
        "--stdin",
        ...(input.author ? ["--author", input.author] : []),
      ],
      // Bodies go over stdin, never argv: they are multi-line and user-authored.
      input.body,
    );
  }

  /** Answer an existing comment, returning the review the write produced. */
  replyToComment(input: {
    file: string;
    id: string;
    body: string;
    author?: string;
  }): Promise<ReviewExport> {
    return this.review(
      [
        "comment",
        "reply",
        "--file",
        input.file,
        "--id",
        input.id,
        "--stdin",
        ...(input.author ? ["--author", input.author] : []),
      ],
      input.body,
    );
  }

  /** Answer one agent note, opening the conversation about it if this is the first word. */
  replyToNote(input: {
    file: string;
    note: string;
    body: string;
    author?: string;
  }): Promise<ReviewExport> {
    return this.review(
      [
        "note",
        "reply",
        "--file",
        input.file,
        "--note",
        input.note,
        "--stdin",
        ...(input.author ? ["--author", input.author] : []),
      ],
      input.body,
    );
  }

  setNoteStatus(file: string, note: string, status: "active" | "resolved"): Promise<ReviewExport> {
    return this.review(["note", "status", "--file", file, "--note", note, "--status", status]);
  }

  setCommentStatus(file: string, id: string, status: "active" | "resolved"): Promise<ReviewExport> {
    return this.review(["comment", "status", "--file", file, "--id", id, "--status", status]);
  }

  deleteComment(file: string, id: string): Promise<ReviewExport> {
    return this.review(["comment", "delete", "--file", file, "--id", id]);
  }

  /**
   * Mark one or more files viewed.
   *
   * Repeated `--file` rather than a call per file: Hunk applies the whole set under one
   * lock, and a folder of twenty files should not mean twenty processes each returning a
   * whole review the caller discards.
   */
  setViewed(files: readonly string[], viewed: boolean): Promise<ReviewExport> {
    return this.review([
      "viewed",
      "set",
      ...files.flatMap((file) => ["--file", file]),
      viewed ? "--viewed" : "--unviewed",
    ]);
  }

  /**
   * Read one side of a reviewed file in full.
   *
   * The native diff editor needs the pre-image as text, and only Hunk knows how to read it
   * for the VCS backing this review. Returns null when the side does not exist, which is
   * the normal case for an added file's old side.
   */
  async fileSource(file: string, side: "old" | "new"): Promise<string | null> {
    const raw = await this.runReview(["file", "source", "--file", file, "--side", side]);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HunkReviewError(
        `Hunk returned output that is not JSON for ${file} (${side} side).`,
        raw.slice(0, 400),
      );
    }

    // The whole envelope is validated, not just `text`. Null is a real answer here -- the
    // side does not exist -- so treating any unrecognized payload as null would report
    // "this file has no old side" for a malformed response, and the editor renders that as
    // an empty document. Only a response that answers the question actually asked counts.
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as { path?: unknown }).path !== file ||
      (payload as { side?: unknown }).side !== side
    ) {
      throw new HunkReviewError(`Hunk returned an unexpected response for ${file} (${side} side).`);
    }

    const text = (payload as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }

    if (text === null) {
      return null;
    }

    throw new HunkReviewError(`Hunk returned no readable source for ${file} (${side} side).`);
  }

  /**
   * Read where an agent is pointing this reviewer, or nothing when it is pointing nowhere.
   *
   * Goes through the CLI like every other read: the extension never parses `.hunk/` itself,
   * so the focus schema has exactly one reader (REQ-VSCODE-007).
   */
  async focus(): Promise<ReviewFocusPayload | null> {
    const parsed: unknown = JSON.parse(await this.runReview(["focus", "get"]));

    if (typeof parsed !== "object" || parsed === null || !("focus" in parsed)) {
      throw new HunkReviewError("Hunk returned an unrecognized review focus.");
    }

    const { focus } = parsed as { focus: unknown };
    return isReviewFocusPayload(focus) ? focus : null;
  }

  /**
   * Run one review subcommand and unwrap its payload.
   *
   * Write operations wrap the review in an envelope; export does not. Unwrapping here
   * means callers always receive the same `ReviewExport`, so no UI code has to know which
   * shape its operation happened to produce.
   */
  private async review(args: string[], input?: string): Promise<ReviewExport> {
    return readReviewPayload(await this.runReview(args, input));
  }

  /** Run one review subcommand and return its raw stdout. */
  private async runReview(args: string[], input?: string): Promise<string> {
    const failures: string[] = [];

    for (const binary of candidateBinaries(this.options.binaryPath, this.options.repoRoot)) {
      let result: HunkRunResult;
      try {
        result = await this.run(
          binary,
          [
            "review",
            ...args,
            ...targetArguments(this.options.target ?? WORKING_TREE_TARGET),
            "--json",
            "--repo",
            this.options.repoRoot,
            ...targetPathspecArguments(this.options.target ?? WORKING_TREE_TARGET),
          ],
          input,
        );
      } catch (error) {
        if (error instanceof HunkReviewError) {
          failures.push(error.message);
          continue;
        }
        throw error;
      }

      if (result.exitCode !== 0) {
        const failure = parseReviewError(result.stderr);
        throw new HunkReviewError(failure.message, failure.suggestions.join("\n") || undefined);
      }

      return result.stdout;
    }

    throw new HunkReviewError(
      "Could not find the `hunk` binary.",
      [...failures, "Install Hunk, or set `hunkReview.binaryPath` to its full path."].join("\n"),
    );
  }
}
