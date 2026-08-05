import { createHash } from "node:crypto";
import type { DiffFile, ReviewNoteSource } from "../../core/types";
import type { SessionReviewNoteSummary } from "../types";

/** Timestamp used when a sidecar annotation carries none of its own. */
const UNDATED_NOTE_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * Derive one note's content identity.
 *
 * Hashes the file, the range, and the text, and deliberately nothing positional: a note that
 * nobody touched must key the same after the changeset around it changes shape. The range is
 * in because two notes on one file can legitimately say the same thing about different code;
 * the text is in because a rewritten note is a different note, and a reply written against
 * the old wording should stop matching rather than quietly answer the new one.
 */
export function reviewNoteKey(
  filePath: string,
  body: string,
  range: [number, number] | undefined,
): string {
  const location = range ? `${range[0]}-${range[1]}` : "";
  return createHash("sha256").update(`${filePath}\n${location}\n${body}`).digest("hex");
}

/** Resolve the user-facing source for one sidecar annotation. */
function annotationSource(source: string | undefined): ReviewNoteSource {
  if (source === "user") {
    return "user";
  }

  return source === "mcp" || source === "agent" ? "agent" : "ai";
}

/**
 * Project sidecar agent annotations into review-note summaries.
 *
 * Shared on purpose: the live TUI reports these through its session snapshot and the
 * headless export reports them straight from the changeset, and a note must not have a
 * different id, range, or body depending on which one a client asked. Live comments and
 * user-authored notes are deliberately not here — they exist only inside a running
 * session, so a headless reader has nothing to report for them.
 */
export function buildSidecarReviewNotes(
  files: Array<Pick<DiffFile, "id" | "path" | "agent">>,
): SessionReviewNoteSummary[] {
  return files.flatMap((file) =>
    (file.agent?.annotations ?? []).map((annotation, index) => {
      const source = annotationSource(annotation.source);
      const body = [annotation.summary, annotation.rationale].filter(Boolean).join("\n\n");

      return {
        noteId: annotation.id ?? `${source}:${file.id}:${index}`,
        noteKey: reviewNoteKey(file.path, body, annotation.newRange ?? annotation.oldRange),
        source,
        filePath: file.path,
        ...(annotation.oldRange ? { oldRange: annotation.oldRange } : {}),
        ...(annotation.newRange ? { newRange: annotation.newRange } : {}),
        body,
        ...(annotation.title ? { title: annotation.title } : {}),
        ...(annotation.author ? { author: annotation.author } : {}),
        createdAt: annotation.createdAt ?? UNDATED_NOTE_TIMESTAMP,
        ...(annotation.updatedAt ? { updatedAt: annotation.updatedAt } : {}),
        // Sidecar notes are authored elsewhere; a reviewer reads them, never edits them.
        editable: false,
      } satisfies SessionReviewNoteSummary;
    }),
  );
}
