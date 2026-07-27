import { useEffect } from "react";
import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { TopBar } from "./components/layout/TopBar.js";
import { StatusBar } from "./components/layout/StatusBar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { SettingsModal } from "./components/settings/SettingsModal.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useSessionStore } from "./stores/sessionStore.js";
import { useTheme } from "./lib/theme.js";

export function App() {
  // Subscribe to the claude event stream for the app's whole lifetime.
  useClaudeEvents();
  // Apply + keep in sync the color scheme (.dark on <html>).
  useTheme();

  const init = useSessionStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex h-full w-full flex-col bg-surface text-content">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <ThreePaneLayout
          left={<LeftBar />}
          center={<CenterPane />}
          right={<RightPanel />}
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
