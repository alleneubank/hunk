import type { AppTheme } from "../../themes";
import { fitText, measureTextWidth } from "../../lib/text";
import type { MenuId, MenuSpec } from "./menu";

/** Render the top menu bar and the current changeset title. */
export function MenuBar({
  activeMenuId,
  menuSpecs,
  terminalWidth,
  theme,
  topTitle,
  viewedProgressText,
  onHoverMenu,
  onToggleMenu,
}: {
  activeMenuId: MenuId | null;
  menuSpecs: MenuSpec[];
  terminalWidth: number;
  theme: AppTheme;
  topTitle: string;
  viewedProgressText?: string;
  onHoverMenu: (menuId: MenuId) => void;
  onToggleMenu: (menuId: MenuId) => void;
}) {
  const viewedProgressSegment = viewedProgressText ? ` ${viewedProgressText}` : "";
  const topTitleWidth = Math.max(0, terminalWidth - 41 - measureTextWidth(viewedProgressSegment));

  return (
    <box
      style={{
        height: 1,
        backgroundColor: theme.panelAlt,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {menuSpecs.map((menu) => {
        const active = activeMenuId === menu.id;
        return (
          <box
            key={menu.id}
            style={{
              width: menu.width,
              height: 1,
              backgroundColor: active ? theme.accentMuted : theme.panelAlt,
            }}
            onMouseUp={() => onToggleMenu(menu.id)}
            onMouseOver={() => onHoverMenu(menu.id)}
          >
            <text fg={active ? theme.text : theme.muted}>{` ${menu.label} `}</text>
          </box>
        );
      })}

      <box
        style={{
          flexGrow: 1,
          height: 1,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <text fg={theme.muted}>{` ${fitText(topTitle, topTitleWidth)}`}</text>
        {viewedProgressSegment ? <text fg={theme.muted}>{viewedProgressSegment}</text> : null}
      </box>
    </box>
  );
}
