import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./fileLock";
import type { DiffFile } from "./changeset/model";
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

/** Outcome of one viewed-state write, so a caller that needs the truth can ask for it. */
export type ViewedStateWrite =
  | { kind: "written"; state: ViewedState }
  | { kind: "unavailable"; reason: string }
  | { kind: "contended"; reason: string };

/** Return whether two viewed-state snapshots contain the same path entries. */
export function viewedStatesEqual(left: ViewedState, right: ViewedState): boolean {
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

/**
 * Apply one change to viewed state under the shared lock.
 *
 * Every writer goes through here — the TUI and the headless command alike — because a
 * writer outside the lock defeats it: it would compute a new state from a snapshot taken
 * before a locked peer's write and then overwrite that peer wholesale. `mutate` therefore
 * receives the state as read from disk *inside* the lock, never a caller's cached copy.
 *
 * The result is returned rather than swallowed because the two callers need opposite things
 * from the same failure: the TUI treats review progress as best-effort metadata and carries
 * on, while a headless `hunk review` invocation owes its client an honest answer and must
 * not report success for a write that never landed.
 */
export function mutateViewedState(
  filePath: string,
  mutate: (previous: ViewedState) => ViewedState,
): ViewedStateWrite {
  try {
    // Before locking, not inside it: the lock is itself a file in this directory.
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (error) {
    return { kind: "unavailable", reason: `Could not create the review directory: ${error}` };
  }

  const locked = withFileLock<ViewedStateWrite>(`${filePath}.lock`, () => {
    const previous = readViewedState(filePath);
    const next = mutate(previous);

    if (viewedStatesEqual(previous, next)) {
      return { kind: "written", state: previous };
    }

    try {
      writeFileSync(filePath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
      return { kind: "written", state: next };
    } catch (error) {
      return { kind: "unavailable", reason: `Could not write ${filePath}: ${String(error)}` };
    }
  });

  return locked.kind === "ran" ? locked.value : locked;
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

/**
 * Merge one session's viewed toggles onto the state another writer may have advanced.
 *
 * Taking the lock stops two writers from interleaving, but it cannot tell a session that its
 * own set is stale: a long-lived TUI reads viewed state once at startup, and by the time the
 * user toggles one file, `hunk review viewed set` may have marked three others. Writing this
 * session's set wholesale would then silently un-view them.
 *
 * So intent is decided per file, not per snapshot. A file whose flag differs from what this
 * session last observed was toggled *here*, and that deliberate act wins. A file this session
 * never touched carries no opinion, so whatever is on disk survives — which is what makes a
 * peer's concurrent write durable rather than a race this session happens to lose.
 */
export function mergeViewedPaths(
  files: Array<Pick<DiffFile, "path" | "patch">>,
  sessionViewedPaths: ReadonlySet<string>,
  observedViewedPaths: ReadonlySet<string>,
  onDisk: ViewedState,
): Set<string> {
  const diskViewedPaths = new Set(resolveViewedPaths(files, onDisk));
  const merged = new Set<string>();

  for (const file of files) {
    const viewedHere = sessionViewedPaths.has(file.path);
    const toggledHere = viewedHere !== observedViewedPaths.has(file.path);

    if (toggledHere ? viewedHere : diskViewedPaths.has(file.path)) {
      merged.add(file.path);
    }
  }

  return merged;
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
