import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Name of hunk's repo-local metadata directory. */
export const HUNK_DIR_NAME = ".hunk";
/** Conventional agent-context sidecar filename inside `.hunk/`. */
export const AGENT_CONTEXT_FILENAME = "agent-context.json";
/** Conventional per-repo review-state filename inside `.hunk/`. */
export const REVIEW_STATE_FILENAME = "review-state.json";
/**
 * Conventional per-repo review-comment filename inside `.hunk/`.
 *
 * Separate from `REVIEW_STATE_FILENAME` on purpose: viewed state is derived and resets on
 * any doubt, while comments are authored and are never discarded. One file cannot carry
 * both policies.
 */
export const REVIEW_COMMENTS_FILENAME = "review-comments.json";
/**
 * Conventional per-repo review-focus filename inside `.hunk/`.
 *
 * Where an agent points its human partner. Derived like `REVIEW_STATE_FILENAME` and unlike
 * `REVIEW_COMMENTS_FILENAME`: a corrupt focus resets to none, because nothing here is
 * authored — it says what to look at, never what is true about the code.
 */
export const REVIEW_FOCUS_FILENAME = "review-focus.json";

const HUNK_REVIEW_SKILL_RELATIVE_PATH = join("skills", "hunk-review", "SKILL.md");

/**
 * Canonicalize one filesystem path, resolving through existing ancestors.
 *
 * This is the single normalizer for paths Hunk compares or persists as keys.
 * The same directory can be spelled several ways on one machine — through a
 * symlinked ancestor (`/tmp` on macOS, a symlinked home on Linux), through an
 * 8.3 short name or a differently cased drive letter on Windows — and plain
 * `resolve` preserves every one of those spellings, so two layers that both
 * "resolve" a path can still disagree about whether they mean the same
 * directory. `realpathSync.native` collapses all of them to the form the OS
 * itself reports, which is also the form Git's `--show-toplevel` prints.
 *
 * A path whose leaf does not exist yet is resolved through its nearest existing
 * ancestor instead, so a missing file still cannot hide behind an intermediate
 * symlink.
 */
export function resolveCanonicalPath(path: string) {
  const absolutePath = resolve(path);
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    // Continue below so non-existent leaves still get their ancestors resolved.
  }

  const missingSegments: string[] = [];
  let current = absolutePath;

  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      return absolutePath;
    }

    missingSegments.unshift(basename(current));
    current = parent;

    try {
      return resolve(fs.realpathSync.native(current), ...missingSegments);
    } catch {
      // Keep walking until we find an existing ancestor or hit the filesystem root.
    }
  }
}

/** Return whether a repo-root-relative path lives inside hunk's `.hunk/` metadata dir. */
export function isHunkMetadataRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized === HUNK_DIR_NAME || normalized.startsWith(`${HUNK_DIR_NAME}/`);
}

/** Resolve the base config directory Hunk should use for user-scoped files. */
export function resolveUserConfigDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.XDG_CONFIG_HOME) {
    return env.XDG_CONFIG_HOME;
  }

  const home = env.HOME || env.USERPROFILE;
  if (home) {
    return join(home, ".config");
  }

  return undefined;
}

/** Resolve the global Hunk config file path from the current environment. */
export function resolveGlobalConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const configDir = resolveUserConfigDir(env);
  return configDir ? join(configDir, "hunk", "config.toml") : undefined;
}

/** Resolve the persisted Hunk state file path from the current environment. */
export function resolveHunkStatePath(env: NodeJS.ProcessEnv = process.env) {
  const configDir = resolveUserConfigDir(env);
  return configDir ? join(configDir, "hunk", "state.json") : undefined;
}

/** Resolve the user-scoped directory Hunk scans for globally installed extensions. */
export function resolveGlobalExtensionsDir(env: NodeJS.ProcessEnv = process.env) {
  const configDir = resolveUserConfigDir(env);
  return configDir ? join(configDir, "hunk", "extensions") : undefined;
}

/** Search one path and its parents for one relative child path. */
function findRelativePathFromAncestors(startPath: string, relativePath: string) {
  let current = resolve(startPath);

  try {
    if (fs.statSync(current).isFile()) {
      current = dirname(current);
    }
  } catch {
    // Treat non-existent paths as directories so ancestor walking still works in tests.
  }

  for (;;) {
    const candidate = join(current, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/** Resolve the bundled Hunk review skill path from source, npm, or prebuilt package layouts. */
export function resolveBundledHunkReviewSkillPath(searchRoots?: string[]) {
  const roots = searchRoots ?? [import.meta.dir, process.execPath];
  const relativeCandidates = [
    HUNK_REVIEW_SKILL_RELATIVE_PATH,
    join("hunkdiff", HUNK_REVIEW_SKILL_RELATIVE_PATH),
    join("node_modules", "hunkdiff", HUNK_REVIEW_SKILL_RELATIVE_PATH),
  ];

  for (const root of roots) {
    for (const relativePath of relativeCandidates) {
      const resolvedPath = findRelativePathFromAncestors(root, relativePath);
      if (resolvedPath) {
        return resolvedPath;
      }
    }
  }

  throw new Error("Could not locate the bundled Hunk review skill.");
}
