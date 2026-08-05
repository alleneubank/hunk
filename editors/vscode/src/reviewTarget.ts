/**
 * Which changeset a review covers.
 *
 * A local PR review is rarely the working tree — it is a branch against the point it left
 * its base. Hunk's CLI has always taken a target; the extension asked for one changeset and
 * so could only ever review uncommitted edits.
 *
 * `range` carries the expression verbatim rather than modelling branches, because deciding
 * what `main...HEAD` means is Git's job and the extension is forbidden from forming its own
 * opinion about the changeset (REQ-VSCODE-007). It passes the expression through and lets
 * Hunk resolve it exactly as `hunk diff` would.
 */
export type ReviewTarget =
  | { kind: "working-tree" }
  | { kind: "staged" }
  | { kind: "range"; expression: string };

export const WORKING_TREE_TARGET: ReviewTarget = { kind: "working-tree" };

/** The arguments that select one target, appended to every review invocation. */
export function targetArguments(target: ReviewTarget): string[] {
  switch (target.kind) {
    case "staged":
      return ["--staged"];
    case "range":
      return [target.expression];
    default:
      return [];
  }
}

/** Short label for the view header, so the reviewer always knows what they are reading. */
export function targetLabel(target: ReviewTarget): string {
  switch (target.kind) {
    case "staged":
      return "staged changes";
    case "range":
      return target.expression;
    default:
      return "working tree";
  }
}

/**
 * Whether one expression can be passed to Hunk as a target.
 *
 * A leading dash would be read as a flag rather than a revision, and an empty expression
 * would silently become the working tree — a different review than the one asked for.
 */
export function isReviewableExpression(expression: string): boolean {
  const trimmed = expression.trim();

  return trimmed.length > 0 && !trimmed.startsWith("-");
}

/**
 * Recover a remembered target, falling back rather than trusting stored state.
 *
 * Workspace state survives upgrades and hand edits, so a shape this version does not
 * recognize resolves to the working tree instead of being passed to the CLI unchecked.
 */
export function parseReviewTarget(value: unknown): ReviewTarget {
  if (typeof value !== "object" || value === null) {
    return WORKING_TREE_TARGET;
  }

  const kind = (value as { kind?: unknown }).kind;
  if (kind === "staged") {
    return { kind: "staged" };
  }

  const expression = (value as { expression?: unknown }).expression;
  if (kind === "range" && typeof expression === "string" && isReviewableExpression(expression)) {
    return { kind: "range", expression: expression.trim() };
  }

  return WORKING_TREE_TARGET;
}
