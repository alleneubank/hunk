/**
 * Cross-process advisory locking for the `.hunk/` review stores.
 *
 * Both durable stores — the comment store and viewed state — are read-modify-written by
 * whichever Hunk process the user happens to be running: a TUI session, a headless
 * `hunk review` invocation from an editor, an agent through the session CLI. They share one
 * lock implementation rather than two, because a second implementation is a second set of
 * reclaim rules, and two processes disagreeing about when a lock is abandoned is exactly
 * the failure the lock exists to prevent.
 *
 * The lock is a file created with `wx`, which is atomic on every platform Hunk targets.
 * Reclaiming an abandoned one is serialized behind a second marker; see `reclaimStaleLock`.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isRecord } from "./typeGuards";

/**
 * Bounded lock acquisition: never wait on a peer forever.
 *
 * The budget is ~1s, two orders of magnitude above the few milliseconds a writer actually
 * holds the lock, so contention that outlives it means a genuinely stuck peer rather than
 * ordinary interleaving.
 */
const LOCK_ATTEMPTS_MAX = 40;
const LOCK_RETRY_DELAY_MS = 25;
/** A lock older than this whose owner cannot be identified is treated as abandoned. */
const LOCK_STALE_MS = 10_000;

/**
 * Outcome of a locked section.
 *
 * `contended` and `unavailable` are separate because the caller's remedy differs: a peer
 * holding the lock means retry, while a directory that cannot be written means nothing will
 * ever succeed until the user fixes it.
 */
export type FileLockResult<T> =
  | { kind: "ran"; value: T }
  | { kind: "contended"; reason: string }
  | { kind: "unavailable"; reason: string };

/** Report whether a process id is still alive, without signalling it. */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return isRecord(error) && error.code === "EPERM";
  }
}

/** Read a lock file's exact bytes, or `undefined` when it is gone or unreadable. */
function readLockFile(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

/** The owner token recorded in a lock file, when it has one. */
function lockToken(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }

  try {
    const payload: unknown = JSON.parse(raw);
    return isRecord(payload) ? payload.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the lock these bytes came from is abandoned.
 *
 * Two independent reclaim reasons, because either signal alone can be missing: a lock
 * naming a dead owner is stale immediately, and a lock we cannot parse at all is stale once
 * it is older than `LOCK_STALE_MS` by its own mtime. A live owner is never stale, so a
 * running writer is never reclaimed out from under itself.
 */
function lockIsStale(raw: string | undefined, lockPath: string): boolean {
  if (raw === undefined) {
    return false;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }

  if (isRecord(payload) && typeof payload.ownerPid === "number") {
    return !processIsAlive(payload.ownerPid);
  }

  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    // Already gone; there is nothing to reclaim.
    return false;
  }
}

/**
 * Reclaim the lock whose contents are `observed`, if that lock is abandoned.
 *
 * Judging a lock stale and removing it are two steps, and everything hard about this
 * function lives in the gap between them. A reclaimer that acts on the path alone can carry
 * off a *successor's* live lock — the successor being, typically, a faster reclaimer that
 * already cleaned up and took the lock for itself. Two writers then share the critical
 * section, which is the one outcome a lock exists to prevent.
 *
 * Binding the removal to `observed` is necessary but not sufficient on its own: no
 * filesystem offers "remove only if the contents still match" as one atomic step, so any
 * verify-then-remove written directly against `lockPath` keeps a window. Moving the file
 * aside to inspect it does not help either, because the move is itself the destructive act.
 *
 * So the reclaim is serialized instead. A second exclusive marker admits one reclaimer at a
 * time, and that reclaimer re-reads the lock *after* winning the marker. Any lock that
 * changed since it was judged — including one a previous reclaimer already replaced — fails
 * that comparison and is left strictly alone.
 *
 * A process that dies holding the marker leaves it behind, and reclamation then stops until
 * the marker ages out. That is the fail-closed direction: acquisition degrades to reporting
 * contention, which is a caller-visible retry, never two writers at once.
 */
export function reclaimStaleLock(lockPath: string, observed: string | undefined): void {
  if (!lockIsStale(observed, lockPath)) {
    return;
  }

  const markerPath = `${lockPath}.reclaim`;
  try {
    writeFileSync(markerPath, JSON.stringify({ ownerPid: process.pid }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // Another reclaimer holds the marker, or the marker is stuck. Either way this attempt
    // touches nothing; the next one observes whatever the winner left behind.
    clearStuckReclaimMarker(markerPath);
    return;
  }

  try {
    // Re-read under the marker. Between the judgement and here, a peer may have reclaimed
    // this lock and taken it — that successor is live and is not ours to remove.
    if (readLockFile(lockPath) !== observed) {
      return;
    }

    rmSync(lockPath, { force: true });
  } finally {
    // KNOWN OPEN: this removes whatever sits at the marker path, not the marker this call
    // wrote. Paired with the unbound removal in `clearStuckReclaimMarker`, it is how two
    // reclaimers can still overlap. See SPEC.md "Open items".
    rmSync(markerPath, { force: true });
  }
}

/**
 * Drop a reclaim marker whose owner died before releasing it.
 *
 * The marker is held across two filesystem calls, so a live owner is never more than
 * momentarily present. Age is therefore a sounder signal here than it is for the lock
 * itself, and leaving a dead owner's marker in place would wedge reclamation permanently.
 *
 * KNOWN OPEN: sounder is not sound. The removal is unbound — nothing ties it to the marker
 * whose age and owner were judged — so a cleaner delayed between the judgement and the
 * `rmSync` can carry off a live reclaimer's marker and readmit a second reclaimer. Every
 * attempt to bind this by path, bytes, or token has relocated the race rather than removed
 * it; SPEC.md "Open items" records why, and what actually fixes it.
 */
function clearStuckReclaimMarker(markerPath: string): void {
  const raw = readLockFile(markerPath);
  if (raw === undefined) {
    return;
  }

  let ownerIsGone = false;
  try {
    const payload: unknown = JSON.parse(raw);
    ownerIsGone =
      isRecord(payload) && typeof payload.ownerPid === "number"
        ? !processIsAlive(payload.ownerPid)
        : true;
  } catch {
    ownerIsGone = true;
  }

  try {
    if (ownerIsGone && Date.now() - statSync(markerPath).mtimeMs > LOCK_STALE_MS) {
      rmSync(markerPath, { force: true });
    }
  } catch {
    // Already gone, or unreadable; the next attempt re-evaluates.
  }
}

/** Result of one acquisition attempt, distinguishing a busy lock from a broken path. */
type LockAcquisition =
  | { kind: "acquired"; token: string }
  | { kind: "contended" }
  | { kind: "unavailable"; reason: string };

/** Take an exclusive lock, returning the token that proves ownership of it. */
function acquireLock(lockPath: string): LockAcquisition {
  const token = randomUUID();

  for (let attempt = 0; attempt < LOCK_ATTEMPTS_MAX; attempt += 1) {
    const observed = readLockFile(lockPath);

    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ ownerPid: process.pid, token, acquiredAt: new Date().toISOString() }),
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
      return { kind: "acquired", token };
    } catch (error) {
      // Only `EEXIST` is contention. A permission, read-only, or out-of-space failure will
      // never resolve by waiting, and reporting it as a busy peer sends the user to retry
      // something that cannot succeed.
      if (!isRecord(error) || error.code !== "EEXIST") {
        return { kind: "unavailable", reason: `Could not create ${lockPath}: ${String(error)}` };
      }

      reclaimStaleLock(lockPath, observed);
      Bun.sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }

  return { kind: "contended" };
}

/**
 * Release a lock only if this process still owns it.
 *
 * Unconditionally unlinking would delete a successor's lock in the window after ours was
 * reclaimed, which is the same double-entry bug `reclaimStaleLock` avoids.
 */
function releaseLock(lockPath: string, token: string): void {
  if (lockToken(readLockFile(lockPath)) !== token) {
    return;
  }

  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Already gone; nothing to release.
  }
}

/**
 * Run one function while holding `lockPath`, or report contention without running it.
 *
 * Not running is the point: a caller that proceeds after a failed acquisition has no
 * exclusivity, and a read-modify-write without exclusivity can drop a concurrent peer's
 * write. The lock is always released, including when `run` throws.
 */
export function withFileLock<T>(lockPath: string, run: () => T): FileLockResult<T> {
  const acquisition = acquireLock(lockPath);

  if (acquisition.kind === "unavailable") {
    return acquisition;
  }

  if (acquisition.kind === "contended") {
    return { kind: "contended", reason: `Another process is holding ${lockPath}.` };
  }

  try {
    return { kind: "ran", value: run() };
  } finally {
    releaseLock(lockPath, acquisition.token);
  }
}
