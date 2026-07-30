import { cn } from "@renderer/lib/cn.js";
import { isMac } from "@renderer/lib/platform.js";
import {
  IconArrowLeft,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightExpand,
  IconTerminal2,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

type Mode = "workspace" | "settings";

interface Props {
  mode: Mode;
  /** Left sidebar visibility (workspace mode only - drives the left-strip
   *  width so the toggle button doesn't jump when the panel opens/closes). */
  leftOpen: boolean;
  /** Right sidebar visibility (workspace mode only). */
  rightOpen: boolean;
  /** Bottom terminal bar visibility (workspace mode only). */
  bottomTerminalOpen: boolean;
  onToggleLeft?: () => void;
  onToggleRight?: () => void;
  onToggleBottomTerminal?: () => void;
  /** Settings mode: returns to the workspace view. */
  onBack?: () => void;
}

/** Custom titlebar — sits behind the native window controls (titleBarStyle:
 *  hidden) so the toggle buttons share the same row as min/max/close.
 *  -webkit-app-region: drag makes the bar draggable; the buttons opt out with
 *  -webkit-app-region: no-drag so clicks pass through.
 *
 *  The bar is split vertically to match the panes below it: a sidebar strip
 *  (bg-surface-muted) over the left panel, and a main strip (bg-surface) over
 *  the center. This makes the left panel read as one continuous block running
 *  to the top of the window (no divider between the titlebar sidebar strip and
 *  the sidebar below - they blend), while the center keeps the distinct
 *  "toolbar above editor" separation. The horizontal titlebar/center divider
 *  is drawn as a border-t on the center <main> in ThreePaneLayout (not here),
 *  so it spans only the center area and isn't clipped by the native
 *  titleBarOverlay on Windows/Linux.
 *
 *  Two modes:
 *   - workspace: left strip carries the left-panel toggle (always rendered so
 *     the button stays put whether the panel is open or closed); main strip
 *     carries the active-thread title chip + right-panel toggle.
 *   - settings:  left strip is fixed at the sidebar width (reads the same
 *     leftWidth from the store as the workspace sidebar, so the back button
 *     lines up with the settings menu below); carries a "返回工作区" back
 *     button; main strip shows "设置".
 *
 *  Platform reservation: on macOS the traffic lights sit on the LEFT, so the
 *  sidebar strip reserves left padding; on Windows/Linux the titleBarOverlay
 *  controls (min/max/close) sit on the RIGHT, so the main strip reserves
 *  right padding. */
export function Titlebar({
  mode,
  leftOpen,
  rightOpen,
  bottomTerminalOpen,
  onToggleLeft,
  onToggleRight,
  onToggleBottomTerminal,
  onBack,
}: Props) {
  const isSettings = mode === "settings";

  // The left strip tracks the sidebar's draggable width so the toggle button
  // and the settings back button stay aligned with the panel edge below.
  const leftWidth = useSessionStore((s) => s.leftWidth);
  const showLeftStrip = leftOpen || isSettings;

  return (
    <div
      className="flex h-10 shrink-0 items-stretch"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div
        className={cn(
          "flex shrink-0 items-center rounded-tl-lg bg-surface-muted pr-1.5",
          // In settings mode the sidebar strip is always shown so the back
          // button lines up with the settings menu below.
          showLeftStrip && "rounded-tr-lg border-r border-edge",
          isMac ? "pl-[78px]" : "pl-1.5",
        )}
        style={showLeftStrip ? { width: leftWidth } : undefined}
      >
        {isSettings ? (
          <button
            onClick={onBack}
            className={cn(
              "flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium",
              "text-content-muted transition-colors hover:bg-surface-hover hover:text-content",
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title="返回工作区"
          >
            <IconArrowLeft size={16} className="shrink-0" />
            返回工作区
          </button>
        ) : (
          <button
            onClick={onToggleLeft}
            className={cn(
              "flex items-center justify-center rounded p-1.5 text-content-muted transition-colors",
              "hover:bg-surface-hover hover:text-content",
            )}
            title={leftOpen ? "隐藏左侧面板" : "显示左侧面板"}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <IconLayoutSidebarLeftExpand
              size={18}
              className={cn(
                "shrink-0 transition-transform",
                !leftOpen && "scale-x-[-1]",
              )}
            />
          </button>
        )}
      </div>

      <div
        className={cn(
          "flex flex-1 items-center bg-surface px-1.5",
          !isMac && "pr-[138px]",
        )}
      >
        {isSettings ? (
          <h2 className="px-1.5 text-sm font-semibold text-content">设置</h2>
        ) : (
          <>
            <ActiveThreadTitle />
            <div className="flex-1" />
            {/* Bottom terminal toggle — sits just left of the right-panel
                toggle. Active state highlighted with the accent token. */}
            <button
              onClick={onToggleBottomTerminal}
              className={cn(
                "flex items-center justify-center rounded p-1.5 transition-colors",
                bottomTerminalOpen
                  ? "bg-surface-hover text-accent"
                  : "text-content-muted hover:bg-surface-hover hover:text-content",
              )}
              title={bottomTerminalOpen ? "隐藏终端" : "显示终端"}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <IconTerminal2 size={18} className="shrink-0" />
            </button>
            <button
              onClick={onToggleRight}
              className={cn(
                "flex items-center justify-center rounded p-1.5 text-content-muted transition-colors",
                "hover:bg-surface-muted hover:text-content",
              )}
              title={rightOpen ? "隐藏右侧面板" : "显示右侧面板"}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <IconLayoutSidebarRightExpand
                size={18}
                className={cn(
                  "shrink-0 transition-transform",
                  !rightOpen && "scale-x-[-1]",
                )}
              />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Active-thread title chip rendered on the left of the main titlebar strip.
 *  Fixed width, single line, truncated with ellipsis when too long; the full
 *  name shows in a native title tooltip on hover. Hidden when no session is
 *  open (leaves an empty drag region). */
function ActiveThreadTitle() {
  // Resolve the active session's title from the flat session list. Returns
  // null when there's no active session — caller hides the chip entirely.
  const title = useSessionStore((s) => {
    if (!s.activeSessionId) return null;
    const sess = s.sessions.find((x) => x.id === s.activeSessionId);
    return sess?.title ?? null;
  });
  if (!title) return null;
  return (
    <div
      className="min-w-0 max-w-[280px] shrink-0 truncate px-1.5 text-xs font-medium text-content-muted"
      title={title}
    >
      {title}
    </div>
  );
}
