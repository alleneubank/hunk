import { isEscapeKey } from "../../lib/keyboard";
import { fitText, measureTextWidth } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Columns the status bar's own padding takes away from its single content row. */
const STATUS_BAR_CHROME_COLUMNS = 2;

/** Render the active file filter input or current filter summary. */
export function StatusBar({
  filter,
  filterFocused,
  noticeText,
  terminalWidth,
  theme,
  viewedProgressText,
  onCloseMenu,
  onFilterInput,
  onFilterSubmit,
}: {
  filter: string;
  filterFocused: boolean;
  noticeText?: string;
  terminalWidth: number;
  theme: AppTheme;
  viewedProgressText?: string;
  onCloseMenu: () => void;
  onFilterInput: (value: string) => void;
  onFilterSubmit: () => void;
}) {
  const viewedProgressWidth = viewedProgressText ? measureTextWidth(viewedProgressText) : 0;
  // The status bar is one row by contract: the toast above it and the review pane below both
  // depend on that. Notice text is host- and extension-authored and can run arbitrarily long, so
  // clamp it to the columns the progress segment leaves rather than letting it reflow the chrome.
  const noticeWidth = Math.max(0, terminalWidth - STATUS_BAR_CHROME_COLUMNS - viewedProgressWidth);

  return (
    <box
      style={{
        height: 1,
        backgroundColor: theme.panelAlt,
        paddingLeft: 1,
        paddingRight: 1,
        alignItems: "center",
        flexDirection: "row",
      }}
      onMouseUp={onCloseMenu}
    >
      {filterFocused ? (
        <>
          <text fg={theme.badgeNeutral}>filter:</text>
          <box style={{ width: 1, height: 1 }}>
            <text fg={theme.muted}> </text>
          </box>
          <input
            width={Math.max(1, terminalWidth - 11 - viewedProgressWidth)}
            value={filter}
            placeholder="type to filter files"
            focused={true}
            onInput={onFilterInput}
            onSubmit={onFilterSubmit}
            onKeyDown={(key) => {
              if (!isEscapeKey(key)) {
                return;
              }

              key.preventDefault();
              key.stopPropagation();

              if (filter.length > 0) {
                onFilterInput("");
                return;
              }

              onFilterSubmit();
            }}
          />
        </>
      ) : filter.length > 0 ? (
        <text fg={theme.muted}>{fitText(`filter=${filter}`, noticeWidth)}</text>
      ) : (
        <text fg={theme.muted}>{fitText(noticeText ?? "", noticeWidth)}</text>
      )}
      {viewedProgressText ? (
        <>
          <box style={{ height: 1, flexGrow: 1 }} />
          <text fg={theme.muted}>{viewedProgressText}</text>
        </>
      ) : null}
    </box>
  );
}
