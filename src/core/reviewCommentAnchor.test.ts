import { describe, expect, test } from "bun:test";
import {
  captureReviewCommentAnchor,
  hashAnchorText,
  readPatchLines,
  resolveReviewCommentAnchor,
} from "./reviewCommentAnchor";

/** Build a unified patch from explicit prefixed rows, so cases read as real diffs. */
function patchOf(header: string, rows: string[]) {
  return [header, ...rows].join("\n");
}

const BASE = patchOf("@@ -1,5 +1,5 @@", [
  " const alpha = 1;",
  " const beta = 2;",
  "-const target = 3;",
  "+const target = 4;",
  " const gamma = 5;",
  " const delta = 6;",
]);

describe("patch line reading", () => {
  test("assigns both side numbers across context, deletion, and addition rows", () => {
    const lines = readPatchLines(BASE);

    expect(lines.map((line) => [line.oldLine, line.newLine, line.text])).toEqual([
      [1, 1, "const alpha = 1;"],
      [2, 2, "const beta = 2;"],
      [3, undefined, "const target = 3;"],
      [undefined, 3, "const target = 4;"],
      [4, 4, "const gamma = 5;"],
      [5, 5, "const delta = 6;"],
    ]);
    expect(lines.every((line) => line.hunkIndex === 0)).toBe(true);
    expect(lines[0]?.hunkHeader).toBe("@@ -1,5 +1,5 @@");
  });

  test("numbers a second hunk from its own header", () => {
    const lines = readPatchLines(
      [BASE, patchOf("@@ -40,2 +40,2 @@", ["-old line", "+new line"])].join("\n"),
    );
    const second = lines.filter((line) => line.hunkIndex === 1);

    expect(second.map((line) => [line.oldLine, line.newLine])).toEqual([
      [40, undefined],
      [undefined, 40],
    ]);
  });
});

describe("anchor capture", () => {
  test("records the anchor text hash, context, and hunk header", () => {
    const anchor = captureReviewCommentAnchor(BASE, "new", 3);

    expect(anchor).not.toBeNull();
    expect(anchor?.line).toBe(3);
    expect(anchor?.originalLine).toBe(3);
    expect(anchor?.lineTextHash).toBe(hashAnchorText("const target = 4;"));
    expect(anchor?.hunkHeader).toBe("@@ -1,5 +1,5 @@");
    expect(anchor?.contextBefore).toEqual(["const beta = 2;", "const target = 3;"]);
    expect(anchor?.contextAfter).toEqual(["const gamma = 5;", "const delta = 6;"]);
  });

  test("returns null for a line the patch does not contain", () => {
    expect(captureReviewCommentAnchor(BASE, "new", 999)).toBeNull();
  });
});

describe("anchor resolution ladder", () => {
  test("an unchanged patch keeps the comment on its line", () => {
    const anchor = captureReviewCommentAnchor(BASE, "new", 3);

    expect(resolveReviewCommentAnchor(anchor!, BASE)).toEqual({ line: 3, status: "active" });
  });

  test("an edit above the anchor follows the line to its new number", () => {
    const anchor = captureReviewCommentAnchor(BASE, "new", 3);
    const shifted = patchOf("@@ -1,7 +1,8 @@", [
      " const inserted = 0;",
      " const alsoInserted = 0;",
      " const alpha = 1;",
      " const beta = 2;",
      "-const target = 3;",
      "+const target = 4;",
      " const gamma = 5;",
      " const delta = 6;",
    ]);

    expect(resolveReviewCommentAnchor(anchor!, shifted)).toEqual({ line: 5, status: "active" });
  });

  test("deleting the anchor line marks the comment outdated and keeps its origin", () => {
    const anchor = captureReviewCommentAnchor(BASE, "new", 3);
    const removed = patchOf("@@ -1,5 +1,4 @@", [
      " const alpha = 1;",
      " const beta = 2;",
      "-const target = 3;",
      " const gamma = 5;",
      " const delta = 6;",
    ]);

    expect(resolveReviewCommentAnchor(anchor!, removed)).toEqual({ line: 3, status: "outdated" });
  });

  test("editing the anchor line's own text marks it outdated rather than guessing", () => {
    const anchor = captureReviewCommentAnchor(BASE, "new", 3);
    const rewritten = patchOf("@@ -1,5 +1,5 @@", [
      " const alpha = 1;",
      " const beta = 2;",
      "-const target = 3;",
      "+const target = 99;",
      " const gamma = 5;",
      " const delta = 6;",
    ]);

    expect(resolveReviewCommentAnchor(anchor!, rewritten)).toEqual({ line: 3, status: "outdated" });
  });

  test("duplicate candidate text is disambiguated by surrounding context", () => {
    const anchor = captureReviewCommentAnchor(BASE, "new", 3);
    // The same added text appears twice; only one copy keeps the original neighbours.
    const duplicated = patchOf("@@ -1,5 +1,8 @@", [
      "+const target = 4;",
      "+const unrelated = 0;",
      " const alpha = 1;",
      " const beta = 2;",
      "-const target = 3;",
      "+const target = 4;",
      " const gamma = 5;",
      " const delta = 6;",
    ]);

    // The decoy copy sits at new line 1 with none of the original neighbours; the real one
    // is at new line 5 (the deletion row consumes no new-side number).
    expect(resolveReviewCommentAnchor(anchor!, duplicated)).toEqual({ line: 5, status: "active" });
  });

  test("a comment never lands on a line whose text differs from its anchor", () => {
    const anchor = captureReviewCommentAnchor(BASE, "new", 3);
    const replaced = patchOf("@@ -1,5 +1,5 @@", [
      " const alpha = 1;",
      " const beta = 2;",
      "-const target = 3;",
      "+const somethingElse = 7;",
      " const gamma = 5;",
      " const delta = 6;",
    ]);
    const resolved = resolveReviewCommentAnchor(anchor!, replaced);

    expect(resolved.status).toBe("outdated");
  });

  test("an old-side anchor resolves against the old side only", () => {
    const anchor = captureReviewCommentAnchor(BASE, "old", 3);
    expect(anchor?.lineTextHash).toBe(hashAnchorText("const target = 3;"));

    // The identical text exists on the new side of this patch, but an old-side anchor must
    // not migrate across the diff to find it.
    const newSideOnly = patchOf("@@ -1,4 +1,5 @@", [
      " const alpha = 1;",
      " const beta = 2;",
      "+const target = 3;",
      " const gamma = 5;",
      " const delta = 6;",
    ]);

    expect(resolveReviewCommentAnchor(anchor!, newSideOnly).status).toBe("outdated");
  });
});

/**
 * The BRIEF's anchor-honesty floor.
 *
 * Generated rather than enumerated on purpose: the driver cannot tune this to flatter a
 * chosen case because the generator produces the cases. The invariant under test is the
 * one the Never list names — a comment is either on content matching its anchor, or it is
 * outdated. There is no third outcome.
 */
describe("anchor honesty (property)", () => {
  const anchorText = "const target = 4;";

  /** Deterministic small-integer generator, so a failure reproduces exactly. */
  function makeRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  test("every generated edit yields a matching line or an outdated comment", () => {
    const anchor = captureReviewCommentAnchor(BASE, "new", 3);
    expect(anchor).not.toBeNull();

    for (let seed = 1; seed <= 400; seed += 1) {
      const random = makeRandom(seed);
      const rows = [
        " const alpha = 1;",
        " const beta = 2;",
        "-const target = 3;",
        `+${anchorText}`,
        " const gamma = 5;",
        " const delta = 6;",
      ];

      // Apply a few random structural edits: insert, delete, duplicate, or rewrite rows.
      const editCount = 1 + Math.floor(random() * 4);
      for (let edit = 0; edit < editCount; edit += 1) {
        const at = Math.floor(random() * rows.length);
        const kind = Math.floor(random() * 4);
        if (kind === 0) {
          rows.splice(at, 0, `+const generated${seed}_${edit} = 0;`);
        } else if (kind === 1 && rows.length > 1) {
          rows.splice(at, 1);
        } else if (kind === 2) {
          const source = rows[at];
          if (source !== undefined) {
            rows.splice(at, 0, source);
          }
        } else {
          const source = rows[at];
          if (source !== undefined) {
            rows[at] = `${source.slice(0, 1)}const rewritten${seed}_${edit} = 0;`;
          }
        }
      }

      const mutated = patchOf("@@ -1,20 +1,20 @@", rows);
      const resolved = resolveReviewCommentAnchor(anchor!, mutated);

      if (resolved.status === "outdated") {
        expect(resolved.line).toBe(anchor!.originalLine);
        continue;
      }

      const landed = readPatchLines(mutated).find(
        (line) => line.newLine === resolved.line && line.oldLine === undefined,
      );
      const landedContext = readPatchLines(mutated).find((line) => line.newLine === resolved.line);
      const text = (landed ?? landedContext)?.text;

      expect(text).toBeDefined();
      expect(hashAnchorText(text!)).toBe(anchor!.lineTextHash);
    }
  });
});

describe("a low-entropy anchor line", () => {
  /** A closing brace is the same text everywhere, so only context can tell two apart. */
  const BRACES = patchOf("@@ -1,8 +1,8 @@", [
    " function alpha() {",
    " const inner = 1;",
    " }",
    " ",
    " function beta() {",
    "-const other = 2;",
    "+const other = 3;",
    " }",
  ]);

  test("does not follow its text into an unrelated part of the file", () => {
    // The comment was written about alpha's closing brace. Deleting alpha leaves exactly one
    // `}` in the patch — beta's — which matches by text and by nothing else. Accepting it
    // would put the comment on code it was never written about and call it active, which is
    // the outcome the Never-list exists to forbid.
    const anchor = captureReviewCommentAnchor(BRACES, "new", 3);
    expect(anchor).not.toBeNull();

    const alphaRemoved = patchOf("@@ -1,4 +1,4 @@", [
      " function beta() {",
      "-const other = 2;",
      "+const other = 3;",
      " }",
    ]);

    expect(resolveReviewCommentAnchor(anchor!, alphaRemoved).status).toBe("outdated");
  });

  test("still follows its text when the surrounding code came with it", () => {
    // The guard must not make every repeated line outdated: a real move keeps its context,
    // and that is exactly the case the ladder exists to resolve.
    const anchor = captureReviewCommentAnchor(BRACES, "new", 3);
    const shifted = patchOf("@@ -1,10 +1,10 @@", [
      " const header = 0;",
      " const alsoHeader = 0;",
      " function alpha() {",
      " const inner = 1;",
      " }",
      " ",
      " function beta() {",
      "-const other = 2;",
      "+const other = 3;",
      " }",
    ]);

    expect(resolveReviewCommentAnchor(anchor!, shifted)).toEqual({ line: 5, status: "active" });
  });
});
