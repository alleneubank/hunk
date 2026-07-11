import { describe, expect, test } from "bun:test";
import { createTestAgentFileContext, createTestDiffFile } from "../../../test/helpers/diff-helpers";
import {
  buildSelectedHunkSummary,
  findNextAnnotatedFile,
  findNextUnviewedFile,
  resolveReviewNavigationTarget,
} from "./reviewState";

function createAnnotatedFile(id: string, path: string) {
  return createTestDiffFile({
    id,
    path,
    before: "const value = 1;\nconst stable = true;\n",
    after: "const value = 2;\nconst stable = true;\n",
    agent: createTestAgentFileContext(path, {
      annotations: [{ newRange: [1, 1], summary: `Explain ${path}` }],
    }),
  });
}

describe("review state helpers", () => {
  // Intent: stale selections keep their requested index without inventing ranges.
  test("buildSelectedHunkSummary preserves stale out-of-range selections", () => {
    const file = createTestDiffFile();

    expect(buildSelectedHunkSummary(file, 99)).toEqual({ index: 99 });
  });

  // Intent: annotated-file navigation wraps predictably and handles no-note streams.
  test("findNextAnnotatedFile wraps through annotated files and handles empty streams", () => {
    const alpha = createAnnotatedFile("alpha", "alpha.ts");
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts", agent: null });
    const gamma = createAnnotatedFile("gamma", "gamma.ts");

    expect(findNextAnnotatedFile([alpha, beta, gamma], "alpha", 1)).toBe(gamma);
    expect(findNextAnnotatedFile([alpha, beta, gamma], "gamma", 1)).toBe(alpha);
    expect(findNextAnnotatedFile([alpha, beta, gamma], undefined, -1)).toBe(gamma);
    expect(findNextAnnotatedFile([beta], "beta", 1)).toBeNull();
  });

  test("findNextUnviewedFile skips viewed files and wraps relative to an unviewed file", () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });
    const gamma = createTestDiffFile({ id: "gamma", path: "gamma.ts" });
    const delta = createTestDiffFile({ id: "delta", path: "delta.ts" });
    const visibleFiles = [alpha, beta, gamma, delta];
    const viewedFileIds = new Set(["beta", "delta"]);

    expect(findNextUnviewedFile(visibleFiles, viewedFileIds, "alpha", 1)).toBe(gamma);
    expect(findNextUnviewedFile(visibleFiles, viewedFileIds, "gamma", 1)).toBe(alpha);
    expect(findNextUnviewedFile(visibleFiles, viewedFileIds, "alpha", -1)).toBe(gamma);
  });

  test("findNextUnviewedFile starts from visible position when the current file is viewed", () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });
    const gamma = createTestDiffFile({ id: "gamma", path: "gamma.ts" });
    const visibleFiles = [alpha, beta, gamma];
    const viewedFileIds = new Set(["beta"]);

    expect(findNextUnviewedFile(visibleFiles, viewedFileIds, "beta", 1)).toBe(gamma);
    expect(findNextUnviewedFile(visibleFiles, viewedFileIds, "beta", -1)).toBe(alpha);
    expect(findNextUnviewedFile(visibleFiles, viewedFileIds, "missing", -1)).toBe(alpha);
  });

  test("findNextUnviewedFile returns null when every visible file is viewed", () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });

    expect(findNextUnviewedFile([alpha, beta], new Set(["alpha", "beta"]), "alpha", 1)).toBeNull();
  });

  // Intent: comment navigation targets the next noted hunk and scrolls to the note.
  test("resolveReviewNavigationTarget follows annotated comment navigation", () => {
    const alpha = createAnnotatedFile("alpha", "alpha.ts");
    const gamma = createAnnotatedFile("gamma", "gamma.ts");

    const target = resolveReviewNavigationTarget({
      allFiles: [alpha, gamma],
      visibleFiles: [alpha, gamma],
      currentFileId: "alpha",
      currentHunkIndex: 0,
      input: { commentDirection: "next" },
    });

    expect(target).toEqual({ file: gamma, hunkIndex: 0, scrollToNote: true });
  });

  // Intent: absolute navigation supports both hunk index and side+line addressing.
  test("resolveReviewNavigationTarget resolves paths by explicit hunk or side and line", () => {
    const file = createTestDiffFile({ id: "alpha", path: "src/alpha.ts" });

    expect(
      resolveReviewNavigationTarget({
        allFiles: [file],
        visibleFiles: [file],
        currentFileId: "alpha",
        currentHunkIndex: 0,
        input: { filePath: "src/alpha.ts", hunkIndex: 0 },
      }),
    ).toEqual({ file, hunkIndex: 0, scrollToNote: false });

    expect(
      resolveReviewNavigationTarget({
        allFiles: [file],
        visibleFiles: [file],
        currentFileId: "alpha",
        currentHunkIndex: 0,
        input: { filePath: "src/alpha.ts", side: "new", line: 1 },
      }),
    ).toEqual({ file, hunkIndex: 0, scrollToNote: false });
  });

  // Intent: invalid agent navigation requests fail before mutating review state.
  test("resolveReviewNavigationTarget rejects missing and invalid targets", () => {
    const file = createTestDiffFile({ id: "alpha", path: "src/alpha.ts" });
    const baseInput = {
      allFiles: [file],
      visibleFiles: [file],
      currentFileId: "alpha",
      currentHunkIndex: 0,
    };

    expect(() =>
      resolveReviewNavigationTarget({
        ...baseInput,
        input: { commentDirection: "next" },
      }),
    ).toThrow("No annotated hunks");
    expect(() => resolveReviewNavigationTarget({ ...baseInput, input: {} })).toThrow(
      "navigate requires --file",
    );
    expect(() =>
      resolveReviewNavigationTarget({
        ...baseInput,
        input: { filePath: "missing.ts", hunkIndex: 0 },
      }),
    ).toThrow("No diff file matches missing.ts");
    expect(() =>
      resolveReviewNavigationTarget({ ...baseInput, input: { filePath: "src/alpha.ts" } }),
    ).toThrow("hunkIndex or both side and line");
    expect(() =>
      resolveReviewNavigationTarget({
        ...baseInput,
        input: { filePath: "src/alpha.ts", hunkIndex: 20 },
      }),
    ).toThrow("No diff hunk");
  });
});
