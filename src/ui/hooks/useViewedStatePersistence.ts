import { join } from "node:path";
import { useLayoutEffect, useMemo, useRef } from "react";
import { HUNK_DIR_NAME, REVIEW_STATE_FILENAME } from "../../core/paths";
import {
  buildNextViewedState,
  mergeViewedPaths,
  mutateViewedState,
  readViewedState,
  resolveViewedPaths,
  viewedStatesEqual,
  type ViewedState,
} from "../../core/viewedState";
import type { DiffFile } from "../../core/types";

interface ViewedStatePersistenceOptions {
  repoRoot: string | null;
  files: DiffFile[];
  viewedFileIds: ReadonlySet<string>;
  replaceViewedFileIds: (next: ReadonlySet<string>) => void;
}

/** Return whether two sets contain exactly the same values. */
function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Rehydrate and best-effort persist per-file viewed progress for one repo-backed review. */
export function useViewedStatePersistence({
  repoRoot,
  files,
  viewedFileIds,
  replaceViewedFileIds,
}: ViewedStatePersistenceOptions): void {
  const filePath = useMemo(
    () => (repoRoot ? join(repoRoot, HUNK_DIR_NAME, REVIEW_STATE_FILENAME) : null),
    [repoRoot],
  );
  const previousStateRef = useRef<ViewedState | null>(null);
  const pendingRehydrationRef = useRef<ReadonlySet<string> | null>(null);
  const activeFilePathRef = useRef<string | null>(null);

  // Layout, like the write below it. These two are one protocol — this one rehydrates from disk
  // and arms `pendingRehydrationRef`, the next reads that flag — so they have to run in
  // declaration order. Leaving this passive while the write is layout inverts them, because every
  // layout effect runs before any passive one.
  useLayoutEffect(() => {
    if (activeFilePathRef.current !== filePath) {
      // A soft reload can reuse this hook for another repo, so discard every old-store snapshot
      // before rehydrating or allowing writes against the new persistence path.
      activeFilePathRef.current = filePath;
      previousStateRef.current = null;
      pendingRehydrationRef.current = null;
    }

    if (!filePath) {
      return;
    }

    const state = readViewedState(filePath);
    const viewedPaths = new Set(resolveViewedPaths(files, state));
    const nextViewedFileIds = new Set(
      files.filter((file) => viewedPaths.has(file.path)).map((file) => file.id),
    );

    previousStateRef.current = state;
    pendingRehydrationRef.current = nextViewedFileIds;
    replaceViewedFileIds(nextViewedFileIds);
  }, [filePath, files, replaceViewedFileIds]);

  // Layout, not passive: the write has to land before the renderer flushes the new `viewed n/m`
  // to the terminal. A passive effect runs after that flush, so the UI would be telling the user
  // their progress was recorded while the file was still being written — the one ordering
  // BRIEF.md's durability floor forbids. The window was ~1ms before viewed writes moved behind
  // the review lock and ~53ms after, measured on linux/amd64, which is what made it observable.
  useLayoutEffect(() => {
    if (!filePath || activeFilePathRef.current !== filePath) {
      return;
    }

    const pendingRehydration = pendingRehydrationRef.current;
    if (pendingRehydration) {
      if (setsEqual(pendingRehydration, viewedFileIds)) {
        pendingRehydrationRef.current = null;
      }
      return;
    }

    const now = new Date();
    const viewedPaths = new Set(
      files.filter((file) => viewedFileIds.has(file.id)).map((file) => file.path),
    );
    // Cheap pre-check, only to avoid taking the lock on every render: when this session's
    // set still matches what it last observed, it has nothing new to say and any peer write
    // is none of its business.
    const cached = previousStateRef.current;
    if (
      cached &&
      viewedStatesEqual(cached, buildNextViewedState(files, viewedPaths, cached, now))
    ) {
      return;
    }

    let mergedPaths: ReadonlySet<string> | null = null;

    // Deliberately unchecked: review progress is best-effort metadata, and an unwritable or
    // contended sidecar must not interrupt the review. The headless command checks the same
    // result.
    const write = mutateViewedState(filePath, (previous) => {
      // No cached snapshot means the last write failed and this session cannot tell which
      // flags a peer moved. Falling back to the locked read makes every difference read as a
      // local toggle, so the user's own pending change still lands.
      const observed = previousStateRef.current ?? previous;
      mergedPaths = mergeViewedPaths(
        files,
        viewedPaths,
        new Set(resolveViewedPaths(files, observed)),
        previous,
      );

      return buildNextViewedState(files, mergedPaths, previous, now);
    });

    previousStateRef.current = write.kind === "written" ? write.state : null;

    if (write.kind !== "written" || !mergedPaths) {
      return;
    }

    // Adopt whatever the merge kept, so the UI shows the peer's marks and the next render
    // does not read them back as a local toggle undoing them.
    const merged: ReadonlySet<string> = mergedPaths;
    const mergedFileIds = new Set(
      files.filter((file) => merged.has(file.path)).map((file) => file.id),
    );
    if (!setsEqual(mergedFileIds, viewedFileIds)) {
      pendingRehydrationRef.current = mergedFileIds;
      replaceViewedFileIds(mergedFileIds);
    }
  }, [filePath, files, viewedFileIds, replaceViewedFileIds]);
}
