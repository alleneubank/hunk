import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE_ENTRYPOINT = join(process.cwd(), "src/main.tsx");

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      Buffer.from(proc.stderr).toString("utf8").trim() || `git ${args.join(" ")} failed`,
    );
  }
}

/** Create a repo with one committed file and one uncommitted edit to review. */
function createReviewRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "hunk-review-export-cli-"));
  git(repoDir, "init");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "alpha.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
  git(repoDir, "add", "alpha.ts");
  git(repoDir, "commit", "-m", "initial");
  writeFileSync(join(repoDir, "alpha.ts"), "export const alpha = 10;\nexport const beta = 2;\n");
  return repoDir;
}

/** One OS pipe buffer on the platforms this runs on; the size a client's read stops at. */
const PIPE_BUFFER_BYTES = 64 * 1024;

/**
 * Create a repo whose export is several pipe buffers long.
 *
 * Separating each edit by more context than the diff carries keeps every change in its own
 * hunk, so the payload grows through hunk entries alone. That matters: the client that
 * found this reads `export` without `--include-patch`, and a fixture that only got large
 * through patch text would miss it.
 */
function createLargeReviewRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "hunk-review-export-large-"));
  git(repoDir, "init");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");

  const committed: string[] = [];
  for (let index = 0; index < 1000; index += 1) {
    committed.push(`export const value${index} = ${index};`);
    for (let filler = 0; filler < 10; filler += 1) {
      committed.push(`// filler ${index}.${filler}`);
    }
  }

  writeFileSync(join(repoDir, "wide.ts"), `${committed.join("\n")}\n`);
  git(repoDir, "add", "wide.ts");
  git(repoDir, "commit", "-m", "initial");
  writeFileSync(
    join(repoDir, "wide.ts"),
    `${committed.map((line) => (line.startsWith("export") ? `${line} // edited` : line)).join("\n")}\n`,
  );

  return repoDir;
}

function runHunk(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(["bun", "run", SOURCE_ENTRYPOINT, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

/** Quote one argument for `sh -c`, which is the only way to get a real pipeline here. */
function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run one command with stdout on an OS pipe drained by a separate process.
 *
 * `Bun.spawn` and `child_process` both buffer a child's output eagerly, which hides the
 * defect this pins: truncation appears only when the reader is another process that has to
 * be scheduled — a shell pipeline, an editor host, `hunk review export | jq`. The exit code
 * belongs to the reader here, so completeness of the payload is what this asserts.
 */
function runHunkThroughPipe(cwd: string, args: string[]) {
  const command = `bun run ${[SOURCE_ENTRYPOINT, ...args].map(shellQuote).join(" ")} | cat`;
  const proc = Bun.spawnSync(["sh", "-c", command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  return {
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

describe("hunk review export CLI contract", () => {
  test("emits a JSON review snapshot with no daemon, session, or TTY", () => {
    const repoDir = createReviewRepo();

    try {
      const { exitCode, stdout, stderr } = runHunk(repoDir, ["review", "export", "--json"]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const payload = JSON.parse(stdout);
      expect(payload.exportVersion).toBe(1);
      expect(payload.reviewCommentsVersion).toBe(1);
      expect(payload.review.files.map((file: { path: string }) => file.path)).toEqual(["alpha.ts"]);
      expect(payload.review.files[0].hunkCount).toBeGreaterThan(0);
      expect(payload.viewedFilePaths).toEqual([]);
      expect(payload.commentsAvailable).toBe(true);
      expect(payload.comments).toEqual({});
      // Terminal takeover would mean the interactive app started.
      expect(stdout).not.toContain("[?1049h");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // POSIX-only because the harness needs a real shell pipeline, not because the defect is:
  // it truncates wherever stdout is an OS pipe.
  test.skipIf(process.platform === "win32")(
    "writes a payload larger than one pipe buffer without truncating it",
    () => {
      const repoDir = createLargeReviewRepo();

      try {
        const { stdout, stderr } = runHunkThroughPipe(repoDir, ["review", "export", "--json"]);

        expect(stderr).toBe("");
        // The regression: exiting straight after `write` ended the process before the pipe
        // drained, so stdout stopped at one buffer and every client reading a changeset
        // this wide received JSON that could not be parsed.
        expect(stdout.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
        const payload = JSON.parse(stdout);
        expect(payload.review.files).toHaveLength(1);
        expect(payload.review.files[0].hunkCount).toBeGreaterThan(500);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    },
  );

  test("carries the sidecar's changeset and per-file summaries", () => {
    const repoDir = createReviewRepo();

    try {
      mkdirSync(join(repoDir, ".hunk"), { recursive: true });
      writeFileSync(
        join(repoDir, ".hunk", "agent-context.json"),
        JSON.stringify({
          version: 1,
          summary: "Raises alpha and leaves beta alone.",
          files: [{ path: "alpha.ts", summary: "Only the alpha constant moves." }],
        }),
      );

      const payload = JSON.parse(runHunk(repoDir, ["review", "export", "--json"]).stdout);

      expect(payload.review.agentSummary).toBe("Raises alpha and leaves beta alone.");
      expect(payload.review.files[0].agentSummary).toBe("Only the alpha constant moves.");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("omits raw patch text unless --include-patch is passed", () => {
    const repoDir = createReviewRepo();

    try {
      const plain = JSON.parse(runHunk(repoDir, ["review", "export", "--json"]).stdout);
      const withPatch = JSON.parse(
        runHunk(repoDir, ["review", "export", "--json", "--include-patch"]).stdout,
      );

      expect(plain.review.files[0].patch).toBeUndefined();
      expect(withPatch.review.files[0].patch).toContain("export const alpha = 10;");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("exports another repo through --repo without changing directory", () => {
    const repoDir = createReviewRepo();
    const elsewhere = mkdtempSync(join(tmpdir(), "hunk-review-export-cwd-"));

    try {
      const { exitCode, stdout } = runHunk(elsewhere, [
        "review",
        "export",
        "--json",
        "--repo",
        repoDir,
      ]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).review.files.map((file: { path: string }) => file.path)).toEqual([
        "alpha.ts",
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("accepts the same range selection as hunk diff", () => {
    const repoDir = createReviewRepo();

    try {
      // HEAD as a target means "changes since HEAD", which is the same uncommitted edit.
      const { exitCode, stdout } = runHunk(repoDir, ["review", "export", "--json", "HEAD"]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).review.files.map((file: { path: string }) => file.path)).toEqual([
        "alpha.ts",
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("reports comments unavailable rather than empty for a corrupt store", () => {
    const repoDir = createReviewRepo();

    try {
      mkdirSync(join(repoDir, ".hunk"), { recursive: true });
      writeFileSync(join(repoDir, ".hunk", "review-comments.json"), "{ not json", "utf8");

      const payload = JSON.parse(runHunk(repoDir, ["review", "export", "--json"]).stdout);

      expect(payload.commentsAvailable).toBe(false);
      expect(payload.commentsUnavailableReason).toContain("review-comments.json");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("leaves the review directory untouched", () => {
    const repoDir = createReviewRepo();

    try {
      expect(runHunk(repoDir, ["review", "export", "--json"]).exitCode).toBe(0);

      // REQ-EXPORT-007: an export is a read. Creating review state here would make a client
      // that polls the export silently author state the user never asked for.
      expect(() => readFileSync(join(repoDir, ".hunk", "review-state.json"), "utf8")).toThrow();
      expect(() => readFileSync(join(repoDir, ".hunk", "review-comments.json"), "utf8")).toThrow();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("fails with structured JSON on stderr and an empty stdout", () => {
    const nonRepoDir = mkdtempSync(join(tmpdir(), "hunk-review-export-nonrepo-"));

    try {
      const { exitCode, stdout, stderr } = runHunk(nonRepoDir, ["review", "export", "--json"]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      const failure = JSON.parse(stderr);
      expect(failure.error.kind).toBe("user");
      expect(failure.error.message).toContain("Git repository");
      expect(Array.isArray(failure.error.suggestions)).toBe(true);
    } finally {
      rmSync(nonRepoDir, { recursive: true, force: true });
    }
  });

  test("exits non-zero with a structured error for an invalid range", () => {
    const repoDir = createReviewRepo();

    try {
      const { exitCode, stdout, stderr } = runHunk(repoDir, [
        "review",
        "export",
        "--json",
        "HEAD~999",
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      const failure = JSON.parse(stderr);
      expect(failure.error.message).toContain("HEAD~999");
      // A client must be able to tell a bad request from a Hunk bug.
      expect(failure.error.kind).toBe("user");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("refuses to guess an output format when --json is omitted", () => {
    const repoDir = createReviewRepo();

    try {
      const { exitCode, stdout, stderr } = runHunk(repoDir, ["review", "export"]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("--json");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("rejects an unknown review subcommand", () => {
    const { exitCode, stderr } = runHunk(process.cwd(), ["review", "summarize"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown review subcommand: summarize");
  });

  test("adds a comment, anchors it, and returns it in the same call's review", () => {
    const repoDir = createReviewRepo();

    try {
      const { exitCode, stdout } = runHunk(repoDir, [
        "review",
        "comment",
        "add",
        "--json",
        "--file",
        "alpha.ts",
        "--side",
        "new",
        "--line",
        "1",
        "--body",
        "why 10?",
        "--author",
        "reviewer",
      ]);

      expect(exitCode).toBe(0);
      const payload = JSON.parse(stdout);
      expect(payload.operation).toBe("comment-add");
      expect(typeof payload.commentId).toBe("string");

      const comments = payload.review.comments["alpha.ts"];
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe("why 10?");
      expect(comments[0].author).toBe("reviewer");
      expect(comments[0].status).toBe("active");
      expect(comments[0].line).toBe(1);
      expect(comments[0].id).toBe(payload.commentId);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("reads a comment body from stdin", () => {
    const repoDir = createReviewRepo();

    try {
      const proc = Bun.spawnSync(
        [
          "bun",
          "run",
          SOURCE_ENTRYPOINT,
          "review",
          "comment",
          "add",
          "--json",
          "--file",
          "alpha.ts",
          "--side",
          "new",
          "--line",
          "1",
          "--stdin",
        ],
        {
          cwd: repoDir,
          stdin: Buffer.from("piped body\nwith two lines\n"),
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        },
      );

      expect(proc.exitCode).toBe(0);
      const payload = JSON.parse(Buffer.from(proc.stdout).toString("utf8"));
      expect(payload.review.comments["alpha.ts"][0].body).toContain("with two lines");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("resolves and deletes a comment by id", () => {
    const repoDir = createReviewRepo();

    try {
      const added = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "add",
          "--json",
          "--file",
          "alpha.ts",
          "--side",
          "new",
          "--line",
          "1",
          "--body",
          "first",
        ]).stdout,
      );

      const resolved = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "status",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          added.commentId,
          "--status",
          "resolved",
        ]).stdout,
      );
      expect(resolved.review.comments["alpha.ts"][0].status).toBe("resolved");

      const deleted = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "delete",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          added.commentId,
        ]).stdout,
      );
      expect(deleted.review.comments["alpha.ts"] ?? []).toHaveLength(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("replies thread onto the comment they answer instead of standing alone", () => {
    const repoDir = createReviewRepo();

    const addComment = (body: string) =>
      JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "add",
          "--json",
          "--file",
          "alpha.ts",
          "--side",
          "new",
          "--line",
          "1",
          "--body",
          body,
        ]).stdout,
      ).commentId as string;

    try {
      const parentId = addComment("why 10?");
      // A second root on the same line: a reply must attach to the comment it names, not to
      // whatever else happens to sit at that line.
      const otherId = addComment("unrelated point");

      const replied = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "reply",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          parentId,
          "--body",
          "because the constant moved",
          "--author",
          "allen",
        ]).stdout,
      );

      expect(replied.operation).toBe("comment-reply");
      const comments = replied.review.comments["alpha.ts"];
      // Two conversations, not three comments: the reply is nested, never top-level.
      expect(comments).toHaveLength(2);
      expect(comments.map((comment: { id: string }) => comment.id).sort()).toEqual(
        [parentId, otherId].sort(),
      );

      const parent = comments.find((comment: { id: string }) => comment.id === parentId);
      expect(parent.replies).toHaveLength(1);
      expect(parent.replies[0].id).toBe(replied.commentId);
      expect(parent.replies[0].body).toBe("because the constant moved");
      expect(parent.replies[0].author).toBe("allen");
      // A reply carries no placement or lifecycle of its own.
      expect(parent.replies[0].line).toBeUndefined();
      expect(parent.replies[0].status).toBeUndefined();

      expect(
        comments.find((comment: { id: string }) => comment.id === otherId).replies,
      ).toHaveLength(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("refuses to reply to a reply, keeping a conversation one level deep", () => {
    const repoDir = createReviewRepo();

    try {
      const parentId = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "add",
          "--json",
          "--file",
          "alpha.ts",
          "--side",
          "new",
          "--line",
          "1",
          "--body",
          "why 10?",
        ]).stdout,
      ).commentId;

      const replyId = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "reply",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          parentId,
          "--body",
          "first answer",
        ]).stdout,
      ).commentId;

      const { exitCode, stderr } = runHunk(repoDir, [
        "review",
        "comment",
        "reply",
        "--json",
        "--file",
        "alpha.ts",
        "--id",
        replyId,
        "--body",
        "answer to the answer",
      ]);

      expect(exitCode).toBe(1);
      const failure = JSON.parse(stderr);
      expect(failure.error.kind).toBe("user");
      expect(failure.error.message).toContain("itself a reply");
      // The remedy names the comment that can actually be replied to.
      expect(failure.error.suggestions.join(" ")).toContain(parentId);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("resolves, unresolves, and deletes a whole conversation", () => {
    const repoDir = createReviewRepo();

    const setStatus = (id: string, status: string) =>
      JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "status",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          id,
          "--status",
          status,
        ]).stdout,
      );

    try {
      const parentId = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "add",
          "--json",
          "--file",
          "alpha.ts",
          "--side",
          "new",
          "--line",
          "1",
          "--body",
          "why 10?",
        ]).stdout,
      ).commentId;

      const replyId = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "reply",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          parentId,
          "--body",
          "because the constant moved",
        ]).stdout,
      ).commentId;

      expect(setStatus(parentId, "resolved").review.comments["alpha.ts"][0].status).toBe(
        "resolved",
      );
      // Resolving is reversible: a conversation reopened is a normal thing to do, and a
      // review that can only ever close threads makes one misclick permanent.
      const reopened = setStatus(parentId, "active");
      expect(reopened.review.comments["alpha.ts"][0].status).toBe("active");
      expect(reopened.review.comments["alpha.ts"][0].replies).toHaveLength(1);

      // A reply has no status of its own; asking for one is a mistake worth naming.
      const rejected = runHunk(repoDir, [
        "review",
        "comment",
        "status",
        "--json",
        "--file",
        "alpha.ts",
        "--id",
        replyId,
        "--status",
        "resolved",
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stderr).error.message).toContain("no status of its own");

      // Deleting the root takes its replies with it: a reply left behind has no anchor and
      // no parent to be shown under, so it would be unreachable content in the store.
      const deleted = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "delete",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          parentId,
        ]).stdout,
      );
      expect(deleted.review.comments["alpha.ts"] ?? []).toHaveLength(0);
      const store = JSON.parse(
        readFileSync(join(repoDir, ".hunk", "review-comments.json"), "utf8"),
      );
      expect(store.files["alpha.ts"] ?? []).toHaveLength(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("deletes one reply without touching the conversation around it", () => {
    const repoDir = createReviewRepo();

    try {
      const parentId = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "add",
          "--json",
          "--file",
          "alpha.ts",
          "--side",
          "new",
          "--line",
          "1",
          "--body",
          "why 10?",
        ]).stdout,
      ).commentId;

      const replyId = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "reply",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          parentId,
          "--body",
          "typo, ignore me",
        ]).stdout,
      ).commentId;

      const deleted = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "delete",
          "--json",
          "--file",
          "alpha.ts",
          "--id",
          replyId,
        ]).stdout,
      );

      const comments = deleted.review.comments["alpha.ts"];
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(parentId);
      expect(comments[0].replies).toHaveLength(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  /** A repo whose review carries one agent note, which is what a note operation names. */
  function createAnnotatedReviewRepo() {
    const repoDir = createReviewRepo();
    mkdirSync(join(repoDir, ".hunk"), { recursive: true });
    writeFileSync(
      join(repoDir, ".hunk", "agent-context.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "alpha.ts",
            annotations: [
              {
                summary: "Raised the constant",
                rationale: "Callers expect ten.",
                newRange: [1, 1],
              },
            ],
          },
        ],
      }),
    );
    return repoDir;
  }

  /** The only note in an annotated fixture review. */
  function firstNoteId(repoDir: string): string {
    const payload = JSON.parse(runHunk(repoDir, ["review", "export", "--json"]).stdout);
    return payload.review.reviewNotes[0].noteId;
  }

  test("answering an agent note opens a conversation carrying that note's key", () => {
    const repoDir = createAnnotatedReviewRepo();

    try {
      const noteId = firstNoteId(repoDir);
      const replied = JSON.parse(
        runHunk(repoDir, [
          "review",
          "note",
          "reply",
          "--json",
          "--file",
          "alpha.ts",
          "--note",
          noteId,
          "--body",
          "ten is right, thanks",
        ]).stdout,
      );

      expect(replied.operation).toBe("note-reply");
      const comments = replied.review.comments["alpha.ts"];
      expect(comments).toHaveLength(1);
      // The first thing said becomes the conversation itself, so no empty container is left.
      expect(comments[0].body).toBe("ten is right, thanks");
      expect(comments[0].status).toBe("active");
      expect(comments[0].noteKey).toBe(replied.review.review.reviewNotes[0].noteKey);
      expect(comments[0].replies).toHaveLength(0);

      // A second answer threads onto the first rather than opening a rival conversation.
      const again = JSON.parse(
        runHunk(repoDir, [
          "review",
          "note",
          "reply",
          "--json",
          "--file",
          "alpha.ts",
          "--note",
          noteId,
          "--body",
          "one more thing",
        ]).stdout,
      );
      expect(again.review.comments["alpha.ts"]).toHaveLength(1);
      expect(again.review.comments["alpha.ts"][0].replies).toHaveLength(1);
      expect(again.review.comments["alpha.ts"][0].replies[0].body).toBe("one more thing");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("marking a note resolved needs nothing said first, and reopens", () => {
    const repoDir = createAnnotatedReviewRepo();

    const setNoteStatus = (noteId: string, status: string) =>
      JSON.parse(
        runHunk(repoDir, [
          "review",
          "note",
          "status",
          "--json",
          "--file",
          "alpha.ts",
          "--note",
          noteId,
          "--status",
          status,
        ]).stdout,
      );

    try {
      const noteId = firstNoteId(repoDir);
      const resolved = setNoteStatus(noteId, "resolved");

      // Most notes are read and accepted without comment; requiring a reply first would make
      // "I have dealt with this" cost a sentence nobody wants to write.
      const comments = resolved.review.comments["alpha.ts"];
      expect(comments).toHaveLength(1);
      expect(comments[0].status).toBe("resolved");
      expect(comments[0].body).toBe("");
      expect(comments[0].noteKey).toBe(resolved.review.review.reviewNotes[0].noteKey);

      const reopened = setNoteStatus(noteId, "active");
      expect(reopened.review.comments["alpha.ts"]).toHaveLength(1);
      expect(reopened.review.comments["alpha.ts"][0].status).toBe("active");

      // Replying afterwards joins the conversation resolving already opened.
      const replied = JSON.parse(
        runHunk(repoDir, [
          "review",
          "note",
          "reply",
          "--json",
          "--file",
          "alpha.ts",
          "--note",
          noteId,
          "--body",
          "actually, one question",
        ]).stdout,
      );
      expect(replied.review.comments["alpha.ts"]).toHaveLength(1);
      expect(replied.review.comments["alpha.ts"][0].replies).toHaveLength(1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("refuses a note id this review does not report", () => {
    const repoDir = createAnnotatedReviewRepo();

    try {
      const { exitCode, stderr } = runHunk(repoDir, [
        "review",
        "note",
        "status",
        "--json",
        "--file",
        "alpha.ts",
        "--note",
        "ai:nonexistent:0",
        "--status",
        "resolved",
      ]);

      expect(exitCode).toBe(1);
      const failure = JSON.parse(stderr);
      expect(failure.error.kind).toBe("user");
      expect(failure.error.message).toContain("No agent note");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("refuses a comment on a line the diff does not contain", () => {
    const repoDir = createReviewRepo();

    try {
      const { exitCode, stdout, stderr } = runHunk(repoDir, [
        "review",
        "comment",
        "add",
        "--json",
        "--file",
        "alpha.ts",
        "--side",
        "new",
        "--line",
        "9999",
        "--body",
        "nowhere",
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr).error.message).toContain("9999");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("refuses a write against a file outside the review", () => {
    const repoDir = createReviewRepo();

    try {
      const { exitCode, stderr } = runHunk(repoDir, [
        "review",
        "comment",
        "add",
        "--json",
        "--file",
        "not-in-review.ts",
        "--side",
        "new",
        "--line",
        "1",
        "--body",
        "x",
      ]);

      expect(exitCode).toBe(1);
      expect(JSON.parse(stderr).error.message).toContain("not part of this review");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("refuses to write over a comment store it cannot read", () => {
    const repoDir = createReviewRepo();

    try {
      mkdirSync(join(repoDir, ".hunk"), { recursive: true });
      const corrupt = '{"version":1,"files":{"alpha.ts":[ truncated';
      const storePath = join(repoDir, ".hunk", "review-comments.json");
      writeFileSync(storePath, corrupt, "utf8");

      const { exitCode, stderr } = runHunk(repoDir, [
        "review",
        "comment",
        "add",
        "--json",
        "--file",
        "alpha.ts",
        "--side",
        "new",
        "--line",
        "1",
        "--body",
        "x",
      ]);

      expect(exitCode).toBe(1);
      expect(JSON.parse(stderr).error.message).toContain("review-comments.json");
      // REQ-REVIEW-003: authored bytes survive a refused write.
      expect(readFileSync(storePath, "utf8")).toBe(corrupt);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("toggles viewed state and reports it back", () => {
    const repoDir = createReviewRepo();

    try {
      const marked = JSON.parse(
        runHunk(repoDir, ["review", "viewed", "set", "--json", "--file", "alpha.ts", "--viewed"])
          .stdout,
      );
      expect(marked.review.viewedFilePaths).toEqual(["alpha.ts"]);

      const cleared = JSON.parse(
        runHunk(repoDir, ["review", "viewed", "set", "--json", "--file", "alpha.ts", "--unviewed"])
          .stdout,
      );
      expect(cleared.review.viewedFilePaths).toEqual([]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // A machine-facing command whose whole contract is its JSON result must not answer
  // "written" for a write that never landed.
  test("reports a failed viewed write instead of a successful-looking result", () => {
    const repoDir = createReviewRepo();

    try {
      // A directory where the state file belongs: the write cannot succeed, and nothing
      // about the review is otherwise broken.
      mkdirSync(join(repoDir, ".hunk", "review-state.json"), { recursive: true });

      const { exitCode, stdout, stderr } = runHunk(repoDir, [
        "review",
        "viewed",
        "set",
        "--json",
        "--file",
        "alpha.ts",
        "--viewed",
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr).error.message).toContain("review-state.json");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("marks several files viewed in one write", () => {
    const repoDir = createReviewRepo();

    try {
      writeFileSync(join(repoDir, "beta.ts"), "export const beta = 1;\n");
      git(repoDir, "add", "beta.ts");
      git(repoDir, "commit", "-m", "add beta");
      writeFileSync(join(repoDir, "beta.ts"), "export const beta = 20;\n");

      const { exitCode, stdout } = runHunk(repoDir, [
        "review",
        "viewed",
        "set",
        "--file",
        "alpha.ts",
        "--file",
        "beta.ts",
        "--viewed",
        "--json",
      ]);

      expect(exitCode).toBe(0);
      // Both, not just the last: overwriting made the earlier `--file` disappear silently,
      // and the command still reported a successful write.
      expect(JSON.parse(stdout).review.viewedFilePaths.sort()).toEqual(["alpha.ts", "beta.ts"]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("refuses the whole batch when one file is not in the review", () => {
    const repoDir = createReviewRepo();

    try {
      const { exitCode, stderr } = runHunk(repoDir, [
        "review",
        "viewed",
        "set",
        "--file",
        "alpha.ts",
        "--file",
        "absent.ts",
        "--viewed",
        "--json",
      ]);

      expect(exitCode).not.toBe(0);
      expect(JSON.parse(stderr).error.message).toContain("absent.ts");
      // Nothing was written, so the valid half of the request did not half-apply.
      const after = JSON.parse(runHunk(repoDir, ["review", "export", "--json"]).stdout);
      expect(after.viewedFilePaths).toEqual([]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("refuses a repeated flag the operation can only act on once", () => {
    const repoDir = createReviewRepo();

    try {
      const { exitCode, stderr } = runHunk(repoDir, [
        "review",
        "comment",
        "delete",
        "--file",
        "alpha.ts",
        "--id",
        "one",
        "--id",
        "two",
        "--json",
      ]);

      expect(exitCode).not.toBe(0);
      expect(JSON.parse(stderr).error.message).toContain("`--id` accepts one value");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("requires exactly one of --viewed and --unviewed", () => {
    const repoDir = createReviewRepo();

    try {
      const both = runHunk(repoDir, [
        "review",
        "viewed",
        "set",
        "--json",
        "--file",
        "alpha.ts",
        "--viewed",
        "--unviewed",
      ]);
      const neither = runHunk(repoDir, ["review", "viewed", "set", "--json", "--file", "alpha.ts"]);

      expect(both.exitCode).toBe(1);
      expect(neither.exitCode).toBe(1);
      expect(JSON.parse(both.stderr).error.message).toContain("exactly one");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("marks a comment outdated once its anchor line changes", () => {
    const repoDir = createReviewRepo();

    try {
      runHunk(repoDir, [
        "review",
        "comment",
        "add",
        "--json",
        "--file",
        "alpha.ts",
        "--side",
        "new",
        "--line",
        "1",
        "--body",
        "on the edited line",
      ]);

      writeFileSync(
        join(repoDir, "alpha.ts"),
        "export const alpha = 999;\nexport const beta = 2;\n",
      );

      // REQ-VSCODE-005: an outdated comment is visibly marked, never hidden.
      const payload = JSON.parse(runHunk(repoDir, ["review", "export", "--json"]).stdout);
      expect(payload.comments["alpha.ts"]).toHaveLength(1);
      expect(payload.comments["alpha.ts"][0].outdated).toBe(true);
      // REQ-EXPORT-010: placement going stale says nothing about the lifecycle.
      expect(payload.comments["alpha.ts"][0].status).toBe("active");
      expect(payload.comments["alpha.ts"][0].body).toBe("on the edited line");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("does not disturb viewed state when writing a comment", () => {
    const repoDir = createReviewRepo();

    try {
      runHunk(repoDir, ["review", "viewed", "set", "--json", "--file", "alpha.ts", "--viewed"]);
      const stateBefore = readFileSync(join(repoDir, ".hunk", "review-state.json"), "utf8");

      const added = JSON.parse(
        runHunk(repoDir, [
          "review",
          "comment",
          "add",
          "--json",
          "--file",
          "alpha.ts",
          "--side",
          "new",
          "--line",
          "1",
          "--body",
          "coexistence",
        ]).stdout,
      );

      // REQ-REVIEW-001/010: the two stores are independent; neither write touches the other.
      expect(readFileSync(join(repoDir, ".hunk", "review-state.json"), "utf8")).toBe(stateBefore);
      expect(added.review.viewedFilePaths).toEqual(["alpha.ts"]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
