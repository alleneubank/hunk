import { join } from "node:path";
import { useEffect, useMemo, useRef } from "react";
import { HUNK_DIR_NAME, REVIEW_STATE_FILENAME } from "../../core/paths";
import {
  buildNextViewedState,
  readViewedState,
  resolveViewedPaths,
  writeViewedState,
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

/** Return whether two viewed-state snapshots contain the same path entries. */
function viewedStatesEqual(left: ViewedState, right: ViewedState): boolean {
  const leftPaths = Object.keys(left.files);
  const rightPaths = Object.keys(right.files);
  return (
    leftPaths.length === rightPaths.length &&
    leftPaths.every((path) => {
      const leftEntry = left.files[path];
      const rightEntry = right.files[path];
      return (
        leftEntry?.patchHash === rightEntry?.patchHash &&
        leftEntry?.viewedAt === rightEntry?.viewedAt
      );
    })
  );
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

  useEffect(() => {
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

  useEffect(() => {
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

    const previous = previousStateRef.current ?? readViewedState(filePath);
    const viewedPaths = new Set(
      files.filter((file) => viewedFileIds.has(file.id)).map((file) => file.path),
    );
    const next = buildNextViewedState(files, viewedPaths, previous, new Date());
    if (viewedStatesEqual(previous, next)) {
      return;
    }

    writeViewedState(filePath, next);
    previousStateRef.current = next;
  }, [filePath, files, viewedFileIds]);
}
