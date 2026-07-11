import { useEffect, useMemo, useRef } from "react";
import type { CliInput, DiffFile } from "../../core/types";
import { findDiffFileByPath, hunkLineRange } from "../../core/liveComments";
import { createHunkSessionBridge } from "../../session/app/bridge";
import type {
  HunkSessionBrokerClient,
  ReloadedSessionResult,
  ReloadSessionOptions,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../../session/types";
import type { ReviewController } from "./useReviewController";

/** Bridge one live Hunk review session to the local session daemon. */
export function useHunkSessionBridge({
  addLiveComment,
  addLiveCommentBatch,
  clearLiveComments,
  hostClient,
  files,
  liveCommentCount,
  liveCommentSummaries,
  navigateToLocation,
  noteMarkupWidth,
  openAgentNotes,
  reloadSession,
  removeLiveComment,
  reviewNoteCount,
  reviewNoteSummaries,
  setFileViewed,
  selectedFile,
  selectedHunk,
  selectedHunkIndex,
  showAgentNotes,
  totalFileCount,
  viewedFileCount,
  viewedFileIds,
}: {
  addLiveComment: ReviewController["addLiveComment"];
  addLiveCommentBatch: ReviewController["addLiveCommentBatch"];
  clearLiveComments: ReviewController["clearLiveComments"];
  files: DiffFile[];
  hostClient?: HunkSessionBrokerClient;
  liveCommentCount: number;
  liveCommentSummaries: SessionLiveCommentSummary[];
  navigateToLocation: ReviewController["navigateToLocation"];
  /** Width STML note markup currently renders at (see agentNoteMarkupWidth). */
  noteMarkupWidth?: number;
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: CliInput,
    options?: ReloadSessionOptions,
  ) => Promise<ReloadedSessionResult>;
  removeLiveComment: ReviewController["removeLiveComment"];
  reviewNoteCount: number;
  reviewNoteSummaries: SessionReviewNoteSummary[];
  setFileViewed: ReviewController["setFileViewed"];
  selectedFile: DiffFile | undefined;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  selectedHunkIndex: number;
  showAgentNotes: boolean;
  totalFileCount: number;
  viewedFileCount: number;
  viewedFileIds: ReadonlySet<string>;
}) {
  const viewedFileIdsRef = useRef(viewedFileIds);

  useEffect(() => {
    viewedFileIdsRef.current = viewedFileIds;
  }, [viewedFileIds]);

  const bridge = useMemo(
    () =>
      createHunkSessionBridge({
        addLiveComment,
        addLiveCommentBatch,
        clearLiveComments,
        navigateToLocation,
        openAgentNotes,
        reloadSession: (nextInput, options) => reloadSession(nextInput, { ...options }),
        removeLiveComment,
        setFileViewed: (input) => {
          const file = findDiffFileByPath(files, input.filePath);
          if (!file) {
            throw new Error(`No diff file matches ${input.filePath}.`);
          }

          const nextViewedFileIds = new Set(viewedFileIdsRef.current);
          if (input.viewed) {
            nextViewedFileIds.add(file.id);
          } else {
            nextViewedFileIds.delete(file.id);
          }

          // Keep daemon command results coherent when commands arrive before React re-renders.
          viewedFileIdsRef.current = nextViewedFileIds;
          setFileViewed(file.id, input.viewed);

          return {
            filePath: file.path,
            viewed: input.viewed,
            viewedFileCount: nextViewedFileIds.size,
            totalFileCount,
          };
        },
      }),
    [
      addLiveComment,
      addLiveCommentBatch,
      clearLiveComments,
      files,
      navigateToLocation,
      openAgentNotes,
      reloadSession,
      removeLiveComment,
      setFileViewed,
      totalFileCount,
    ],
  );

  useEffect(() => {
    if (!hostClient) {
      return;
    }

    hostClient.setBridge(bridge);

    return () => {
      hostClient.setBridge(null);
    };
  }, [bridge, hostClient]);

  useEffect(() => {
    const selectedRange = selectedHunk ? hunkLineRange(selectedHunk) : undefined;

    hostClient?.updateSnapshot({
      updatedAt: new Date().toISOString(),
      state: {
        selectedFileId: selectedFile?.id,
        selectedFilePath: selectedFile?.path,
        selectedHunkIndex,
        selectedHunkOldRange: selectedRange?.oldRange,
        selectedHunkNewRange: selectedRange?.newRange,
        showAgentNotes,
        noteMarkupWidth,
        liveCommentCount,
        liveComments: liveCommentSummaries,
        reviewNoteCount,
        reviewNotes: reviewNoteSummaries,
        viewedFileCount,
        viewedFilePaths: files
          .filter((file) => viewedFileIds.has(file.id))
          .map((file) => file.path),
      },
    });
  }, [
    hostClient,
    files,
    liveCommentCount,
    liveCommentSummaries,
    noteMarkupWidth,
    reviewNoteCount,
    reviewNoteSummaries,
    selectedFile?.id,
    selectedFile?.path,
    selectedHunk,
    selectedHunkIndex,
    showAgentNotes,
    viewedFileCount,
    viewedFileIds,
  ]);
}
