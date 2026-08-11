import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reclaimStaleLock, withFileLock } from "./fileLock";

function createLockDir() {
  return mkdtempSync(join(tmpdir(), "hunk-file-lock-"));
}

/** A lock file naming an owner that cannot be running. */
function writeDeadOwnerLock(lockPath: string) {
  writeFileSync(
    lockPath,
    JSON.stringify({ ownerPid: 0, token: "dead", acquiredAt: new Date().toISOString() }),
    "utf8",
  );
}

describe("withFileLock", () => {
  test("runs under the lock and releases it", () => {
    const lockPath = join(createLockDir(), "store.json.lock");

    const result = withFileLock(lockPath, () => {
      expect(existsSync(lockPath)).toBe(true);
      return "value";
    });

    expect(result).toEqual({ kind: "ran", value: "value" });
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releases the lock when the body throws", () => {
    const lockPath = join(createLockDir(), "store.json.lock");

    expect(() =>
      withFileLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reports contention without running when a live peer holds the lock", () => {
    const lockPath = join(createLockDir(), "store.json.lock");
    // This process is alive, so the reclaim path must leave the lock alone.
    writeFileSync(
      lockPath,
      JSON.stringify({ ownerPid: process.pid, token: "peer", acquiredAt: "2026-08-01T00:00:00Z" }),
      "utf8",
    );

    let ran = false;
    const result = withFileLock(lockPath, () => {
      ran = true;
    });

    expect(result.kind).toBe("contended");
    expect(ran).toBe(false);
    // The peer still holds exactly what it wrote.
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("peer");
  });

  test("reclaims a lock left behind by a dead owner", () => {
    const lockPath = join(createLockDir(), "store.json.lock");
    writeDeadOwnerLock(lockPath);

    expect(withFileLock(lockPath, () => "ran").kind).toBe("ran");
  });

  // Several real processes start against the same abandoned lock, so they all judge it
  // stale at once and race through the reclaim path. A lost increment means two sections
  // overlapped.
  //
  // This is a regression guard, not the proof that the rename-based reclaim is needed: the
  // unlink race it replaced has a sub-microsecond window and does not reproduce on demand.
  // The ownership-checked release below is the direction that fails against the old code.
  test("concurrent reclaimers still get mutual exclusion", async () => {
    const dir = createLockDir();
    const lockPath = join(dir, "store.json.lock");
    const counterPath = join(dir, "counter.json");
    const scriptPath = join(dir, "writer.ts");
    writeDeadOwnerLock(lockPath);
    writeFileSync(counterPath, JSON.stringify({ count: 0 }), "utf8");

    writeFileSync(
      scriptPath,
      `import { readFileSync, writeFileSync } from "node:fs";
import { withFileLock } from ${JSON.stringify(join(import.meta.dir, "fileLock.ts"))};
const [lockPath, counterPath, rounds] = process.argv.slice(2);
let ran = 0;
for (let index = 0; index < Number(rounds); index += 1) {
  const result = withFileLock(lockPath, () => {
    // Read, pause, write: a wide window, so any overlap loses an increment.
    const current = JSON.parse(readFileSync(counterPath, "utf8")).count;
    Bun.sleepSync(1);
    writeFileSync(counterPath, JSON.stringify({ count: current + 1 }), "utf8");
  });
  if (result.kind === "ran") {
    ran += 1;
  }
}
console.log(ran);
`,
      "utf8",
    );

    const runs = [0, 1, 2].map(() =>
      Bun.spawn(["bun", "run", scriptPath, lockPath, counterPath, "15"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const ran = await Promise.all(
      runs.map(async (proc) => {
        await proc.exited;
        return Number((await new Response(proc.stdout).text()).trim());
      }),
    );

    const expected = ran.reduce((total, count) => total + count, 0);
    expect(expected).toBeGreaterThan(0);
    // Every section that ran incremented exactly once. A lost update means two overlapped.
    expect(JSON.parse(readFileSync(counterPath, "utf8")).count).toBe(expected);
  }, 60_000);

  // A reclaimer judges a lock stale, then acts on it. The two are not one instruction, and
  // whatever sits at the path when it acts may be a *successor's* live lock. Passing bytes
  // that no longer match is exactly that window, made deterministic.
  test("does not reclaim a lock that replaced the one it judged", () => {
    const lockPath = join(createLockDir(), "store.json.lock");
    const judged = JSON.stringify({
      ownerPid: 0,
      token: "dead",
      acquiredAt: "2026-08-01T00:00:00Z",
    });
    // The successor: a different, live owner now holds the path.
    const successor = JSON.stringify({ ownerPid: process.pid, token: "successor" });
    writeFileSync(lockPath, successor, "utf8");

    reclaimStaleLock(lockPath, judged);

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(successor);
  });

  // Serialization is what makes the reclaim safe: while one reclaimer holds the marker, a
  // second must not touch the lock at all, because the first may be about to replace it with
  // its own live lock.
  test("does not reclaim while another reclaimer holds the marker", () => {
    const lockPath = join(createLockDir(), "store.json.lock");
    const abandoned = JSON.stringify({ ownerPid: 0, token: "dead" });
    writeFileSync(lockPath, abandoned, "utf8");
    // A live owner, so the marker is not treated as stuck.
    writeFileSync(`${lockPath}.reclaim`, JSON.stringify({ ownerPid: process.pid }), "utf8");

    reclaimStaleLock(lockPath, abandoned);

    expect(readFileSync(lockPath, "utf8")).toBe(abandoned);
  });

  // A process that dies holding the marker would otherwise wedge reclamation forever.
  test("clears a reclaim marker left behind by a dead owner", () => {
    const lockPath = join(createLockDir(), "store.json.lock");
    const markerPath = `${lockPath}.reclaim`;
    const abandoned = JSON.stringify({ ownerPid: 0, token: "dead" });
    writeFileSync(lockPath, abandoned, "utf8");
    writeFileSync(markerPath, JSON.stringify({ ownerPid: 0 }), "utf8");
    // Older than the stale window, which is the second half of the stuck-marker test.
    const aged = new Date(Date.now() - 60_000);
    utimesSync(markerPath, aged, aged);

    // The first attempt clears the marker; the next one can then reclaim.
    reclaimStaleLock(lockPath, abandoned);
    expect(existsSync(markerPath)).toBe(false);

    reclaimStaleLock(lockPath, abandoned);
    expect(existsSync(lockPath)).toBe(false);
  });

  // Contention resolves by waiting; a broken path never does. Reporting the second as the
  // first sends the user to retry something that cannot succeed.
  test("reports an unwritable lock path as unavailable, not contended", () => {
    // A file where the lock's parent directory should be: creating the lock fails with
    // ENOTDIR on every platform, without depending on permissions the test runner may hold.
    const blocker = join(createLockDir(), "not-a-directory");
    writeFileSync(blocker, "", "utf8");

    let ran = false;
    const result = withFileLock(join(blocker, "store.json.lock"), () => {
      ran = true;
    });

    expect(result.kind).toBe("unavailable");
    expect(ran).toBe(false);
  });

  // Releasing is ownership-checked, so a section whose lock was replaced cannot delete the
  // successor's.
  test("does not delete a lock it no longer owns", () => {
    const lockPath = join(createLockDir(), "store.json.lock");

    withFileLock(lockPath, () => {
      // Stand in for a successor: something else now owns this path.
      writeFileSync(
        lockPath,
        JSON.stringify({ ownerPid: process.pid, token: "successor" }),
        "utf8",
      );
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("successor");
  });
});
