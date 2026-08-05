import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup, persistence, and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY viewed state", () => {
  test("v toggles the selected file viewed in the sidebar and progress", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/viewed 0\/5/, { timeout: 15_000 });
      expect(initial).toMatch(/M alpha\.ts\s+\+2 -1/);

      await session.press("v");
      const viewed = await harness.waitForSnapshot(
        session,
        (text) => text.includes("viewed 1/5") && /M alpha\.ts\s+✓ \+2 -1/.test(text),
        5_000,
      );

      expect(viewed).toContain("viewed 1/5");
      expect(viewed).toMatch(/M alpha\.ts\s+✓ \+2 -1/);

      await session.press("v");
      const unviewed = await harness.waitForSnapshot(
        session,
        (text) => text.includes("viewed 0/5") && !/M alpha\.ts\s+✓/.test(text),
        5_000,
      );

      expect(unviewed).toContain("viewed 0/5");
      expect(unviewed).not.toMatch(/M alpha\.ts\s+✓/);
    } finally {
      session.close();
    }
  });

  test("> skips a viewed file and wraps to the first unviewed file", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 14,
    });

    try {
      await session.waitForText(/viewed 0\/5/, { timeout: 15_000 });

      await session.click(/M beta\.ts\s+\+2 -1/);
      // Beta is already on the first frame beside alpha, so its content alone proves nothing.
      // Wait for alpha to scroll off instead: that only happens once the click has committed a
      // new selection, which is what the following `v` depends on. Without it `v` races the
      // click and marks whichever file was selected first.
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("betaOnly = true") && !text.includes("alphaOnly = true"),
        5_000,
      );
      await session.press("v");
      await session.click(/M alpha\.ts\s+\+2 -1/);
      await harness.waitForSnapshot(session, (text) => text.includes("alphaOnly = true"), 5_000);

      await session.press(">");
      const skipped = await harness.waitForSnapshot(
        session,
        (text) => text.includes("deltaOnly = true") && !text.includes("alphaOnly = true"),
        5_000,
      );

      expect(skipped).toContain("deltaOnly = true");
      expect(skipped).not.toContain("betaOnly = true");

      await session.click(/M gamma\.ts\s+\+2 -1/);
      await harness.waitForSnapshot(session, (text) => text.includes("gammaOnly = true"), 5_000);
      await session.press(">");
      const wrapped = await harness.waitForSnapshot(
        session,
        (text) => text.includes("alphaOnly = true") && !text.includes("gammaOnly = true"),
        5_000,
      );

      expect(wrapped).toContain("alphaOnly = true");
      expect(wrapped).not.toContain("gammaOnly = true");
    } finally {
      session.close();
    }
  });

  test("viewed state persists after quitting and relaunching the same repo diff", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const stateFile = join(fixture.dir, ".hunk", "review-state.json");
    const firstSession = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 14,
    });

    try {
      await firstSession.waitForText(/viewed 0\/2/, { timeout: 15_000 });
      await firstSession.press("v");
      await harness.waitForSnapshot(
        firstSession,
        (text) => text.includes("viewed 1/2") && /M alpha\.ts\s+✓ \+2 -1/.test(text),
        5_000,
      );
      expect(existsSync(stateFile)).toBe(true);

      await firstSession.press("q");
      await firstSession.waitIdle({ timeout: 500 });
    } finally {
      firstSession.close();
    }

    const secondSession = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 14,
    });

    try {
      const restored = await secondSession.waitForText(/viewed 1\/2/, { timeout: 15_000 });

      expect(restored).toMatch(/M alpha\.ts\s+✓ \+2 -1/);
      expect(existsSync(stateFile)).toBe(true);
    } finally {
      secondSession.close();
    }
  });
});
