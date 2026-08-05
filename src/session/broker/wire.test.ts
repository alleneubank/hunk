import { describe, expect, test } from "bun:test";
import {
  MAX_REGISTRATION_FILES,
  MAX_REGISTRATION_HUNKS_PER_FILE,
  MAX_REGISTRATION_PATCH_BYTES,
  MAX_SNAPSHOT_LIVE_COMMENTS,
  MAX_SNAPSHOT_REVIEW_NOTES,
  SESSION_BROKER_REGISTRATION_VERSION,
} from "@hunk/session-broker-core";
import { parseSessionRegistration, parseSessionSnapshot } from "./wire";

function createRegistration(files: unknown[]) {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    info: { inputKind: "vcs", title: "repo working tree", sourceLabel: "/repo", files },
  };
}

function createFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    path: "src/example.ts",
    additions: 1,
    deletions: 0,
    hunks: [{ index: 0, header: "@@ -1 +1 @@" }],
    ...overrides,
  };
}

function createValidComment(overrides: Record<string, unknown> = {}) {
  return {
    commentId: "comment-1",
    filePath: "src/example.ts",
    hunkIndex: 0,
    side: "new",
    line: 4,
    summary: "Review note",
    createdAt: "2026-03-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("hunk session wire parsing", () => {
  test("snapshot comment counts only include validated comment summaries", () => {
    const snapshot = parseSessionSnapshot({
      updatedAt: "2026-03-22T00:00:00.000Z",
      state: {
        selectedFileId: "file-1",
        selectedFilePath: "src/example.ts",
        selectedHunkIndex: 0,
        showAgentNotes: true,
        liveCommentCount: 5,
        liveComments: [
          createValidComment(),
          {
            filePath: "src/example.ts",
            summary: "Missing comment id and line.",
          },
        ],
      },
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.state.liveComments).toHaveLength(1);
    expect(snapshot?.state.liveCommentCount).toBe(1);
  });

  test("snapshot carries the live note markup width and drops invalid values", () => {
    const parse = (noteMarkupWidth: unknown) =>
      parseSessionSnapshot({
        updatedAt: "2026-03-22T00:00:00.000Z",
        state: {
          selectedHunkIndex: 0,
          showAgentNotes: true,
          noteMarkupWidth,
          liveComments: [],
        },
      });

    expect(parse(112)?.state.noteMarkupWidth).toBe(112);
    expect(parse("wide")?.state.noteMarkupWidth).toBeUndefined();
    expect(parse(undefined)?.state.noteMarkupWidth).toBeUndefined();
  });

  test("registration parses app info from the nested broker envelope", () => {
    const registration = parseSessionRegistration({
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: "session-1",
      pid: 123,
      cwd: "/repo",
      launchedAt: "2026-03-22T00:00:00.000Z",
      info: {
        inputKind: "vcs",
        title: "repo working tree",
        sourceLabel: "/repo",
        files: [],
      },
    });

    expect(registration?.info).toEqual({
      inputKind: "vcs",
      title: "repo working tree",
      sourceLabel: "/repo",
      experimentalFeatures: [],
      files: [],
    });
  });

  // Registrations cross between independently installed binaries, so absence and
  // malformedness must be treated differently: one is an older peer, the other is a broken
  // payload that would silently change which document a client opens.
  test("registration defaults an absent changeType but rejects an invalid one", () => {
    const parseFile = (file: Record<string, unknown>) =>
      parseSessionRegistration({
        registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
        sessionId: "session-1",
        pid: 123,
        cwd: "/repo",
        launchedAt: "2026-03-22T00:00:00.000Z",
        info: {
          inputKind: "vcs",
          title: "repo working tree",
          sourceLabel: "/repo",
          files: [{ id: "f1", path: "a.ts", additions: 1, deletions: 0, hunks: [], ...file }],
        },
      })?.info.files;

    expect(parseFile({})?.[0]?.changeType).toBe("change");
    expect(parseFile({ changeType: "deleted" })?.[0]?.changeType).toBe("deleted");
    // Not coerced: an unknown value fails validation like any other malformed field, which
    // rejects the registration rather than admitting a file whose change kind is a guess.
    expect(parseFile({ changeType: "removed" })).toBeUndefined();
    expect(parseFile({ changeType: 7 })).toBeUndefined();
  });

  test("registration carries agent summaries and bounds their length", () => {
    const overLong = "s".repeat(5_000);
    const registration = parseSessionRegistration({
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: "session-1",
      pid: 123,
      cwd: "/repo",
      launchedAt: "2026-03-22T00:00:00.000Z",
      info: {
        inputKind: "vcs",
        title: "repo working tree",
        sourceLabel: "/repo",
        agentSummary: "What this whole change does.",
        files: [
          { id: "f1", path: "a.ts", additions: 1, deletions: 0, hunks: [], agentSummary: overLong },
        ],
      },
    });

    expect(registration?.info.agentSummary).toBe("What this whole change does.");
    // Truncated, not rejected: descriptive text from a peer is bounded, but an over-long
    // one is a sloppy sidecar rather than a corrupt registration, and dropping the whole
    // review over it would lose the diff too.
    expect(registration?.info.files[0]?.agentSummary).toHaveLength(4_000);
  });

  test("registration preserves only recognized experimental feature ids", () => {
    const registration = parseSessionRegistration({
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: "session-1",
      pid: 123,
      cwd: "/repo",
      launchedAt: "2026-03-22T00:00:00.000Z",
      info: {
        inputKind: "vcs",
        title: "repo working tree",
        sourceLabel: "/repo",
        experimentalFeatures: ["stml", "future-feature", "stml", 42],
        files: [],
      },
    });

    expect(registration?.info.experimentalFeatures).toEqual(["stml"]);
  });

  test("rejects registrations with more files than the cap", () => {
    const files = Array.from({ length: MAX_REGISTRATION_FILES + 1 }, (_, index) =>
      createFile({ id: `file-${index}`, path: `src/file-${index}.ts` }),
    );

    expect(parseSessionRegistration(createRegistration(files))).toBeNull();
  });

  test("rejects files with more hunks than the per-file cap", () => {
    const hunks = Array.from({ length: MAX_REGISTRATION_HUNKS_PER_FILE + 1 }, (_, index) => ({
      index,
      header: `@@ hunk ${index} @@`,
    }));

    expect(parseSessionRegistration(createRegistration([createFile({ hunks })]))).toBeNull();
  });

  test("rejects files whose patch exceeds the byte cap", () => {
    const patch = "x".repeat(MAX_REGISTRATION_PATCH_BYTES + 1);

    expect(parseSessionRegistration(createRegistration([createFile({ patch })]))).toBeNull();
  });

  test("rejects snapshots with more live comments than the cap", () => {
    const liveComments = Array.from({ length: MAX_SNAPSHOT_LIVE_COMMENTS + 1 }, (_, index) =>
      createValidComment({ commentId: `comment-${index}` }),
    );

    const snapshot = parseSessionSnapshot({
      updatedAt: "2026-03-22T00:00:00.000Z",
      state: { selectedHunkIndex: 0, showAgentNotes: true, liveComments },
    });

    expect(snapshot).toBeNull();
  });

  test("rejects snapshots with more review notes than the cap", () => {
    const reviewNotes = Array.from({ length: MAX_SNAPSHOT_REVIEW_NOTES + 1 }, (_, index) => ({
      noteId: `note-${index}`,
      source: "user",
      filePath: "src/example.ts",
      body: "Looks good",
      createdAt: "2026-03-22T00:00:00.000Z",
    }));

    const snapshot = parseSessionSnapshot({
      updatedAt: "2026-03-22T00:00:00.000Z",
      state: { selectedHunkIndex: 0, showAgentNotes: true, liveComments: [], reviewNotes },
    });

    expect(snapshot).toBeNull();
  });
});
