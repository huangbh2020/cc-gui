import { useEffect, useState } from "react";
import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { StatusBar } from "./components/layout/StatusBar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { SettingsModal } from "./components/settings/SettingsModal.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useSessionStore } from "./stores/sessionStore.js";
import { useTheme } from "./lib/theme.js";
import { cn } from "./lib/cn.js";
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
          with -webkit-app-region: no-drag so clicks pass through. */}
      <div
        className="flex h-8 shrink-0 items-center border-b border-edge bg-surface px-1.5 pr-[138px]"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <button
          onClick={() => setLeftOpen((v) => !v)}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-content-muted transition-colors",
            "hover:bg-surface-muted hover:text-content",
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

      <div className="relative flex min-h-0 flex-1">
        <ThreePaneLayout
          left={<LeftBar />}
          center={<CenterPane />}
          right={<RightPanel />}
          leftOpen={leftOpen}
          onToggleLeft={() => setLeftOpen((v) => !v)}
          rightOpen={rightOpen}
        />
      </div>
      <StatusBar />
      <SettingsModal />
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
