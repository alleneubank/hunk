#!/usr/bin/env bun
/**
 * Roll the `alleneubank/hunk` fork forward as a SINGLE tagged `[fork]` commit.
 *
 * The fork carries exactly one `[fork]` commit on top of the dogfood `main`: the
 * release plumbing (this script + the `release-prebuilt-npm.yml` edits) plus a
 * stamped fork version. This command rebuilds that one commit on the latest
 * `main`, stamps a fresh `<base>-fork.<YYYYMMDD>.g<sha>` version, and tags it —
 * then STOPS at the push boundary (pushing the tag triggers the fork's release
 * CI, which is a publish and stays the human's).
 *
 * Why rebuild instead of rebase: the fork-owned files are taken verbatim from
 * the previous fork tip onto a clean checkout of `main`, so there is never a
 * version-line merge conflict when upstream moves. The tradeoff is that upstream
 * edits to those fork-owned files are NOT auto-merged — see FORK_OWNED_FILES.
 *
 * Usage:
 *   bun run scripts/release-fork.ts                    # dry run: print version + plan
 *   bun run scripts/release-fork.ts --run              # rebuild, stamp, tag (no push)
 *   bun run scripts/release-fork.ts --run --push       # ...and push (TRIGGERS release CI)
 *   bun run scripts/release-fork.ts --base <ref>       # use <ref> instead of main
 */

import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/** Files that make up the fork delta; carried verbatim from the prior fork tip. */
const FORK_OWNED_FILES = [".github/workflows/release-prebuilt-npm.yml", "scripts/release-fork.ts"];

interface Options {
  run: boolean;
  push: boolean;
  base: string;
  forkBranch: string;
  remote: string;
}

/** Parse CLI flags; everything defaults to a safe dry run against `main`. */
function parseArgs(argv: string[]): Options {
  const options: Options = {
    run: false,
    push: false,
    base: "main",
    forkBranch: "fork",
    remote: "fork",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    /** Consume the next argv entry as this flag's value, erroring if it is missing. */
    const takeValue = () => {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--run") options.run = true;
    else if (arg === "--push") options.push = true;
    else if (arg === "--base") options.base = takeValue();
    else if (arg === "--fork-branch") options.forkBranch = takeValue();
    else if (arg === "--remote") options.remote = takeValue();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.push && !options.run) {
    throw new Error("--push requires --run");
  }
  return options;
}

/** Run a git command, returning trimmed stdout; throws on non-zero exit. */
function git(args: string[], { allowFail = false } = {}): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
  const stdout = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 && !allowFail) {
    const stderr = proc.stderr.toString().trim();
    throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${stderr || stdout}`);
  }
  return stdout;
}

/** Local YYYYMMDD used in the fork version's date segment. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Read a package.json version from a git ref (e.g. `main:package.json`). */
function versionAtRef(ref: string): string {
  const raw = git(["show", `${ref}:package.json`]);
  const version = (JSON.parse(raw) as { version?: string }).version;
  if (!version) throw new Error(`No version in ${ref}:package.json`);
  // Strip any existing -fork suffix so we always base on the clean upstream version.
  return version.replace(/-fork\..*$/, "");
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  // The branch and remote intentionally share a name in this fork. Use the
  // fully qualified local ref anywhere Git would otherwise apply DWIM rules.
  const forkBranchRef = `refs/heads/${options.forkBranch}`;

  const baseSha = git(["rev-parse", "--short", options.base]);
  const baseVersion = versionAtRef(options.base);
  const newVersion = `${baseVersion}-fork.${today()}.g${baseSha}`;
  const newTag = `v${newVersion}`;

  console.log(`base ref     : ${options.base} (${baseSha})`);
  console.log(`base version : ${baseVersion}`);
  console.log(`fork version : ${newVersion}`);
  console.log(`fork tag     : ${newTag}`);

  const tagExists = Boolean(git(["tag", "--list", newTag]));

  if (!options.run) {
    if (tagExists) {
      console.log(
        `\nNOTE: tag ${newTag} already exists — nothing to roll forward until ${options.base} advances or the date changes.`,
      );
      return;
    }
    console.log(
      "\n(dry run) re-run with `bun run scripts/release-fork.ts --run` to rebuild, stamp, and tag:",
    );
    console.log(`  git checkout -B ${options.forkBranch} ${options.base}`);
    console.log(`  # carry ${FORK_OWNED_FILES.join(", ")} from the prior fork tip`);
    console.log(`  # set package.json version -> ${newVersion}; commit as [fork]; tag ${newTag}`);
    console.log(
      `  # then: git push --force-with-lease ${options.remote} ${forkBranchRef}:${forkBranchRef} && git push ${options.remote} ${newTag}`,
    );
    return;
  }

  if (tagExists) {
    throw new Error(
      `Tag ${newTag} already exists — the base sha + date are unchanged since the last release. ` +
        `Land new dogfood work on ${options.base} (or wait for a new day) before rolling forward.`,
    );
  }

  if (git(["status", "--porcelain"])) {
    throw new Error("Working tree is not clean — commit or stash before releasing the fork.");
  }

  // Capture the prior fork tip so we can carry the fork-owned files verbatim.
  const oldForkTip = git(["show-ref", "--verify", "--hash", forkBranchRef], { allowFail: true });
  if (!oldForkTip) {
    throw new Error(
      `Fork branch '${options.forkBranch}' not found — its single [fork] commit is the source of the fork-owned files.`,
    );
  }

  // Rebuild the fork branch as base + one [fork] commit, conflict-free.
  git(["checkout", "-B", options.forkBranch, options.base]);
  git(["checkout", oldForkTip, "--", ...FORK_OWNED_FILES]);

  // Stamp the fork version into package.json (targeted replace preserves formatting).
  const pkgPath = join(repoRoot, "package.json");
  const pkgText = await Bun.file(pkgPath).text();
  const stamped = pkgText.replace(/("version":\s*)"[^"]*"/, `$1"${newVersion}"`);
  if (stamped === pkgText) throw new Error("Could not find the version field in package.json");
  await Bun.write(pkgPath, stamped);

  git(["add", "--", "package.json", ...FORK_OWNED_FILES]);
  git([
    "commit",
    "-m",
    "chore(fork): ship fork dogfood prereleases via CI [fork]",
    "-m",
    `Rolled forward onto ${options.base} (${baseSha}) by \`bun run scripts/release-fork.ts\`.`,
  ]);
  git(["tag", "-a", newTag, "-m", `hunk fork dogfood prerelease ${newVersion}`]);

  console.log(
    `\n✓ Rebuilt ${options.forkBranch} as ${options.base} + one [fork] commit, tagged ${newTag}.`,
  );

  if (options.push) {
    // Pushing the tag triggers the fork's release CI — this is the publish.
    git(["push", "--force-with-lease", options.remote, `${forkBranchRef}:${forkBranchRef}`]);
    git(["push", options.remote, newTag]);
    console.log(
      `✓ Pushed ${options.forkBranch} + ${newTag} to ${options.remote} (release CI running).`,
    );
  } else {
    console.log("\nPublish (yours) — push to cut the prerelease:");
    console.log(
      `  git push --force-with-lease ${options.remote} ${forkBranchRef}:${forkBranchRef}`,
    );
    console.log(`  git push ${options.remote} ${newTag}`);
    console.log(`Then bump the dotfiles mise pin to ${newVersion} + \`mise lock --global -p …\`.`);
  }
}

await main();
