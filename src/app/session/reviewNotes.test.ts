import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/changeset/model";
import { buildSidecarReviewNotes } from "./reviewNotes";

/** One sidecar-annotated file, carrying only what the projection reads. */
function annotatedFile(
  id: string,
  path: string,
  annotations: Array<Record<string, unknown>>,
): Pick<DiffFile, "id" | "path" | "agent"> {
  return { id, path, agent: { path, annotations } } as unknown as Pick<
    DiffFile,
    "id" | "path" | "agent"
  >;
}

describe("sidecar review notes", () => {
  test("projects an annotation into a note", () => {
    const notes = buildSidecarReviewNotes([
      annotatedFile("f1", "src/alpha.ts", [
        { summary: "One placement rule", rationale: "Every surface uses it.", newRange: [10, 12] },
      ]),
    ]);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.filePath).toBe("src/alpha.ts");
    expect(notes[0]?.body).toBe("One placement rule\n\nEvery surface uses it.");
    expect(notes[0]?.editable).toBe(false);
  });

  // `noteId` embeds the file's index in the changeset, so it moves whenever an earlier file
  // enters or leaves the review — a note nobody touched gets a different id. Anything the
  // reviewer persists against a note has to survive that, or their reply silently reattaches
  // to a different note the next time the changeset is a different shape.
  test("a note keeps its key when its id moves under it", () => {
    const annotation = { summary: "One placement rule", rationale: "Every surface uses it." };
    const before = buildSidecarReviewNotes([annotatedFile("f1", "src/alpha.ts", [annotation])]);
    const after = buildSidecarReviewNotes([
      annotatedFile("f0", "src/added-earlier.ts", []),
      annotatedFile("f1", "src/alpha.ts", [annotation]),
    ]);

    // Asserted present first: two undefined keys would satisfy the equality below while
    // proving nothing at all.
    expect(before[0]?.noteKey).toMatch(/^[0-9a-f]{64}$/);
    expect(after[0]?.noteKey).toBe(before[0]?.noteKey ?? "");
  });

  test("rewriting a note's text gives it a different key", () => {
    const [original] = buildSidecarReviewNotes([
      annotatedFile("f1", "src/alpha.ts", [{ summary: "One placement rule" }]),
    ]);
    const [rewritten] = buildSidecarReviewNotes([
      annotatedFile("f1", "src/alpha.ts", [{ summary: "Two placement rules" }]),
    ]);

    // Deliberate: a reply answers what the note said. Once the agent rewrote it, the reply is
    // answering text that is gone, and pretending otherwise is the silent-misattachment bug.
    expect(rewritten?.noteKey).not.toBe(original?.noteKey);
  });

  test("the same text in two files is two different notes", () => {
    const notes = buildSidecarReviewNotes([
      annotatedFile("f1", "src/alpha.ts", [{ summary: "Same wording" }]),
      annotatedFile("f2", "src/beta.ts", [{ summary: "Same wording" }]),
    ]);

    expect(notes[0]?.noteKey).not.toBe(notes[1]?.noteKey);
  });

  test("two identical notes on one file stay distinguishable", () => {
    const notes = buildSidecarReviewNotes([
      annotatedFile("f1", "src/alpha.ts", [
        { summary: "Same wording", newRange: [10, 12] },
        { summary: "Same wording", newRange: [40, 42] },
      ]),
    ]);

    // Their ranges differ, which is what makes them two notes rather than one repeated.
    expect(notes[0]?.noteKey).not.toBe(notes[1]?.noteKey);
  });
});
