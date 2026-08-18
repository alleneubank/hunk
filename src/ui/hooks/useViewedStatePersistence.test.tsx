import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act, useCallback, useEffect, useState } from "react";
import { HUNK_DIR_NAME, REVIEW_STATE_FILENAME } from "../../core/run/paths";
import {
  hashPatch,
  readViewedState,
  mutateViewedState,
  type ViewedState,
} from "../../core/viewedState";
import type { AppBootstrap } from "../../core/bootstrap";
import type { DiffFile } from "../../core/changeset/model";
import { createTestVcsAppBootstrap } from "../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { App } from "../App";
import { useViewedStatePersistence } from "./useViewedStatePersistence";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Create one isolated repo-shaped root without depending on a platform-specific VCS. */
function createRepoRoot() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-viewed-hook-"));
  tempDirs.push(dir);
  return dir;
}

/** Build the minimum real DiffFile fixture while controlling its persisted patch text. */
function createFile(id: string, path: string, patch: string): DiffFile {
  return {
    ...createTestDiffFile({ id, path }),
    patch,
  };
}

/** Resolve the conventional state path for one test repo root. */
function statePath(repoRoot: string) {
  return join(repoRoot, HUNK_DIR_NAME, REVIEW_STATE_FILENAME);
}

interface PersistenceHarnessHandle {
  setFiles: (files: DiffFile[]) => void;
  setRepoRoot: (repoRoot: string | null) => void;
  setViewedFileIds: (ids: ReadonlySet<string>) => void;
  viewedFileIds: ReadonlySet<string>;
}

function PersistenceHarness({
  initialFiles,
  onHandle,
  onReplace,
  repoRoot,
}: {
  initialFiles: DiffFile[];
  onHandle: (handle: PersistenceHarnessHandle) => void;
  onReplace: (ids: ReadonlySet<string>) => void;
  repoRoot: string | null;
}) {
  const [files, setFiles] = useState(initialFiles);
  const [activeRepoRoot, setRepoRoot] = useState(repoRoot);
  const [viewedFileIds, setViewedFileIds] = useState<ReadonlySet<string>>(() => new Set());
  const replaceViewedFileIds = useCallback(
    (next: ReadonlySet<string>) => {
      const snapshot = new Set(next);
      onReplace(snapshot);
      setViewedFileIds(snapshot);
    },
    [onReplace],
  );

  useViewedStatePersistence({
    files,
    repoRoot: activeRepoRoot,
    replaceViewedFileIds,
    viewedFileIds,
  });

  useEffect(() => {
    onHandle({ setFiles, setRepoRoot, setViewedFileIds, viewedFileIds });
  }, [onHandle, viewedFileIds]);

  return null;
}

/** Keep App mounted while replacing its bootstrap, matching daemon soft-reload behavior. */
function SoftReloadAppHarness({
  initialBootstrap,
  onReady,
}: {
  initialBootstrap: AppBootstrap;
  onReady: (replaceBootstrap: (next: AppBootstrap) => void) => void;
}) {
  const [bootstrap, setBootstrap] = useState(initialBootstrap);

  useEffect(() => {
    onReady(setBootstrap);
  }, [onReady]);

  return (
    <App
      bootstrap={bootstrap}
      onQuit={() => {}}
      onReloadSession={async () => {
        throw new Error("reload is controlled directly by this test harness");
      }}
      onRegisterWorkspaceRefreshRequest={() => () => {}}
      onWorkspaceWriteCompleted={() => {}}
      runWorkspaceWrite={async (run) => {
        await run();
        return true;
      }}
    />
  );
}

/** Render the hook and expose stable test controls for reload and viewed-state updates. */
async function renderPersistence(repoRoot: string | null, files: DiffFile[]) {
  const handleRef: { current: PersistenceHarnessHandle | null } = { current: null };
  const replaceCalls: ReadonlySet<string>[] = [];
  const setup = await testRender(
    <PersistenceHarness
      initialFiles={files}
      onHandle={(handle) => {
        handleRef.current = handle;
      }}
      onReplace={(ids) => {
        replaceCalls.push(new Set(ids));
      }}
      repoRoot={repoRoot}
    />,
    { width: 80, height: 4 },
  );

  return { handleRef, replaceCalls, setup };
}

/** Flush React effects and their follow-up state render before making assertions. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Assert one callback-populated test handle exists before using it. */
function expectHandle(handle: PersistenceHarnessHandle | null) {
  expect(handle).toBeDefined();
  return handle as PersistenceHarnessHandle;
}

describe("useViewedStatePersistence", () => {
  test("App rebinds persistence to the canonical root after a soft reload", async () => {
    const originalCwd = process.cwd();
    const oldRepoRoot = createRepoRoot();
    const newRepoRoot = createRepoRoot();
    mkdirSync(join(oldRepoRoot, ".git"));
    const oldFile = createFile("old:0:alpha", "src/alpha.ts", "old alpha patch");
    const newFile = createFile("new:0:beta", "src/beta.ts", "new beta patch");
    const oldBootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:old",
      files: [oldFile],
      sourceLabel: oldRepoRoot,
    });
    const newBootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:new",
      files: [newFile],
      sourceLabel: newRepoRoot,
    });
    let replaceBootstrap: ((next: AppBootstrap) => void) | null = null;
    process.chdir(oldRepoRoot);
    const setup = await testRender(
      <SoftReloadAppHarness
        initialBootstrap={oldBootstrap}
        onReady={(replace) => {
          replaceBootstrap = replace;
        }}
      />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);
      await act(async () => setup.mockInput.typeText("v"));
      await flush(setup);
      expect(readViewedState(statePath(oldRepoRoot)).files[oldFile.path]).toBeDefined();
      const oldStateAfterMark = readFileSync(statePath(oldRepoRoot), "utf8");

      await act(async () => {
        expect(replaceBootstrap).toBeFunction();
        replaceBootstrap?.(newBootstrap);
      });
      await flush(setup);
      await act(async () => setup.mockInput.typeText("v"));
      await flush(setup);

      expect(readFileSync(statePath(oldRepoRoot), "utf8")).toBe(oldStateAfterMark);
      expect(readViewedState(statePath(newRepoRoot)).files[newFile.path]).toBeDefined();
    } finally {
      await act(async () => setup.renderer.destroy());
      process.chdir(originalCwd);
    }
  });

  test("rehydrates matching persisted paths as current file ids on mount", async () => {
    const repoRoot = createRepoRoot();
    const alpha = createFile("load:0:alpha", "src/alpha.ts", "alpha patch");
    mutateViewedState(statePath(repoRoot), () => ({
      version: 1,
      files: {
        [alpha.path]: {
          patchHash: hashPatch(alpha.patch),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
        "src/unknown.ts": {
          patchHash: hashPatch("unknown patch"),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
      },
    }));
    const { handleRef, replaceCalls, setup } = await renderPersistence(repoRoot, [alpha]);

    try {
      await flush(setup);

      expect(replaceCalls).toHaveLength(1);
      expect(replaceCalls[0]).toEqual(new Set([alpha.id]));
      expect(expectHandle(handleRef.current).viewedFileIds).toEqual(new Set([alpha.id]));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("reconciles viewed ids again when the files array identity changes", async () => {
    const repoRoot = createRepoRoot();
    const alpha = createFile("load:0:alpha", "src/alpha.ts", "alpha patch");
    const beta = createFile("load:1:beta", "src/beta.ts", "beta patch");
    mutateViewedState(statePath(repoRoot), () => ({
      version: 1,
      files: {
        [alpha.path]: {
          patchHash: hashPatch(alpha.patch),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
        [beta.path]: {
          patchHash: hashPatch(beta.patch),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
      },
    }));
    const { handleRef, replaceCalls, setup } = await renderPersistence(repoRoot, [alpha, beta]);

    try {
      await flush(setup);
      expect(replaceCalls.at(-1)).toEqual(new Set([alpha.id, beta.id]));

      const reloadedAlpha = createFile("reload:0:alpha", alpha.path, alpha.patch);
      const reloadedBeta = createFile("reload:1:beta", beta.path, "changed beta patch");
      await act(async () => {
        expectHandle(handleRef.current).setFiles([reloadedAlpha, reloadedBeta]);
      });
      await flush(setup);

      expect(replaceCalls.at(-1)).toEqual(new Set([reloadedAlpha.id]));
      expect(expectHandle(handleRef.current).viewedFileIds).toEqual(new Set([reloadedAlpha.id]));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("writes merged state when a file is marked and removes it when unmarked", async () => {
    const repoRoot = createRepoRoot();
    const alpha = createFile("load:0:alpha", "src/alpha.ts", "alpha patch");
    const absentEntry = {
      patchHash: hashPatch("absent patch"),
      viewedAt: new Date().toISOString(),
    };
    mutateViewedState(statePath(repoRoot), () => ({
      version: 1,
      files: { "other/absent.ts": absentEntry },
    }));
    const { handleRef, setup } = await renderPersistence(repoRoot, [alpha]);

    try {
      await flush(setup);
      await act(async () => {
        expectHandle(handleRef.current).setViewedFileIds(new Set([alpha.id]));
      });
      await flush(setup);

      let persisted = readViewedState(statePath(repoRoot));
      expect(persisted.files["other/absent.ts"]).toEqual(absentEntry);
      expect(persisted.files[alpha.path]?.patchHash).toBe(hashPatch(alpha.patch));
      expect(Date.parse(persisted.files[alpha.path]?.viewedAt ?? "")).not.toBeNaN();

      await act(async () => {
        expectHandle(handleRef.current).setViewedFileIds(new Set());
      });
      await flush(setup);

      persisted = readViewedState(statePath(repoRoot));
      expect(persisted.files[alpha.path]).toBeUndefined();
      expect(persisted.files["other/absent.ts"]).toEqual(absentEntry);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  // The TUI reads viewed state once and can stay open for hours, so its set goes stale the
  // moment an editor or agent runs `hunk review viewed set`. The lock serializes the two
  // writes but cannot stop this one from writing a snapshot that predates the peer's.
  test("keeps a peer's mark written after mount and adopts it into the UI", async () => {
    const repoRoot = createRepoRoot();
    const alpha = createFile("load:0:alpha", "src/alpha.ts", "alpha patch");
    const beta = createFile("load:1:beta", "src/beta.ts", "beta patch");
    const { handleRef, setup } = await renderPersistence(repoRoot, [alpha, beta]);

    try {
      await flush(setup);

      // A peer marks `beta.ts` viewed while this session sits on its startup snapshot.
      const peerWrite = mutateViewedState(statePath(repoRoot), (previous) => ({
        version: 1,
        files: {
          ...previous.files,
          [beta.path]: { patchHash: hashPatch(beta.patch), viewedAt: new Date().toISOString() },
        },
      }));
      expect(peerWrite.kind).toBe("written");

      // The user then marks a different file here, which is the write that used to clobber.
      await act(async () => {
        expectHandle(handleRef.current).setViewedFileIds(new Set([alpha.id]));
      });
      await flush(setup);

      const persisted = readViewedState(statePath(repoRoot));
      expect(Object.keys(persisted.files).sort()).toEqual([alpha.path, beta.path].sort());
      // Adopted, so the next render reads the peer's mark as already-known rather than as a
      // local un-view that would undo it.
      expect(expectHandle(handleRef.current).viewedFileIds).toEqual(new Set([alpha.id, beta.id]));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  // The mirror case: deferring to disk must not make a deliberate un-view unwritable.
  test("a local un-view still wins over the mark on disk", async () => {
    const repoRoot = createRepoRoot();
    const alpha = createFile("load:0:alpha", "src/alpha.ts", "alpha patch");
    mutateViewedState(statePath(repoRoot), () => ({
      version: 1,
      files: {
        [alpha.path]: { patchHash: hashPatch(alpha.patch), viewedAt: "2026-07-10T12:00:00.000Z" },
      },
    }));
    const { handleRef, setup } = await renderPersistence(repoRoot, [alpha]);

    try {
      await flush(setup);
      expect(expectHandle(handleRef.current).viewedFileIds).toEqual(new Set([alpha.id]));

      await act(async () => {
        expectHandle(handleRef.current).setViewedFileIds(new Set());
      });
      await flush(setup);

      expect(readViewedState(statePath(repoRoot)).files[alpha.path]).toBeUndefined();
      expect(expectHandle(handleRef.current).viewedFileIds).toEqual(new Set());
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("switches persistence stores when a soft reload changes the repo root", async () => {
    const oldRepoRoot = createRepoRoot();
    const newRepoRoot = createRepoRoot();
    const oldFile = createFile("old:0:alpha", "src/alpha.ts", "old alpha patch");
    const rehydratedFile = createFile("new:0:beta", "src/beta.ts", "new beta patch");
    const newlyViewedFile = createFile("new:1:gamma", "src/gamma.ts", "new gamma patch");
    mutateViewedState(statePath(newRepoRoot), () => ({
      version: 1,
      files: {
        [rehydratedFile.path]: {
          patchHash: hashPatch(rehydratedFile.patch),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
      },
    }));
    const { handleRef, replaceCalls, setup } = await renderPersistence(oldRepoRoot, [oldFile]);

    try {
      await flush(setup);
      await act(async () => {
        expectHandle(handleRef.current).setViewedFileIds(new Set([oldFile.id]));
      });
      await flush(setup);
      const oldStateAfterMark = readFileSync(statePath(oldRepoRoot), "utf8");

      await act(async () => {
        const handle = expectHandle(handleRef.current);
        handle.setRepoRoot(newRepoRoot);
        handle.setFiles([rehydratedFile, newlyViewedFile]);
      });
      await flush(setup);

      expect(replaceCalls.at(-1)).toEqual(new Set([rehydratedFile.id]));
      expect(expectHandle(handleRef.current).viewedFileIds).toEqual(new Set([rehydratedFile.id]));

      await act(async () => {
        expectHandle(handleRef.current).setViewedFileIds(
          new Set([rehydratedFile.id, newlyViewedFile.id]),
        );
      });
      await flush(setup);

      expect(readFileSync(statePath(oldRepoRoot), "utf8")).toBe(oldStateAfterMark);
      expect(Object.keys(readViewedState(statePath(newRepoRoot)).files).sort()).toEqual(
        [rehydratedFile.path, newlyViewedFile.path].sort(),
      );

      const newStateAfterMark = readFileSync(statePath(newRepoRoot), "utf8");
      await act(async () => {
        const handle = expectHandle(handleRef.current);
        handle.setRepoRoot(null);
        handle.setViewedFileIds(new Set());
      });
      await flush(setup);

      expect(readFileSync(statePath(oldRepoRoot), "utf8")).toBe(oldStateAfterMark);
      expect(readFileSync(statePath(newRepoRoot), "utf8")).toBe(newStateAfterMark);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("is completely inert without a repo root", async () => {
    const repoRoot = createRepoRoot();
    const alpha = createFile("load:0:alpha", "src/alpha.ts", "alpha patch");
    const { handleRef, replaceCalls, setup } = await renderPersistence(null, [alpha]);

    try {
      await flush(setup);
      await act(async () => {
        const handle = expectHandle(handleRef.current);
        handle.setViewedFileIds(new Set([alpha.id]));
        handle.setFiles([{ ...alpha }]);
      });
      await flush(setup);

      expect(replaceCalls).toEqual([]);
      expect(existsSync(statePath(repoRoot))).toBe(false);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("does not rewrite an identical state file during mount rehydration", async () => {
    const repoRoot = createRepoRoot();
    const alpha = createFile("load:0:alpha", "src/alpha.ts", "alpha patch");
    const state: ViewedState = {
      version: 1,
      files: {
        [alpha.path]: {
          patchHash: hashPatch(alpha.patch),
          viewedAt: "2026-07-10T12:00:00.000Z",
        },
      },
    };
    const compactPayload = JSON.stringify(state);
    mkdirSync(join(repoRoot, HUNK_DIR_NAME), { recursive: true });
    writeFileSync(statePath(repoRoot), compactPayload);
    const { setup } = await renderPersistence(repoRoot, [alpha]);

    try {
      await flush(setup);

      expect(readFileSync(statePath(repoRoot), "utf8")).toBe(compactPayload);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
