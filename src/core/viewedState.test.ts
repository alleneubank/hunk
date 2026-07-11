import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNextViewedState,
  hashPatch,
  readViewedState,
  resolveViewedPaths,
  writeViewedState,
  type ViewedState,
} from "./viewedState";

const tempDirs: string[] = [];
const EMPTY_VIEWED_STATE: ViewedState = { version: 1, files: {} };

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Create one isolated portable filesystem root for persistence tests. */
function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-viewed-state-"));
  tempDirs.push(dir);
  return dir;
}

describe("viewed state persistence", () => {
  test("hashes raw patch text deterministically with SHA-256", () => {
    expect(hashPatch("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashPatch("hello")).toBe(hashPatch("hello"));
    expect(hashPatch("hello\n")).not.toBe(hashPatch("hello"));
  });

  test("round-trips a versioned state file", () => {
    const statePath = join(createTempDir(), ".hunk", "review-state.json");
    const state: ViewedState = {
      version: 1,
      files: {
        "src/example.ts": {
          patchHash: hashPatch("example patch"),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
      },
    };

    writeViewedState(statePath, state);

    expect(readViewedState(statePath)).toEqual(state);
    expect(readFileSync(statePath, "utf8")).toContain('"version": 1');
  });

  test("returns empty state for missing, malformed, or invalid state files", () => {
    const dir = createTempDir();
    const statePath = join(dir, "review-state.json");

    expect(readViewedState(statePath)).toEqual(EMPTY_VIEWED_STATE);

    const invalidPayloads = [
      "{ not json",
      JSON.stringify({ version: 2, files: {} }),
      JSON.stringify({ version: 1, files: [] }),
      JSON.stringify({
        version: 1,
        files: { "src/example.ts": { patchHash: 7, viewedAt: "2026-07-10T12:00:00.000Z" } },
      }),
      JSON.stringify({
        version: 1,
        files: { "src/example.ts": { patchHash: "abc", viewedAt: "not-a-date" } },
      }),
    ];

    for (const payload of invalidPayloads) {
      writeFileSync(statePath, payload);
      expect(readViewedState(statePath)).toEqual(EMPTY_VIEWED_STATE);
    }
  });

  test("tolerates write failures", () => {
    const blockingFile = join(createTempDir(), "not-a-directory");
    writeFileSync(blockingFile, "occupied");

    expect(() =>
      writeViewedState(join(blockingFile, "review-state.json"), EMPTY_VIEWED_STATE),
    ).not.toThrow();
  });

  test("resolves only known paths whose current patch hash matches", () => {
    const files = [
      { path: "src/matched.ts", patch: "matched patch" },
      { path: "src/changed.ts", patch: "new patch" },
    ];
    const state: ViewedState = {
      version: 1,
      files: {
        "src/matched.ts": {
          patchHash: hashPatch("matched patch"),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
        "src/changed.ts": {
          patchHash: hashPatch("old patch"),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
        "src/unknown.ts": {
          patchHash: hashPatch("unknown patch"),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
      },
    };

    expect(resolveViewedPaths(files, state)).toEqual(["src/matched.ts"]);
  });

  test("merges current viewed paths while preserving timestamps and absent paths", () => {
    const now = new Date("2026-01-31T00:00:00.000Z");
    const unchangedViewedAt = "2026-01-15T00:00:00.000Z";
    const previous: ViewedState = {
      version: 1,
      files: {
        "src/unchanged.ts": {
          patchHash: hashPatch("same patch"),
          viewedAt: unchangedViewedAt,
        },
        "src/rehashed.ts": {
          patchHash: hashPatch("old patch"),
          viewedAt: "2026-01-14T00:00:00.000Z",
        },
        "src/unviewed.ts": {
          patchHash: hashPatch("unviewed patch"),
          viewedAt: "2026-01-13T00:00:00.000Z",
        },
        "other/absent.ts": {
          patchHash: hashPatch("absent patch"),
          viewedAt: "2026-01-10T00:00:00.000Z",
        },
      },
    };

    const next = buildNextViewedState(
      [
        { path: "src/unchanged.ts", patch: "same patch" },
        { path: "src/rehashed.ts", patch: "new patch" },
        { path: "src/unviewed.ts", patch: "unviewed patch" },
      ],
      new Set(["src/unchanged.ts", "src/rehashed.ts"]),
      previous,
      now,
    );

    expect(next.files["src/unchanged.ts"]?.viewedAt).toBe(unchangedViewedAt);
    expect(next.files["src/rehashed.ts"]).toEqual({
      patchHash: hashPatch("new patch"),
      viewedAt: now.toISOString(),
    });
    expect(next.files["src/unviewed.ts"]).toBeUndefined();
    expect(next.files["other/absent.ts"]).toEqual(previous.files["other/absent.ts"]);
  });

  test("prunes entries older than 30 days while preserving the boundary", () => {
    const now = new Date("2026-01-31T00:00:00.000Z");
    const previous: ViewedState = {
      version: 1,
      files: {
        "other/just-under.ts": {
          patchHash: hashPatch("under"),
          viewedAt: "2026-01-01T00:00:00.001Z",
        },
        "other/exactly.ts": {
          patchHash: hashPatch("exactly"),
          viewedAt: "2026-01-01T00:00:00.000Z",
        },
        "other/just-over.ts": {
          patchHash: hashPatch("over"),
          viewedAt: "2025-12-31T23:59:59.999Z",
        },
        "src/current-expired.ts": {
          patchHash: hashPatch("current"),
          viewedAt: "2025-12-31T23:59:59.999Z",
        },
      },
    };

    const next = buildNextViewedState(
      [{ path: "src/current-expired.ts", patch: "current" }],
      new Set(["src/current-expired.ts"]),
      previous,
      now,
    );

    expect(Object.keys(next.files).sort()).toEqual([
      "other/exactly.ts",
      "other/just-under.ts",
      "src/current-expired.ts",
    ]);
    expect(next.files["src/current-expired.ts"]?.viewedAt).toBe(now.toISOString());
  });
});
