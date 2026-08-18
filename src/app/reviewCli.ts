import type { ParsedCliInput, ReviewOperation } from "../core/run/commandInputs";

/**
 * Review-command flags, peeled off before target selection is delegated to the canonical
 * `hunk diff`, `hunk show`, or `hunk stash show` parser.
 *
 * Value flags collect every occurrence rather than keeping the last one. Overwriting made
 * `--file a --file b` mark only `b` and say nothing about `a`.
 */
type ReviewFlags = Record<string, string[] | true>;

/** Boolean flags `hunk review` understands; everything else with a value is a value flag. */
const REVIEW_BOOLEAN_FLAGS = new Set([
  "--json",
  "--include-patch",
  "--viewed",
  "--unviewed",
  "--stdin",
]);

/** Review subcommands whose first token is a group name rather than the action. */
const REVIEW_COMMAND_GROUPS = new Set(["comment", "note", "viewed", "file", "focus"]);

/** Value-taking flags for every `hunk review` subcommand, keyed by subcommand path. */
const REVIEW_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  export: new Set(["--repo", "--source"]),
  "comment add": new Set([
    "--repo",
    "--source",
    "--file",
    "--side",
    "--line",
    "--body",
    "--author",
  ]),
  "comment reply": new Set(["--repo", "--source", "--file", "--id", "--body", "--author"]),
  "comment status": new Set(["--repo", "--source", "--file", "--id", "--status"]),
  "comment delete": new Set(["--repo", "--source", "--file", "--id"]),
  "note reply": new Set(["--repo", "--source", "--file", "--note", "--body", "--author"]),
  "note status": new Set(["--repo", "--source", "--file", "--note", "--status"]),
  "viewed set": new Set(["--repo", "--source", "--file"]),
  "file source": new Set(["--repo", "--source", "--file", "--side"]),
  "focus set": new Set(["--repo", "--source", "--file", "--side", "--line"]),
  "focus get": new Set(["--repo", "--source"]),
  "focus clear": new Set(["--repo", "--source"]),
};

export interface ReviewCommandParsers {
  parseDiffCommand: (tokens: string[], argv: string[]) => Promise<ParsedCliInput>;
  parseShowCommand: (tokens: string[], argv: string[]) => Promise<ParsedCliInput>;
  parseStashCommand: (tokens: string[], argv: string[]) => Promise<ParsedCliInput>;
  helpText: () => string;
}

/** Split review-command flags out of a token list, leaving diff-shaped tokens behind. */
function splitReviewFlags(tokens: string[], valueFlags: ReadonlySet<string>) {
  const flags: ReviewFlags = {};
  const diffTokens: string[] = [];

  const collect = (name: string, value: string) => {
    const existing = flags[name];
    flags[name] = existing === true || existing === undefined ? [value] : [...existing, value];
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (REVIEW_BOOLEAN_FLAGS.has(token)) {
      flags[token] = true;
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const inlineName = equalsIndex > 0 ? token.slice(0, equalsIndex) : undefined;
    if (inlineName && valueFlags.has(inlineName)) {
      const value = token.slice(equalsIndex + 1);
      if (!value) {
        throw new Error(`\`${inlineName}\` requires a value.`);
      }
      collect(inlineName, value);
      continue;
    }

    if (valueFlags.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined) {
        throw new Error(`\`${token}\` requires a value.`);
      }
      collect(token, value);
      index += 1;
      continue;
    }

    diffTokens.push(token);
  }

  return { flags, diffTokens };
}

/** Read every occurrence of one value flag, in the order they were given. */
function reviewFlagValues(flags: ReviewFlags, name: string): string[] {
  const value = flags[name];
  return value === true || value === undefined ? [] : value;
}

/** Read one optional string flag, refusing a repeat the reader could only ignore. */
function optionalReviewFlag(flags: ReviewFlags, name: string): string | undefined {
  const values = reviewFlagValues(flags, name);
  if (values.length > 1) {
    throw new Error(`\`${name}\` accepts one value, but was given ${values.length}.`);
  }

  return values[0];
}

/** Read one required string flag, failing with the flag's own name. */
function requireReviewFlag(flags: ReviewFlags, name: string): string {
  const value = optionalReviewFlag(flags, name);
  if (value === undefined) {
    throw new Error(`\`${name}\` is required.`);
  }

  return value;
}

/** Read one or more values for a flag whose subcommand acts on a set. */
function requireReviewFlagList(flags: ReviewFlags, name: string): string[] {
  const values = reviewFlagValues(flags, name);
  if (values.length === 0) {
    throw new Error(`\`${name}\` is required.`);
  }

  return values;
}

/** Read one required positive integer flag. */
function requireReviewLine(flags: ReviewFlags): number {
  const raw = requireReviewFlag(flags, "--line");
  const line = Number(raw);
  if (!Number.isInteger(line) || line <= 0) {
    throw new Error("`--line` requires a positive integer.");
  }

  return line;
}

/** Read the diff side a comment anchors to. */
function requireReviewSide(flags: ReviewFlags) {
  const side = requireReviewFlag(flags, "--side");
  if (side !== "old" && side !== "new") {
    throw new Error("`--side` must be `old` or `new`.");
  }

  return side;
}

/** Build the review operation one subcommand's flags describe. */
function buildReviewOperation(subcommand: string, flags: ReviewFlags): ReviewOperation {
  if (subcommand === "export") {
    return { name: "export", includePatch: flags["--include-patch"] === true };
  }

  if (subcommand === "comment add") {
    const body = optionalReviewFlag(flags, "--body");
    if (body === undefined && flags["--stdin"] !== true) {
      throw new Error("`hunk review comment add` requires --body <text> or --stdin.");
    }

    const author = optionalReviewFlag(flags, "--author");

    return {
      name: "comment-add",
      file: requireReviewFlag(flags, "--file"),
      side: requireReviewSide(flags),
      line: requireReviewLine(flags),
      body: body ?? "",
      ...(author !== undefined ? { author } : {}),
    };
  }

  if (subcommand === "comment reply") {
    const body = optionalReviewFlag(flags, "--body");
    if (body === undefined && flags["--stdin"] !== true) {
      throw new Error("`hunk review comment reply` requires --body <text> or --stdin.");
    }

    const author = optionalReviewFlag(flags, "--author");

    return {
      name: "comment-reply",
      file: requireReviewFlag(flags, "--file"),
      id: requireReviewFlag(flags, "--id"),
      body: body ?? "",
      ...(author !== undefined ? { author } : {}),
    };
  }

  if (subcommand === "note reply") {
    const body = optionalReviewFlag(flags, "--body");
    if (body === undefined && flags["--stdin"] !== true) {
      throw new Error("`hunk review note reply` requires --body <text> or --stdin.");
    }

    const author = optionalReviewFlag(flags, "--author");

    return {
      name: "note-reply",
      file: requireReviewFlag(flags, "--file"),
      note: requireReviewFlag(flags, "--note"),
      body: body ?? "",
      ...(author !== undefined ? { author } : {}),
    };
  }

  if (subcommand === "note status") {
    const status = requireReviewFlag(flags, "--status");
    if (status !== "active" && status !== "resolved") {
      throw new Error("`--status` must be `active` or `resolved`.");
    }

    return {
      name: "note-status",
      file: requireReviewFlag(flags, "--file"),
      note: requireReviewFlag(flags, "--note"),
      status,
    };
  }

  if (subcommand === "comment status") {
    const status = requireReviewFlag(flags, "--status");
    if (status !== "active" && status !== "resolved") {
      throw new Error("`--status` must be `active` or `resolved`.");
    }

    return {
      name: "comment-status",
      file: requireReviewFlag(flags, "--file"),
      id: requireReviewFlag(flags, "--id"),
      status,
    };
  }

  if (subcommand === "comment delete") {
    return {
      name: "comment-delete",
      file: requireReviewFlag(flags, "--file"),
      id: requireReviewFlag(flags, "--id"),
    };
  }

  if (subcommand === "focus get") {
    return { name: "focus-get" };
  }

  if (subcommand === "focus clear") {
    return { name: "focus-clear" };
  }

  if (subcommand === "focus set") {
    const file = optionalReviewFlag(flags, "--file");
    const line = optionalReviewFlag(flags, "--line");
    const side = optionalReviewFlag(flags, "--side");

    if (line !== undefined && file === undefined) {
      throw new Error("`hunk review focus set --line` also requires --file <path>.");
    }

    if (side !== undefined && side !== "old" && side !== "new") {
      throw new Error("`--side` must be `old` or `new`.");
    }

    const lineNumber = line === undefined ? undefined : Number(line);
    if (lineNumber !== undefined && (!Number.isInteger(lineNumber) || lineNumber < 1)) {
      throw new Error("`--line` must be a positive 1-based line number.");
    }

    return {
      name: "focus-set",
      ...(file !== undefined ? { file } : {}),
      ...(side !== undefined ? { side } : {}),
      ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    };
  }

  if (subcommand === "file source") {
    return {
      name: "file-source",
      file: requireReviewFlag(flags, "--file"),
      side: requireReviewSide(flags),
    };
  }

  const viewed = flags["--viewed"] === true;
  const unviewed = flags["--unviewed"] === true;
  if (viewed === unviewed) {
    throw new Error("`hunk review viewed set` requires exactly one of --viewed or --unviewed.");
  }

  return { name: "viewed-set", files: requireReviewFlagList(flags, "--file"), viewed };
}

/**
 * Parse the `hunk review` command group, the headless surface editor clients drive.
 */
export async function parseReviewCommand(
  tokens: string[],
  argv: string[],
  parsers: ReviewCommandParsers,
): Promise<ParsedCliInput> {
  const { commandTokens, pathspecs } = splitPathspecArgs(tokens);
  if (commandTokens.length === 0 || commandTokens[0] === "--help" || commandTokens[0] === "-h") {
    return { kind: "help", text: parsers.helpText() };
  }

  const [group, maybeAction] = commandTokens;
  const subcommand =
    group && REVIEW_COMMAND_GROUPS.has(group) ? `${group} ${maybeAction ?? ""}`.trim() : group!;
  const valueFlags = REVIEW_VALUE_FLAGS[subcommand];

  if (!valueFlags) {
    throw new Error(`Unknown review subcommand: ${commandTokens.slice(0, 2).join(" ")}`);
  }

  const rest = commandTokens.slice(subcommand.includes(" ") ? 2 : 1);
  if (rest.includes("--help") || rest.includes("-h")) {
    return { kind: "help", text: parsers.helpText() };
  }

  const { flags, diffTokens } = splitReviewFlags(rest, valueFlags);

  if (flags["--json"] !== true) {
    throw new Error(
      `\`hunk review ${subcommand}\` currently emits JSON only. Pass --json to confirm the format.`,
    );
  }

  const operation = buildReviewOperation(subcommand, flags);
  const repo = optionalReviewFlag(flags, "--repo");

  const source = optionalReviewFlag(flags, "--source") ?? "diff";
  if (source !== "diff" && source !== "show" && source !== "stash-show") {
    throw new Error("`--source` must be `diff`, `show`, or `stash-show`.");
  }

  const targetTokens = pathspecs.length > 0 ? [...diffTokens, "--", ...pathspecs] : diffTokens;
  const parsed =
    source === "diff"
      ? await parsers.parseDiffCommand(targetTokens, argv)
      : source === "show"
        ? await parsers.parseShowCommand(targetTokens, argv)
        : pathspecs.length > 0
          ? (() => {
              throw new Error("`hunk review --source stash-show` does not accept pathspecs.");
            })()
          : await parsers.parseStashCommand(["show", ...diffTokens], argv);

  if (parsed.kind !== "vcs" && parsed.kind !== "show" && parsed.kind !== "stash-show") {
    throw new Error(
      "`hunk review` operates on a repository target. Use `hunk review <subcommand> [target] [-- <pathspec...>]`.",
    );
  }

  return {
    kind: "review",
    input: parsed,
    operation,
    ...(repo !== undefined ? { repo } : {}),
  };
}

/** Split `--` pathspecs the same way the rest of the CLI does. */
function splitPathspecArgs(tokens: string[]) {
  const separator = tokens.indexOf("--");
  if (separator === -1) {
    return { commandTokens: tokens, pathspecs: [] as string[] };
  }

  return {
    commandTokens: tokens.slice(0, separator),
    pathspecs: tokens.slice(separator + 1),
  };
}
