/**
 * Which repo-backed changeset a review covers.
 *
 * The operation is part of the identity. A bare revision in `hunk show` is not the same
 * request as a revision passed to `hunk diff`, and pathspecs belong to that same request.
 * Hunk owns resolving both; the extension only preserves the user's selection.
 */
export type ReviewTarget =
  | { kind: "working-tree"; pathspecs?: string[] }
  | { kind: "staged"; pathspecs?: string[] }
  | { kind: "range"; expression: string; pathspecs?: string[] }
  | { kind: "show"; ref?: string; pathspecs?: string[] }
  | { kind: "stash-show"; ref?: string; pathspecs?: never };

export const WORKING_TREE_TARGET: ReviewTarget = { kind: "working-tree" };

/** The target arguments before the pathspec separator, appended to every review invocation. */
export function targetArguments(target: ReviewTarget): string[] {
  switch (target.kind) {
    case "staged":
      return ["--staged"];
    case "range":
      return [target.expression];
    case "show":
      return ["--source", "show", ...(target.ref ? [target.ref] : [])];
    case "stash-show":
      // `parseReviewCommand` supplies the `show` action when it maps this source to
      // `parseStashCommand`; passing it here would turn the target into `stash show show`.
      return ["--source", "stash-show", ...(target.ref ? [target.ref] : [])];
    default:
      return [];
  }
}

/** Pathspec arguments are kept separate so `--json` and `--repo` stay before `--`. */
export function targetPathspecArguments(target: ReviewTarget): string[] {
  return target.pathspecs && target.pathspecs.length > 0 ? ["--", ...target.pathspecs] : [];
}

/** Short label for the view header, so the reviewer always knows what they are reading. */
export function targetLabel(target: ReviewTarget): string {
  const base = (() => {
    switch (target.kind) {
      case "staged":
        return "staged changes";
      case "range":
        return target.expression;
      case "show":
        return target.ref ? `show ${target.ref}` : "show HEAD";
      case "stash-show":
        return target.ref ? `stash show ${target.ref}` : "stash show (latest)";
      default:
        return "working tree";
    }
  })();

  return target.pathspecs && target.pathspecs.length > 0
    ? `${base} · ${target.pathspecs.join(", ")}`
    : base;
}

/** Whether one expression can be passed to Hunk as a revision or range. */
export function isReviewableExpression(expression: string): boolean {
  const trimmed = expression.trim();

  return trimmed.length > 0 && !trimmed.startsWith("-");
}

/** Whether one pathspec can be passed after the CLI's `--` separator. */
export function isReviewablePathspec(pathspec: string): boolean {
  const trimmed = pathspec.trim();

  return trimmed.length > 0 && trimmed !== "--";
}

/** Parse quoted, space-separated pathspecs without invoking a shell. */
export function parsePathspecInput(value: string): string[] | undefined {
  const pathspecs: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current.length > 0) {
        pathspecs.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }

  if (escaped || quote) {
    return undefined;
  }

  if (current.length > 0) {
    pathspecs.push(current);
  }

  return pathspecs.length > 0 && pathspecs.every(isReviewablePathspec) ? pathspecs : undefined;
}

function pathspecsOf(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((pathspec) => typeof pathspec !== "string" || !isReviewablePathspec(pathspec))
  ) {
    return undefined;
  }

  return value.map((pathspec) => pathspec.trim());
}

/** Validate a focus or memento target without changing its operation. */
export function isReviewTarget(value: unknown): value is ReviewTarget {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as {
    kind?: unknown;
    expression?: unknown;
    ref?: unknown;
    pathspecs?: unknown;
  };
  if (record.pathspecs !== undefined && !pathspecsOf(record.pathspecs)) {
    return false;
  }

  if (record.kind === "working-tree" || record.kind === "staged") {
    return true;
  }

  if (record.kind === "range") {
    return typeof record.expression === "string" && isReviewableExpression(record.expression);
  }

  if (record.kind === "show" || record.kind === "stash-show") {
    if (record.kind === "stash-show" && record.pathspecs !== undefined) {
      return false;
    }

    return (
      record.ref === undefined ||
      (typeof record.ref === "string" && isReviewableExpression(record.ref))
    );
  }

  return false;
}

/** Recover a remembered target, falling back rather than trusting stored state. */
export function parseReviewTarget(value: unknown): ReviewTarget {
  if (typeof value !== "object" || value === null) {
    return WORKING_TREE_TARGET;
  }

  const record = value as {
    kind?: unknown;
    expression?: unknown;
    ref?: unknown;
    pathspecs?: unknown;
  };
  const pathspecs = record.pathspecs === undefined ? undefined : pathspecsOf(record.pathspecs);
  if (record.pathspecs !== undefined && !pathspecs) {
    return WORKING_TREE_TARGET;
  }

  if (record.kind === "working-tree" || record.kind === "staged") {
    return { kind: record.kind, ...(pathspecs ? { pathspecs } : {}) };
  }

  if (record.kind === "range" && typeof record.expression === "string") {
    const expression = record.expression.trim();
    return isReviewableExpression(expression)
      ? { kind: "range", expression, ...(pathspecs ? { pathspecs } : {}) }
      : WORKING_TREE_TARGET;
  }

  if (record.kind === "show" || record.kind === "stash-show") {
    if (record.kind === "stash-show" && pathspecs !== undefined) {
      return WORKING_TREE_TARGET;
    }

    if (record.ref !== undefined && typeof record.ref !== "string") {
      return WORKING_TREE_TARGET;
    }

    const ref = typeof record.ref === "string" ? record.ref.trim() : undefined;
    if (ref !== undefined && !isReviewableExpression(ref)) {
      return WORKING_TREE_TARGET;
    }

    return {
      kind: record.kind,
      ...(ref ? { ref } : {}),
      ...(record.kind === "show" && pathspecs ? { pathspecs } : {}),
    } as ReviewTarget;
  }

  return WORKING_TREE_TARGET;
}
