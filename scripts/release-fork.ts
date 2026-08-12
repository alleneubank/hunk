#!/usr/bin/env bun
/**
 * Cut a personal-fork dogfood prerelease for alleneubank/hunk.
 *
 * Follows the local-build + GitHub-prerelease model (not Actions):
 * https://gist.github.com/alleneubank/bf7d25542a49b136671db0e4bb65226d
 *
 * Shape:
 *   main stays PR-clean (what you intend to upstream).
 *   fork = main + one `[fork]` commit (this script + AGENTS fork SOP).
 *   Local build → per-platform `hunkdiff-<os>-<arch>.tar.gz` + `checksums.txt`
 *     (REQUIRED: host + linux-x64 — host-only is a defective cut)
 *     → annotated tag `v<base>-fork.<YYYYMMDD>.g<sha9>`
 *     → `gh release create --prerelease` with those assets.
 *
 * mise `github:alleneubank/hunk` and Nix overlays pin the exact prerelease tag;
 * prereleases never hijack `/releases/latest`. Linux is required so the fleet
 * (ae-dev, pixelproton, …) can install; see the gist.
 *
 * Usage:
 *   bun run scripts/release-fork.ts                 # dry run (default)
 *   bun run scripts/release-fork.ts --run           # rebuild fork, stamp, tag, package fleet tarballs
 *   bun run scripts/release-fork.ts --run --publish # ...and push + gh release create (BOUNDARY)
 *   bun run scripts/release-fork.ts --republish     # rebuild fleet tarballs; upload onto existing tag
 *   bun run scripts/release-fork.ts --base <ref>    # base ref (default: main)
 *   bun run scripts/release-fork.ts --remote <name> # remote (default: origin)
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  binaryFilenameForSpec,
  getHostPlatformPackageSpec,
  getPlatformPackageSpecByName,
  type PlatformPackageSpec,
} from "./prebuilt-package-helpers";

/** Bun image for containerized Linux builds (must match engines / CI bun). */
const BUN_DOCKER_IMAGE = "oven/bun:1.3.14";

/** Fleet platform that must always be present on a dogfood release. */
const REQUIRED_LINUX_PACKAGE = "hunkdiff-linux-x64";

const repoRoot = join(import.meta.dir, "..");

/**
 * Files that make up the fork delta; carried verbatim from the prior fork tip.
 *
 * Release *shipping* is local (this script + gh). Do not carry CI workflows here —
 * distribution plumbing that only exists to dogfood must not leak into main.
 */
const FORK_OWNED_FILES = [
  "scripts/release-fork.ts",
  // Fork dogfood release SOP lives under ## fork dogfood releases.
  "AGENTS.md",
];

interface Options {
  run: boolean;
  publish: boolean;
  republish: boolean;
  base: string;
  forkBranch: string;
  remote: string;
}

/** Parse CLI flags; everything defaults to a safe dry run against `main`. */
function parseArgs(argv: string[]): Options {
  const options: Options = {
    run: false,
    publish: false,
    republish: false,
    base: "main",
    forkBranch: "fork",
    // `origin` is the personal fork remote; `upstream` is modem-dev.
    remote: "origin",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--run") options.run = true;
    else if (arg === "--publish") options.publish = true;
    else if (arg === "--republish") options.republish = true;
    else if (arg === "--base") options.base = takeValue();
    else if (arg === "--fork-branch") options.forkBranch = takeValue();
    else if (arg === "--remote") options.remote = takeValue();
    // Legacy no-ops: CI is no longer the ship path. Accept and ignore so old muscle memory
    // does not hard-fail mid-cut.
    else if (arg === "--allow-red-ci" || arg === "--push") {
      console.warn(`note: ${arg} is ignored — fork releases are local build + gh (not CI).`);
      if (arg === "--push") options.publish = true;
    } else if (arg === "--ci-workflow") {
      console.warn("note: --ci-workflow is ignored — fork releases are local build + gh (not CI).");
      i += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.republish && options.run) {
    throw new Error("--republish and --run are mutually exclusive");
  }
  // --publish alone is allowed when a cut already exists (push + gh release).
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

/** Run a command in the repo; throws on non-zero exit. */
function run(cmd: string[], { env }: { env?: Record<string, string> } = {}): void {
  const proc = Bun.spawnSync(cmd, {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${proc.exitCode})`);
  }
}

/** UTC YYYYMMDD for the version's date segment (gist). */
function todayUtc(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** GitHub `owner/repo` for a remote. */
function repoSlugForRemote(remote: string): string {
  const url = git(["remote", "get-url", remote]);
  const match = url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
  if (!match?.[1]) {
    throw new Error(`Cannot derive a GitHub owner/repo from the '${remote}' remote url: ${url}`);
  }
  return match[1];
}

/** Read package.json version from a git ref, stripping any existing -fork suffix. */
function versionAtRef(ref: string): string {
  const raw = git(["show", `${ref}:package.json`]);
  const version = (JSON.parse(raw) as { version?: string }).version;
  if (!version) throw new Error(`No version in ${ref}:package.json`);
  return version.replace(/-fork\..*$/, "");
}

/**
 * Refuse a host-only cut: fleet Linux hosts must get a tarball on every release.
 * https://gist.github.com/alleneubank/bf7d25542a49b136671db0e4bb65226d
 */
function requireLinuxArchive(distDir: string): void {
  const names = readdirSync(distDir).filter((n) => n.endsWith(".tar.gz"));
  const hasLinux = names.some((n) => n.includes("linux"));
  if (!hasLinux) {
    throw new Error(
      `missing required linux archive under ${distDir} — host-only is a defective fleet cut. ` +
        `Got: ${names.join(", ") || "(none)"}`,
    );
  }
  if (!names.includes(`${REQUIRED_LINUX_PACKAGE}.tar.gz`)) {
    throw new Error(
      `missing required ${REQUIRED_LINUX_PACKAGE}.tar.gz (fleet amd64). Got: ${names.join(", ")}`,
    );
  }
}

/**
 * Assert `file(1)` identity matches the package label so a Mac binary never ships
 * under a linux-named tarball (tilt fork lesson).
 */
function assertBinaryPlatform(binaryPath: string, spec: PlatformPackageSpec): void {
  const proc = Bun.spawnSync(["file", "-b", binaryPath], { cwd: repoRoot });
  if (proc.exitCode !== 0) {
    throw new Error(`file(1) failed on ${binaryPath}: ${proc.stderr.toString()}`);
  }
  const out = proc.stdout.toString();
  if (spec.os === "linux" && spec.cpu === "x64") {
    if (!out.includes("ELF") || !out.includes("x86-64")) {
      throw new Error(
        `platform mismatch for ${spec.packageName}: expected ELF x86-64, file(1) said: ${out.trim()}`,
      );
    }
    return;
  }
  if (spec.os === "linux" && spec.cpu === "arm64") {
    if (!out.includes("ELF") || (!out.includes("ARM aarch64") && !out.includes("aarch64"))) {
      throw new Error(
        `platform mismatch for ${spec.packageName}: expected ELF aarch64, file(1) said: ${out.trim()}`,
      );
    }
    return;
  }
  if (spec.os === "darwin" && spec.cpu === "arm64") {
    if (!out.includes("Mach-O") || !out.includes("arm64")) {
      throw new Error(
        `platform mismatch for ${spec.packageName}: expected Mach-O arm64, file(1) said: ${out.trim()}`,
      );
    }
    return;
  }
  if (spec.os === "darwin" && spec.cpu === "x64") {
    if (!out.includes("Mach-O") || (!out.includes("x86_64") && !out.includes("x86-64"))) {
      throw new Error(
        `platform mismatch for ${spec.packageName}: expected Mach-O x86_64, file(1) said: ${out.trim()}`,
      );
    }
  }
}

/** Compile the host binary into dist/ and return its path. */
function compileHostBinary(): string {
  run(["bun", "run", "./scripts/build-bin.ts"], {
    env: {
      BUN_TMPDIR: join(repoRoot, ".bun-tmp"),
      BUN_INSTALL: join(repoRoot, ".bun-install"),
    },
  });
  const host = getHostPlatformPackageSpec();
  const binaryName = binaryFilenameForSpec(host);
  const compiled =
    [join(repoRoot, "dist", binaryName), join(repoRoot, "dist", "hunk")].find((p) =>
      existsSync(p),
    ) ?? null;
  if (!compiled) {
    throw new Error(`Missing host binary after build:bin (looked for ${binaryName} / hunk).`);
  }
  assertBinaryPlatform(compiled, host);
  return compiled;
}

/**
 * Compile linux-x64 inside Docker so OpenTUI native optionalDeps resolve on Linux.
 * Cross-`bun build --target=bun-linux-x64` from Darwin fails when only darwin natives are installed.
 */
function compileLinuxX64Binary(outPath: string): void {
  mkdirSync(join(outPath, ".."), { recursive: true });
  // Relative path for the bind-mounted /src workspace.
  const relOut = outPath.startsWith(repoRoot)
    ? outPath.slice(repoRoot.length).replace(/^\//, "")
    : outPath;

  const dockerCheck = Bun.spawnSync(["docker", "info"], {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (dockerCheck.exitCode !== 0) {
    throw new Error(
      "docker is required to build the linux-x64 fleet tarball (OrbStack/Docker Desktop). " +
        "`docker info` failed — start Docker and retry.",
    );
  }

  console.log(`compiling ${REQUIRED_LINUX_PACKAGE} via ${BUN_DOCKER_IMAGE} (linux/amd64)…`);
  run([
    "docker",
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "-v",
    `${repoRoot}:/src`,
    "-w",
    "/src",
    "-e",
    "SKIP_INSTALL_SIMPLE_GIT_HOOKS=1",
    "-e",
    "BUN_INSTALL=/tmp/bun-install",
    "-e",
    "BUN_TMPDIR=/tmp/bun-tmp",
    BUN_DOCKER_IMAGE,
    "bash",
    "-lc",
    [
      "set -euo pipefail",
      "bun install --frozen-lockfile",
      `mkdir -p "$(dirname '${relOut}')"`,
      `bun build --compile --no-compile-autoload-bunfig src/main.tsx --outfile '${relOut}'`,
    ].join(" && "),
  ]);

  if (!existsSync(outPath)) {
    throw new Error(`Docker linux-x64 compile did not produce ${outPath}`);
  }
  const linuxSpec = getPlatformPackageSpecByName(REQUIRED_LINUX_PACKAGE);
  if (!linuxSpec) {
    throw new Error(`Unknown package spec ${REQUIRED_LINUX_PACKAGE}`);
  }
  assertBinaryPlatform(outPath, linuxSpec);
}

/**
 * Stage one platform archive: binary + skills/ + metadata.json at tarball root.
 */
function stagePlatformArchive(
  distDir: string,
  version: string,
  spec: PlatformPackageSpec,
  binaryPath: string,
): string {
  const binaryName = binaryFilenameForSpec(spec);
  const stageDir = join(distDir, `stage-${spec.packageName}`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const stagedBinary = join(stageDir, binaryName);
  cpSync(binaryPath, stagedBinary);
  if (spec.os !== "windows") {
    chmodSync(stagedBinary, 0o755);
  }

  const skillsSource = join(repoRoot, "skills");
  if (!existsSync(skillsSource)) {
    throw new Error(`Missing skills directory at ${skillsSource}.`);
  }
  cpSync(skillsSource, join(stageDir, "skills"), { recursive: true });
  writeFileSync(
    join(stageDir, "metadata.json"),
    `${JSON.stringify(
      {
        packageName: spec.packageName,
        os: spec.os,
        cpu: spec.cpu,
        binaryName,
        version,
      },
      null,
      2,
    )}\n`,
  );

  const archiveName = `${spec.packageName}.tar.gz`;
  const archivePath = join(distDir, archiveName);
  run(["tar", "-czf", archivePath, "-C", stageDir, binaryName, "skills", "metadata.json"]);
  console.log(`packaged ${archiveName} for ${spec.os}/${spec.cpu} (version stamp ${version})`);
  return archivePath;
}

/**
 * Build fleet release tarballs: host platform + required linux-x64.
 *
 * Layout matches prior dogfood releases and mise github: consumption:
 *   hunkdiff-<os>-<arch>.tar.gz  →  root: hunk, skills/, metadata.json
 *   checksums.txt                →  sha256sum format (portable: shasum -a 256)
 */
function packageFleetRelease(version: string): { distDir: string; checksums: string } {
  const distDir = join(repoRoot, "dist", "fork-release");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const host = getHostPlatformPackageSpec();
  const hostBinary = compileHostBinary();
  stagePlatformArchive(distDir, version, host, hostBinary);

  // Always ship linux-x64 for the fleet — even when cutting from a Mac.
  if (host.packageName !== REQUIRED_LINUX_PACKAGE) {
    const linuxSpec = getPlatformPackageSpecByName(REQUIRED_LINUX_PACKAGE);
    if (!linuxSpec) {
      throw new Error(`Unknown package spec ${REQUIRED_LINUX_PACKAGE}`);
    }
    const linuxBinary = join(distDir, "bin", "hunk-linux-x64");
    compileLinuxX64Binary(linuxBinary);
    stagePlatformArchive(distDir, version, linuxSpec, linuxBinary);
  }

  requireLinuxArchive(distDir);

  const archives = readdirSync(distDir).filter((n) => n.endsWith(".tar.gz"));
  const checksumsPath = join(distDir, "checksums.txt");
  const hashProc = Bun.spawnSync(["shasum", "-a", "256", ...archives], { cwd: distDir });
  if (hashProc.exitCode !== 0) {
    throw new Error(`shasum failed: ${hashProc.stderr.toString()}`);
  }
  writeFileSync(checksumsPath, hashProc.stdout.toString());

  return { distDir, checksums: checksumsPath };
}

/** List every release asset path in the fork-release dist dir (archives + checksums). */
function releaseAssetPaths(distDir: string): string[] {
  return readdirSync(distDir)
    .filter((name) => name.endsWith(".tar.gz") || name === "checksums.txt")
    .map((name) => join(distDir, name));
}

/** Create or replace a prerelease on GitHub with the packaged assets. */
function publishRelease(repoSlug: string, tag: string, version: string, assets: string[]): void {
  // Prefer create; if the release already exists (re-cut assets), upload with clobber.
  const view = Bun.spawnSync(["gh", "release", "view", tag, "--repo", repoSlug], {
    cwd: repoRoot,
  });
  if (view.exitCode !== 0) {
    run([
      "gh",
      "release",
      "create",
      tag,
      "--repo",
      repoSlug,
      "--prerelease",
      "--title",
      version,
      "--notes",
      [
        `## Fork dogfood prerelease \`${version}\``,
        "",
        "Local build + `gh release` (not Actions). Host + linux-x64 tarballs for mise `github:` / Nix overlays.",
        "",
        `**Full Changelog**: https://github.com/${repoSlug}/compare/${tag}`,
      ].join("\n"),
      ...assets,
    ]);
    return;
  }

  run(["gh", "release", "upload", tag, "--repo", repoSlug, "--clobber", ...assets]);
  console.log(`✓ Uploaded assets onto existing release ${tag}`);
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  const forkBranchRef = `refs/heads/${options.forkBranch}`;
  const repoSlug = repoSlugForRemote(options.remote);

  // g + 9-char sha: non-numeric segment so SemVer never sees a leading-zero numeric id (gist).
  const baseSha9 = git(["rev-parse", "--short=9", options.base]);
  const baseVersion = versionAtRef(options.base);
  const newVersion = `${baseVersion}-fork.${todayUtc()}.g${baseSha9}`;
  const newTag = `v${newVersion}`;
  const tagExists = Boolean(git(["tag", "--list", newTag]));

  console.log(`base ref     : ${options.base} (${baseSha9})`);
  console.log(`base version : ${baseVersion}`);
  console.log(`fork version : ${newVersion}`);
  console.log(`fork tag     : ${newTag}`);
  console.log(`remote/repo  : ${options.remote} (${repoSlug})`);
  const hostPkg = getHostPlatformPackageSpec().packageName;
  console.log(
    `platforms    : ${hostPkg}` +
      (hostPkg === REQUIRED_LINUX_PACKAGE ? "" : ` + ${REQUIRED_LINUX_PACKAGE} (docker)`),
  );

  if (!options.run && !options.republish && !options.publish) {
    if (tagExists) {
      console.log(
        `\nNOTE: tag ${newTag} already exists. Use --republish to rebuild/upload fleet assets, or advance ${options.base}.`,
      );
    }
    console.log("\n(dry run) ship path is local build + gh prerelease — not Actions.");
    console.log(`  bun run scripts/release-fork.ts --run`);
    console.log(
      `    → rebuild ${options.forkBranch} = ${options.base} + [fork], tag ${newTag}, package host + linux-x64`,
    );
    console.log(`  bun run scripts/release-fork.ts --run --publish`);
    console.log(
      `    → push ${options.forkBranch} + ${newTag}, gh release create --prerelease with assets`,
    );
    console.log(`  bun run scripts/release-fork.ts --publish`);
    console.log(`    → push + gh release for an already-cut local tag (after --run)`);
    console.log(`  bun run scripts/release-fork.ts --republish --publish`);
    console.log(`    → rebuild fleet tarballs and upload onto existing ${newTag}`);
    return;
  }

  if (git(["status", "--porcelain"])) {
    throw new Error("Working tree is not clean — commit or stash before releasing the fork.");
  }

  // --publish alone: push the already-cut fork tip + tag and create/update the prerelease.
  if (options.publish && !options.run && !options.republish) {
    const headTag = git(["describe", "--tags", "--exact-match", "HEAD"], { allowFail: true });
    if (!headTag?.startsWith("v") || !headTag.includes("-fork.")) {
      throw new Error(
        `HEAD is not a fork dogfood tag (got ${headTag || "untagged"}). Run --run first, or checkout the cut.`,
      );
    }
    const version = headTag.replace(/^v/, "");
    const distDir = join(repoRoot, "dist", "fork-release");
    let assets = existsSync(distDir) ? releaseAssetPaths(distDir) : [];
    if (assets.length === 0 || !assets.some((a) => a.includes("linux"))) {
      const packed = packageFleetRelease(version);
      assets = releaseAssetPaths(packed.distDir);
    }
    git(["push", "--force-with-lease", options.remote, `${forkBranchRef}:${forkBranchRef}`]);
    git(["push", options.remote, headTag]);
    publishRelease(repoSlug, headTag, version, assets);
    console.log(
      `✓ Pushed + published ${headTag} → https://github.com/${repoSlug}/releases/tag/${headTag}`,
    );
    console.log(`Then bump the dotfiles mise pin to ${version} + mise lock.`);
    return;
  }

  // --- republish: package + optional upload only ---
  if (options.republish) {
    // Prefer today's computed tag; otherwise the newest local v*-fork.* tag (handles older
    // cuts that used a different short-sha width before the gist short=9 rule).
    const latestForkTag = git(["tag", "--list", "v*-fork.*", "--sort=-creatordate"], {
      allowFail: true,
    })
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    const republishTag = tagExists ? newTag : latestForkTag;
    if (!republishTag) {
      throw new Error(`No fork tag to republish — use --run to cut a new release first.`);
    }
    const versionForAssets = republishTag.replace(/^v/, "");
    console.log(`republish tag : ${republishTag}`);
    const { distDir } = packageFleetRelease(versionForAssets);
    const assets = releaseAssetPaths(distDir);
    console.log(`\n✓ Packaged fleet release under ${distDir}`);
    if (options.publish) {
      publishRelease(repoSlug, republishTag, versionForAssets, assets);
      console.log(
        `✓ Published assets for ${republishTag} → https://github.com/${repoSlug}/releases/tag/${republishTag}`,
      );
      console.log(`Then bump the dotfiles mise pin to ${versionForAssets} + mise lock.`);
    } else {
      console.log("\nPublish (yours):");
      console.log(`  bun run scripts/release-fork.ts --republish --publish`);
    }
    return;
  }

  // --- --run: rebuild fork branch, stamp, tag, package ---
  if (tagExists) {
    throw new Error(
      `Tag ${newTag} already exists — the base sha + date are unchanged since the last release. ` +
        `Land new dogfood work on ${options.base} (or wait for a new UTC day), or use --republish.`,
    );
  }

  const oldForkTip = git(["show-ref", "--verify", "--hash", forkBranchRef], { allowFail: true });
  if (!oldForkTip) {
    throw new Error(
      `Fork branch '${options.forkBranch}' not found — its [fork] commit is the source of fork-owned files.`,
    );
  }

  git(["checkout", "-B", options.forkBranch, options.base]);
  git(["checkout", oldForkTip, "--", ...FORK_OWNED_FILES]);

  const pkgPath = join(repoRoot, "package.json");
  const pkgText = await Bun.file(pkgPath).text();
  const stamped = pkgText.replace(/("version":\s*)"[^"]*"/, `$1"${newVersion}"`);
  if (stamped === pkgText) throw new Error("Could not find the version field in package.json");
  await Bun.write(pkgPath, stamped);

  git(["add", "--", "package.json", ...FORK_OWNED_FILES]);
  git([
    "commit",
    "-m",
    "chore(fork): cut dogfood prerelease [fork]",
    "-m",
    `Rolled forward onto ${options.base} (${baseSha9}) by \`bun run scripts/release-fork.ts\`. Local package + gh prerelease — not Actions.`,
  ]);
  git(["tag", "-a", newTag, "-m", `hunk fork dogfood prerelease ${newVersion}`]);

  const { distDir } = packageFleetRelease(newVersion);
  const assets = releaseAssetPaths(distDir);

  console.log(
    `\n✓ Rebuilt ${options.forkBranch} as ${options.base} + one [fork] commit, tagged ${newTag}.`,
  );
  console.log(`✓ Packaged ${assets.map((p) => p.split("/").pop()).join(", ")} under ${distDir}`);

  if (options.publish) {
    git(["push", "--force-with-lease", options.remote, `${forkBranchRef}:${forkBranchRef}`]);
    git(["push", options.remote, newTag]);
    publishRelease(repoSlug, newTag, newVersion, assets);
    console.log(
      `✓ Pushed + published ${newTag} → https://github.com/${repoSlug}/releases/tag/${newTag}`,
    );
    console.log(`Then bump the dotfiles mise pin to ${newVersion} + mise lock.`);
  } else {
    console.log("\nPublish boundary (deliberate) — re-run with --publish:");
    console.log(`  bun run scripts/release-fork.ts --run --publish`);
    console.log("Or step by step:");
    console.log(
      `  git push --force-with-lease ${options.remote} ${forkBranchRef}:${forkBranchRef}`,
    );
    console.log(`  git push ${options.remote} ${newTag}`);
    console.log(
      `  gh release create ${newTag} --repo ${repoSlug} --prerelease --title ${newVersion} ${assets.join(" ")}`,
    );
  }
}

await main();
