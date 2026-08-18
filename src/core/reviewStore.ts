import { isAbsolute, join } from "node:path";
import type { AppBootstrap } from "./bootstrap";
import { HUNK_DIR_NAME, REVIEW_COMMENTS_FILENAME, REVIEW_STATE_FILENAME } from "./run/paths";

/**
 * Resolve the repo root whose `.hunk/` directory holds this review's persisted state.
 *
 * The single source of truth for "which repo is this review about". The live TUI, the
 * headless export, and any editor client must agree on it exactly, or the same review
 * reads its viewed state and comments from two different files. Returns `null` for inputs
 * that are not repo-backed — file pairs, patches, and pager content have no store.
 */
export function resolveReviewStoreRepoRoot(bootstrap: AppBootstrap): string | null {
  const repoBackedInput =
    bootstrap.input.kind === "vcs" ||
    bootstrap.input.kind === "show" ||
    bootstrap.input.kind === "stash-show";

  // VCS loaders set sourceLabel to the canonical root. Re-derive it because daemon soft reloads
  // replace bootstrap with resetApp:false and must never retain the previous review's root.
  return repoBackedInput &&
    !bootstrap.input.options.pager &&
    isAbsolute(bootstrap.changeset.sourceLabel)
    ? bootstrap.changeset.sourceLabel
    : null;
}

/** Path of the derived viewed-state file for one repo root. */
export function resolveViewedStatePath(repoRoot: string): string {
  return join(repoRoot, HUNK_DIR_NAME, REVIEW_STATE_FILENAME);
}

/** Path of the authored review-comment store for one repo root. */
export function resolveReviewCommentsPath(repoRoot: string): string {
  return join(repoRoot, HUNK_DIR_NAME, REVIEW_COMMENTS_FILENAME);
}
