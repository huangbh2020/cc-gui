import { useEffect, useState } from "react";
import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { SettingsModal } from "./components/settings/SettingsModal.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useSessionStore } from "./stores/sessionStore.js";
import { useTheme } from "./lib/theme.js";
import { cn } from "./lib/cn.js";
import { isMac } from "./lib/platform.js";
import { IconLayoutSidebarLeftExpand, IconLayoutSidebarRightExpand } from "./lib/icons.js";

export function App() {
  // Subscribe to the claude event stream for the app's whole lifetime.
  useClaudeEvents();
  // Apply + keep in sync the color scheme (.dark on <html>).
  useTheme();

  const init = useSessionStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  /** Left / right sidebar visibility. Toggled by the buttons in the custom
   *  titlebar (and by the floating "▸ 项目" / "面板 ◂" buttons when collapsed). */
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  return (
    <div className="flex h-full w-full flex-col bg-surface text-content">
      {/* Custom titlebar — sits behind the native window controls (titleBarStyle:
          hidden) so the toggle buttons share the same row as min/max/close.
          -webkit-app-region: drag makes the bar draggable; the buttons opt out
          with -webkit-app-region: no-drag so clicks pass through.

          The bar is split vertically to match the panes below it: a sidebar
          strip (bg-surface-muted, no bottom border) over the left panel, and a
          main strip (bg-surface, border-b) over the center. This makes the
          left panel read as one continuous block running to the top of the
          window, while the main area keeps the distinct "toolbar above editor"
          separation.

          Platform reservation: on macOS the traffic lights sit on the LEFT, so
          the sidebar strip reserves left padding; on Windows/Linux the
          titleBarOverlay controls (min/max/close) sit on the RIGHT, so the main
          strip reserves right padding. */}
      <div
        className="flex h-10 shrink-0 items-stretch"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {/* Left-panel strip — always rendered so the toggle button stays at
            the same horizontal position whether the panel is open or closed
            (otherwise the "显示" / "隐藏" button would jump when toggling).
            Expands to the full sidebar width with a right divider when the
            panel is open; shrinks to just the button when closed. Left
            padding is platform-constant: macOS reserves room for the traffic
            lights, other platforms use the normal bar padding. */}
        <div
          className={cn(
            "flex shrink-0 items-center rounded-tl-lg bg-surface-muted pr-1.5",
            leftOpen && "w-[280px] border-r border-edge",
            isMac ? "pl-[78px]" : "pl-1.5",
          )}
        >
          <button
            onClick={() => setLeftOpen((v) => !v)}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-content-muted transition-colors",
              "hover:bg-surface-hover hover:text-content",
            )}
            title={leftOpen ? "隐藏左侧面板" : "显示左侧面板"}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <IconLayoutSidebarLeftExpand
              size={14}
              className={cn(
                "shrink-0 transition-transform",
                !leftOpen && "scale-x-[-1]",
              )}
            />
            {leftOpen ? "隐藏" : "显示"}
          </button>
        </div>

        {/* Main strip — sits above the center pane. Shows the active thread's
            title on the left (fixed-width, truncated with ellipsis; full
            name revealed on hover via the native title tooltip) and carries
            the right-panel toggle on the far right. Reserves space for the
            Windows/Linux window controls. */}
        <div
          className={cn(
            "flex flex-1 items-center border-b border-edge bg-surface px-1.5",
            !isMac && "pr-[138px]",
          )}
        >
          <ActiveThreadTitle />

          <div className="flex-1" />

          <button
            onClick={() => setRightOpen((v) => !v)}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-content-muted transition-colors",
              "hover:bg-surface-muted hover:text-content",
            )}
            title={rightOpen ? "隐藏右侧面板" : "显示右侧面板"}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {rightOpen ? "隐藏" : "显示"}
            <IconLayoutSidebarRightExpand
              size={14}
              className={cn(
                "shrink-0 transition-transform",
                !rightOpen && "scale-x-[-1]",
              )}
            />
          </button>
        </div>
      </div>

      {/* Panel row — bg-surface-muted as the contrasting track so the center
          pane's rounded bottom-left corner (in ThreePaneLayout) reveals this
          muted color through the notch and reads as a clean arc. The left
          sidebar is also bg-surface-muted, so it blends seamlessly into the
          track; the center pane (bg-surface) sits on top. */}
      <div className="relative flex min-h-0 flex-1 bg-surface-muted">
        <ThreePaneLayout
          left={<LeftBar />}
          center={<CenterPane />}
          right={<RightPanel />}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
        />
      </div>
      <SettingsModal />
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

/** Center pane router: chooses between single-session and tabbed layouts
 *  based on the user's `displayMode` preference. In `tabs` mode the
 *  SessionTabs strip sits above the active ChatPane. The active ChatPane
 *  is keyed on sessionId so switching tabs re-mounts (clean composer
 *  state, fresh scroll position) — see the design notes in
 *  docs/tech-stack.md. */
function CenterPane() {
  const displayMode = useSessionStore((s) => s.displayMode);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  if (displayMode === "tabs") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SessionTabs />
        <div className="min-h-0 flex-1">
          {activeSessionId && <ChatPane key={activeSessionId} sessionId={activeSessionId} />}
        </div>
      </div>
    );
  }
  // single mode: legacy behavior — one ChatPane, swapped by activeSessionId.
  // `null` sessionId tells ChatPane to render its empty-state placeholder.
  return <ChatPane key={activeSessionId ?? "empty"} sessionId={activeSessionId} />;
}
