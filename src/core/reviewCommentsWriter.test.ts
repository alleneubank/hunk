import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addReviewComment,
  mutateReviewComments,
  readReviewComments,
  REVIEW_COMMENTS_VERSION,
  type ReviewComment,
} from "./reviewComments";

function createStoreDir() {
  return mkdtempSync(join(tmpdir(), "hunk-review-writer-"));
}

function makeComment(id: string, updatedAt = "2026-08-01T00:00:00.000Z"): ReviewComment {
  return {
    id,
    anchor: {
      side: "new",
      line: 1,
      originalLine: 1,
      lineTextHash: "a".repeat(64),
      contextBefore: [],
      contextAfter: [],
    },
    body: `body ${id}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
    status: "active",
  };
}

function makeReply(id: string, parentId: string, updatedAt = "2026-08-01T00:00:00.000Z") {
  return {
    id,
    parentId,
    body: `reply ${id}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
  } satisfies ReviewComment;
}

describe("review comment writer", () => {
  // The two failures need opposite remedies from the client: a held lock resolves by
  // retrying, an unwritable lock path never does. Folding the second into the first sends
  // the user to retry something that cannot succeed.
  //
  // A read-only directory is the honest reproduction. A directory placed at the lock path
  // would not work: `O_EXCL` reports `EEXIST` for an existing path of any type, so that is
  // indistinguishable from a peer holding the lock — which is exactly why the errno, not the
  // mere fact of failure, is what the code has to branch on.
  test("reports an unwritable lock path as unavailable, not contended", () => {
    const storeDir = createStoreDir();
    const filePath = join(storeDir, "review-comments.json");
    chmodSync(storeDir, 0o500);

    try {
      let ran = false;
      const result = mutateReviewComments(filePath, (store) => {
        ran = true;
        return store;
      });

      expect(result.kind).toBe("unavailable");
      expect(ran).toBe(false);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      // Restore, or the suite's temp-dir cleanup cannot remove it.
      chmodSync(storeDir, 0o700);
    }
  });

  test("writes a comment that reads back", () => {
    const filePath = join(createStoreDir(), "review-comments.json");

    const result = addReviewComment(filePath, "src/App.tsx", makeComment("c1"));

    expect(result.kind).toBe("written");
    const read = readReviewComments(filePath);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(read.store.files["src/App.tsx"]?.map((comment) => comment.id)).toEqual(["c1"]);
  });

  // The core safety property of the strict-preserve policy: if we cannot understand what
  // is already there, we must not replace it.
  test("refuses to write over a store it could not read, leaving bytes intact", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    const corrupt = '{"version":1,"files":{"a.ts":[ truncated';
    writeFileSync(filePath, corrupt, "utf8");

    const result = addReviewComment(filePath, "a.ts", makeComment("c1"));

    expect(result.kind).toBe("unavailable");
    expect(readFileSync(filePath, "utf8")).toBe(corrupt);
  });

  test("merges by id, keeping the entry with the newer updatedAt", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    addReviewComment(filePath, "a.ts", makeComment("c1", "2026-08-01T00:00:00.000Z"));

    addReviewComment(filePath, "a.ts", {
      ...makeComment("c1", "2026-08-02T00:00:00.000Z"),
      body: "newer body",
    });
    // An older revision of the same id must not overwrite the newer one.
    addReviewComment(filePath, "a.ts", {
      ...makeComment("c1", "2026-07-01T00:00:00.000Z"),
      body: "stale body",
    });

    const read = readReviewComments(filePath);
    if (read.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(read.store.files["a.ts"]).toHaveLength(1);
    expect(read.store.files["a.ts"]?.[0]?.body).toBe("newer body");
  });

  test("keeps comments written by another writer between read and write", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    addReviewComment(filePath, "a.ts", makeComment("c1"));

    // Simulate a racing writer landing after this mutation read the store: the mutation
    // must union rather than replace.
    const result = mutateReviewComments(filePath, (store) => {
      writeFileSync(
        filePath,
        JSON.stringify({
          version: REVIEW_COMMENTS_VERSION,
          files: { "a.ts": [makeComment("c1"), makeComment("racer")] },
        }),
        "utf8",
      );
      return {
        ...store,
        files: { "a.ts": [...(store.files["a.ts"] ?? []), makeComment("c2")] },
      };
    });

    expect(result.kind).toBe("written");
    const read = readReviewComments(filePath);
    if (read.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(read.store.files["a.ts"]?.map((comment) => comment.id).sort()).toEqual([
      "c1",
      "c2",
      "racer",
    ]);
  });

  // The union merge exists to protect a peer's additions, and a naive union silently
  // resurrects anything this writer deleted.
  test("a mutation that removes a comment actually removes it", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    addReviewComment(filePath, "a.ts", makeComment("c1"));
    addReviewComment(filePath, "a.ts", makeComment("c2"));

    const result = mutateReviewComments(filePath, (store) => ({
      ...store,
      files: { "a.ts": (store.files["a.ts"] ?? []).filter((comment) => comment.id !== "c1") },
    }));

    expect(result.kind).toBe("written");
    const read = readReviewComments(filePath);
    if (read.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(read.store.files["a.ts"]?.map((comment) => comment.id)).toEqual(["c2"]);
  });

  test("a delete does not discard a peer's comment added between read and write", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    addReviewComment(filePath, "a.ts", makeComment("c1"));

    const result = mutateReviewComments(filePath, (store) => {
      writeFileSync(
        filePath,
        JSON.stringify({
          version: REVIEW_COMMENTS_VERSION,
          files: { "a.ts": [makeComment("c1"), makeComment("racer")] },
        }),
        "utf8",
      );
      return { ...store, files: { "a.ts": [] } };
    });

    expect(result.kind).toBe("written");
    const read = readReviewComments(filePath);
    if (read.kind !== "ok") {
      throw new Error("expected ok");
    }
    // The intentional delete of `c1` applies; the peer's `racer` survives.
    expect(read.store.files["a.ts"]?.map((comment) => comment.id)).toEqual(["racer"]);
  });

  // The union rule and cascading deletion pull in opposite directions here. Deleting a root
  // is expressed as "these ids are gone", but a peer's reply to that root arrived after the
  // deleting writer computed its removal set — so the union keeps it, and it survives with
  // nothing to be shown under and no anchor of its own. Invisible content in a store whose
  // whole promise is that authored content is never quietly lost.
  test("a delete does not strand a peer's reply to the comment it removed", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    addReviewComment(filePath, "a.ts", makeComment("c1"));

    mutateReviewComments(filePath, (store) => {
      writeFileSync(
        filePath,
        JSON.stringify({
          version: REVIEW_COMMENTS_VERSION,
          files: { "a.ts": [makeComment("c1"), makeReply("r1", "c1"), makeComment("racer")] },
        }),
        "utf8",
      );
      return { ...store, files: { "a.ts": [] } };
    });

    const read = readReviewComments(filePath);
    if (read.kind !== "ok") {
      throw new Error("expected ok");
    }
    // `c1` and its reply go together; the peer's unrelated comment still survives.
    expect(read.store.files["a.ts"]?.map((comment) => comment.id)).toEqual(["racer"]);
  });

  test("a reply survives while the comment it answers is still there", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    addReviewComment(filePath, "a.ts", makeComment("c1"));
    addReviewComment(filePath, "a.ts", makeReply("r1", "c1"));

    const read = readReviewComments(filePath);
    if (read.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(read.store.files["a.ts"]?.map((comment) => comment.id)).toEqual(["c1", "r1"]);
  });

  test("removing the last comment on a path drops the path entirely", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    addReviewComment(filePath, "a.ts", makeComment("c1"));

    mutateReviewComments(filePath, (store) => ({ ...store, files: { "a.ts": [] } }));

    const read = readReviewComments(filePath);
    if (read.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(Object.keys(read.store.files)).toEqual([]);
  });

  test("releases its lock so a later write succeeds", () => {
    const filePath = join(createStoreDir(), "review-comments.json");

    expect(addReviewComment(filePath, "a.ts", makeComment("c1")).kind).toBe("written");
    expect(existsSync(`${filePath}.lock`)).toBe(false);
    expect(addReviewComment(filePath, "a.ts", makeComment("c2")).kind).toBe("written");
  });

  test("reclaims a lock left behind by a dead process", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    // pid 0 is never a live owner, so this stands in for a crashed writer.
    writeFileSync(
      `${filePath}.lock`,
      JSON.stringify({ ownerPid: 0, acquiredAt: new Date().toISOString() }),
      "utf8",
    );

    expect(addReviewComment(filePath, "a.ts", makeComment("c1")).kind).toBe("written");
  });

  // The lock is the whole concurrency story. A writer that proceeds after failing to take
  // it has no exclusivity at all, and the merge-before-write only narrows the lost-update
  // window rather than closing it.
  test("refuses to write while a live peer holds the lock", () => {
    const filePath = join(createStoreDir(), "review-comments.json");
    const lockPath = `${filePath}.lock`;
    // This very process is the owner, so the stale-lock reclaim must leave it alone.
    writeFileSync(
      lockPath,
      JSON.stringify({ ownerPid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf8",
    );

    const result = addReviewComment(filePath, "a.ts", makeComment("c1"));

    expect(result.kind).toBe("contended");
    expect(existsSync(filePath)).toBe(false);
    // The peer's lock is still the peer's; refusing must never steal it.
    expect(existsSync(lockPath)).toBe(true);
  });

  test("two concurrent OS processes both land their comments", async () => {
    const dir = createStoreDir();
    const filePath = join(dir, "review-comments.json");
    const scriptPath = join(dir, "writer.ts");
    const writerModule = join(import.meta.dir, "reviewComments.ts");

    writeFileSync(
      scriptPath,
      `import { addReviewComment } from ${JSON.stringify(writerModule)};
const [filePath, prefix, count] = process.argv.slice(2);
for (let index = 0; index < Number(count); index += 1) {
  const id = prefix + index;
  const result = addReviewComment(filePath, "a.ts", {
    id,
    anchor: { side: "new", line: 1, originalLine: 1, lineTextHash: "a".repeat(64), contextBefore: [], contextAfter: [] },
    body: id,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    status: "active",
  });
  if (result.kind !== "written") {
    console.error("write failed", result);
    process.exit(1);
  }
}
`,
      "utf8",
    );

    const runs = ["left", "right"].map((prefix) =>
      Bun.spawn(["bun", "run", scriptPath, filePath, prefix, "25"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const exits = await Promise.all(runs.map((proc) => proc.exited));

    expect(exits).toEqual([0, 0]);
    const read = readReviewComments(filePath);
    if (read.kind !== "ok") {
      throw new Error(`expected ok, got ${read.kind}`);
    }
    // Nothing may be lost: 25 from each writer, regardless of interleaving.
    expect(read.store.files["a.ts"]).toHaveLength(50);
  }, 60_000);
});
