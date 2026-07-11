import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DiffFile } from "./types";
import { isRecord } from "./typeGuards";

const VIEWED_STATE_VERSION = 1;
const VIEWED_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface ViewedStateFile {
  patchHash: string;
  viewedAt: string;
}

export interface ViewedState {
  version: 1;
  files: Record<string, ViewedStateFile>;
}

/** Create a fresh empty state so tolerant reads never share mutable file records. */
function emptyViewedState(): ViewedState {
  return { version: VIEWED_STATE_VERSION, files: {} };
}

/** Validate the complete persisted schema before allowing any entry to affect a review. */
function isViewedState(value: unknown): value is ViewedState {
  if (!isRecord(value) || value.version !== VIEWED_STATE_VERSION || !isRecord(value.files)) {
    return false;
  }

  return Object.values(value.files).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.patchHash === "string" &&
      SHA256_HEX_PATTERN.test(entry.patchHash) &&
      typeof entry.viewedAt === "string" &&
      Number.isFinite(Date.parse(entry.viewedAt)),
  );
}

/** Hash the raw patch text used to decide whether persisted viewed state still applies. */
export function hashPatch(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

/** Read one persisted state file, treating every filesystem or schema error as empty state. */
export function readViewedState(filePath: string): ViewedState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isViewedState(parsed) ? parsed : emptyViewedState();
  } catch {
    return emptyViewedState();
  }
}

/** Persist viewed state without allowing local review metadata failures to crash the app. */
export function writeViewedState(filePath: string, state: ViewedState): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Review progress is best-effort metadata; an unwritable sidecar must not end the review.
  }
}

/** Resolve persisted paths whose current raw patch still has the recorded hash. */
export function resolveViewedPaths(
  files: Array<Pick<DiffFile, "path" | "patch">>,
  state: ViewedState,
): string[] {
  return files
    .filter((file) => state.files[file.path]?.patchHash === hashPatch(file.patch))
    .map((file) => file.path);
}

/** Merge current viewed paths into retained state while pruning entries older than 30 days. */
export function buildNextViewedState(
  files: Array<Pick<DiffFile, "path" | "patch">>,
  viewedPaths: ReadonlySet<string>,
  previous: ViewedState,
  now: Date,
): ViewedState {
  const currentPaths = new Set(files.map((file) => file.path));
  const retentionCutoff = now.getTime() - VIEWED_STATE_RETENTION_MS;
  const nextFiles: Record<string, ViewedStateFile> = {};

  for (const [path, entry] of Object.entries(previous.files)) {
    const viewedAt = Date.parse(entry.viewedAt);
    if (!currentPaths.has(path) && Number.isFinite(viewedAt) && viewedAt >= retentionCutoff) {
      nextFiles[path] = entry;
    }
  }

  for (const file of files) {
    if (!viewedPaths.has(file.path)) {
      continue;
    }

    const patchHash = hashPatch(file.patch);
    const previousEntry = previous.files[file.path];
    const previousViewedAt = previousEntry ? Date.parse(previousEntry.viewedAt) : Number.NaN;
    const keepPreviousViewedAt =
      previousEntry?.patchHash === patchHash &&
      Number.isFinite(previousViewedAt) &&
      previousViewedAt >= retentionCutoff;
    nextFiles[file.path] = {
      patchHash,
      viewedAt: keepPreviousViewedAt ? previousEntry.viewedAt : now.toISOString(),
    };
  }

  return { version: VIEWED_STATE_VERSION, files: nextFiles };
}
