import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { createServer } from "node:net";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";
import { parseSessionSnapshot } from "../../src/session/broker/wire";
import { HUNK_SESSION_DAEMON_VERSION } from "../../src/session/protocol";

const repoRoot = process.cwd();
// Spawned hunk processes must assert built-in defaults, not the developer's ambient user config.
const testConfigHome = createTestConfigHome();

afterAll(cleanupTestConfigHomes);
const spawned: Subprocess[] = [];

async function reserveLoopbackPort() {
  const listener = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 1_500,
  intervalMs = 20,
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await Bun.sleep(intervalMs);
  }
}

async function readHealth(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as { ok: boolean; pid: number };
  } catch {
    return null;
  }
}

afterEach(async () => {
  await Promise.allSettled(
    spawned.splice(0).map(async (proc) => {
      try {
        proc.kill();
      } catch {
        // Ignore processes that already exited.
      }

      await proc.exited.catch(() => undefined);
    }),
  );
});

describe("session daemon lifecycle", () => {
  test("defaults viewed progress for snapshots from older peers", () => {
    const snapshot = parseSessionSnapshot({
      updatedAt: "2026-07-11T00:00:00.000Z",
      state: {
        selectedHunkIndex: 0,
        showAgentNotes: false,
        liveComments: [],
      },
    });

    expect(snapshot?.state).toMatchObject({
      viewedFileCount: 0,
      viewedFilePaths: [],
    });
  });

  test("advertises the current daemon version and viewed-set support", async () => {
    const port = await reserveLoopbackPort();
    const proc = Bun.spawn(["bun", "run", "src/main.tsx", "daemon", "serve"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: testConfigHome,
        HUNK_MCP_PORT: String(port),
      },
    });
    spawned.push(proc);

    await waitUntil("daemon health", () => readHealth(port), 3_000, 50);
    const response = await fetch(`http://127.0.0.1:${port}/session-api/capabilities`);

    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({
      // Pinned to the exported constant, not a literal: the wire must advertise the same
      // compatibility version clients check, and a bump should not require editing this test.
      daemonVersion: HUNK_SESSION_DAEMON_VERSION,
      actions: expect.arrayContaining(["viewed-set"]),
    });
  }, 10_000);

  test("exits cleanly after SIGTERM instead of hot-looping after server shutdown", async () => {
    const port = await reserveLoopbackPort();
    const proc = Bun.spawn(["bun", "run", "src/main.tsx", "daemon", "serve"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: testConfigHome,
        HUNK_MCP_PORT: String(port),
      },
    });
    spawned.push(proc);

    const health = await waitUntil("daemon health", () => readHealth(port), 3_000, 50);
    expect(health).toMatchObject({ ok: true, pid: proc.pid });

    let exited = false;
    void proc.exited.then(() => {
      exited = true;
    });

    process.kill(proc.pid, "SIGTERM");

    await waitUntil("daemon serve process exit", () => (exited ? true : null), 1_500, 25);
    await waitUntil("daemon port close", async () =>
      (await readHealth(port)) === null ? true : null,
    );
  }, 10_000);
});
