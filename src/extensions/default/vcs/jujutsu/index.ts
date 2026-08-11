import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildJjDiffArgs,
  buildJjShowArgs,
  createJjStagedError,
  resolveJjRepoRoot,
  runJjText,
  type JjBackedInput,
} from "../../../../core/vcs/jujutsu";
import {
  HUNK_CORE_VCS_DETECTION_PRIORITY,
  type ExtensionVcsAdapter,
  type ExtensionVcsFileSourceReader,
  type HunkExtensionAPI,
} from "../../../../extension-api/types";

/**
 * Hunk's Jujutsu backend, as a bundled extension.
 *
 * This file is written the way a third-party VCS extension would be: it sees
 * only the published `hunkdiff/extension` contract plus its own implementation
 * helpers in `src/core/vcs/jujutsu.ts`. If something here cannot be said in those types,
 * the contract is missing something.
 */

/** Return the last path segment for review titles. */
function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Walk upward to detect a Jujutsu workspace marker without spawning JJ during config resolution. */
function detectJjRepo(cwd: string) {
  let current = resolve(cwd);
  for (;;) {
    if (fs.existsSync(join(current, ".jj"))) {
      return { id: "jj" as const, repoRoot: current };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Read the exact parent/current pair that `jj diff -r` compares. */
function createJjSourceReader(input: JjBackedInput, cwd: string): ExtensionVcsFileSourceReader {
  const newRevision = input.kind === "show" ? (input.ref ?? "@") : (input.range ?? "@");
  const oldRevision = `${newRevision}-`;

  return async ({ path, previousPath, changeType, side }) => {
    if ((changeType === "new" && side === "old") || (changeType === "deleted" && side === "new")) {
      return null;
    }

    const sourcePath = side === "old" ? (previousPath ?? path) : path;
    return runJjText({
      input,
      args: [
        "file",
        "show",
        "--revision",
        side === "old" ? oldRevision : newRevision,
        "--",
        sourcePath,
      ],
      cwd,
    });
  };
}

/** VCS adapter translating neutral review operations to Jujutsu commands. */
export const JjVcsAdapter = {
  id: "jj",
  name: "Jujutsu",
  detect: detectJjRepo,
  // Above Git: a colocated jj repository carries a `.git` directory too, and
  // reviewing it as plain Git would show the wrong working copy.
  detectionPriority: HUNK_CORE_VCS_DETECTION_PRIORITY + 200,
  operations: {
    "working-tree-diff": {
      async load(input, { cwd }) {
        if (input.staged) {
          throw createJjStagedError(input);
        }
        const repoRoot = resolveJjRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: input.range ? `${repoName} ${input.range}` : `${repoName} working copy`,
          patchText: runJjText({ input, args: buildJjDiffArgs(input), cwd }),
          sourceCapabilities: {
            old: "hunk" as const,
            new: input.range ? ("hunk" as const) : ("workspace" as const),
          },
          readFileSource: createJjSourceReader(input, cwd),
        };
      },
      watchSignature(input, { cwd }) {
        return runJjText({ input, args: buildJjDiffArgs(input), cwd });
      },
    },
    "revision-show": {
      async load(input, { cwd }) {
        const repoRoot = resolveJjRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        const revset = input.ref ?? "@";
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: `${repoName} show ${revset}`,
          patchText: runJjText({ input, args: buildJjShowArgs(input), cwd }),
          sourceCapabilities: { old: "hunk" as const, new: "hunk" as const },
          readFileSource: createJjSourceReader(input, cwd),
        };
      },
      watchSignature(input, { cwd }) {
        return runJjText({ input, args: buildJjShowArgs(input), cwd });
      },
    },
  },
} satisfies ExtensionVcsAdapter;

export default function (hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter(JjVcsAdapter);
}
