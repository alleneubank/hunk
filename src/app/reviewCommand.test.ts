import { describe, expect, test } from "bun:test";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import type { DiffFile } from "../core/types";
import { runReviewCommand, type ReviewCommandDeps } from "./reviewCommand";

/**
 * Run one review operation against an injected changeset.
 *
 * `hunk review` always loads a real working tree, and every bundled VCS backend attaches a
 * source fetcher — so the no-fetcher case belongs to extension-contributed backends, where
 * `sourceFetcher` is optional. Injecting the bootstrap is the only way to reach it without
 * shipping a fixture extension.
 */
function runAgainst(files: DiffFile[], deps: Partial<ReviewCommandDeps> = {}) {
  return runReviewCommand(
    {
      kind: "review",
      input: { kind: "vcs", staged: false, options: {} },
      operation: { name: "file-source", file: files[0]?.path ?? "", side: "old" },
    },
    {
      loadConfiguredSessionBootstrapImpl: async () => ({
        bootstrap: createTestVcsAppBootstrap({ files, sourceLabel: "/repo" }),
      }),
      loadStartupExtensionsImpl: async () => ({ extensions: [], commands: [], views: [] }),
      ...deps,
    } as ReviewCommandDeps,
  );
}

describe("hunk review file source", () => {
  // A side that does not exist and a file that cannot be read are different answers. Folding
  // them together lets a client render a confidently blank document in place of source it
  // never received — the failure looks like an empty file, not like an error.
  test("refuses a file whose source this review cannot read", async () => {
    const file = createTestDiffFile({ path: "src/alpha.ts", before: "one\n", after: "two\n" });
    expect(file.sourceFetcher).toBeUndefined();

    expect(runAgainst([file])).rejects.toThrow(/cannot read the full source/);
  });

  test("reports a side that genuinely has no content as null", async () => {
    const base = createTestDiffFile({ path: "src/added.ts", before: "", after: "one\n" });
    const file = {
      ...base,
      // An added file: the old side is absent by construction, not unread.
      metadata: { ...base.metadata, type: "new" as const },
      sourceFetcher: { getFullText: async () => null },
    };

    const result = await runAgainst([file]);

    expect(result).toEqual({ kind: "file-source", path: "src/added.ts", side: "old", text: null });
  });

  // Same `null`, opposite meaning. A modified file has both sides, so the fetcher failing to
  // produce one is a read failure — and passing it on renders as a blank document, which is
  // exactly the confident-emptiness this command must not produce.
  test("refuses a null read on a side the change kind says exists", async () => {
    const base = createTestDiffFile({ path: "src/alpha.ts", before: "one\n", after: "two\n" });
    const file = {
      ...base,
      metadata: { ...base.metadata, type: "change" as const },
      sourceFetcher: { getFullText: async () => null },
    };

    expect(runAgainst([file])).rejects.toThrow(/Could not read the old side/);
  });

  test("refuses a null read on a deleted file's old side", async () => {
    const base = createTestDiffFile({ path: "src/gone.ts", before: "one\n", after: "" });
    const file = {
      ...base,
      metadata: { ...base.metadata, type: "deleted" as const },
      sourceFetcher: { getFullText: async () => null },
    };

    // Deleted files keep their old side; only the new side is legitimately absent.
    expect(runAgainst([file])).rejects.toThrow(/Could not read the old side/);
  });

  test("returns the fetcher's text for a side that has content", async () => {
    const file = {
      ...createTestDiffFile({ path: "src/alpha.ts", before: "one\n", after: "two\n" }),
      sourceFetcher: { getFullText: async (side: "old" | "new") => `${side} text` },
    };

    const result = await runAgainst([file]);

    expect(result).toEqual({
      kind: "file-source",
      path: "src/alpha.ts",
      side: "old",
      text: "old text",
    });
  });
});
