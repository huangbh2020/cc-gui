import { useEffect, useState } from "react";
import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { Titlebar } from "./components/layout/Titlebar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { SettingsPage } from "./components/settings/SettingsPage.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useSessionStore } from "./stores/sessionStore.js";
import { useTheme } from "./lib/theme.js";
import { useChatAppearance } from "./lib/appearance.js";

export function App() {
  // Subscribe to the claude event stream for the app's whole lifetime.
  useClaudeEvents();
  // Apply + keep in sync the color scheme (.dark on <html>).
  useTheme();
  // Apply + keep in sync the chat appearance CSS vars (--chat-font-size,
  // --user-bubble) from the user-configurable settings.
  useChatAppearance();

  const init = useSessionStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  /** Settings page visibility — opened from the LeftBar ⚙ footer, the
   *  CLI-missing CTA, or the model-dropdown "manage models" entry. Renders as
   *  a sibling view (not a modal) sharing the same titlebar + pane shell. */
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  /** Left / right sidebar visibility. Toggled by the buttons in the custom
   *  titlebar (and by the floating "▸ 项目" / "面板 ◂" buttons when collapsed).
   *  Workspace-only — the settings view pins leftOpen=true / rightOpen=false. */
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  return (
    <div className="flex h-full w-full flex-col bg-surface text-content">
      {settingsOpen ? (
        <>
          <Titlebar
            mode="settings"
            leftOpen
            rightOpen={false}
            onBack={() => setSettingsOpen(false)}
          />
          {/* The settings page reuses the three-pane shell with the right
              panel collapsed, so visually it reads as the same workspace
              minus the IDE sidebar. */}
          <div className="relative flex min-h-0 flex-1 bg-surface-muted">
            <SettingsPage />
          </div>
        </>
      ) : (
        <>
          <Titlebar
            mode="workspace"
            leftOpen={leftOpen}
            rightOpen={rightOpen}
            onToggleLeft={() => setLeftOpen((v) => !v)}
            onToggleRight={() => setRightOpen((v) => !v)}
          />
          {/* Panel row — bg-surface-muted as the contrasting track so the
              center pane's rounded bottom-left corner (in ThreePaneLayout)
              reveals this muted color through the notch and reads as a clean
              arc. The left sidebar is also bg-surface-muted, so it blends
              seamlessly into the track; the center pane (bg-surface) sits on
              top. */}
          <div className="relative flex min-h-0 flex-1 bg-surface-muted">
            <ThreePaneLayout
              left={<LeftBar />}
              center={<CenterPane />}
              right={<RightPanel />}
              leftOpen={leftOpen}
              rightOpen={rightOpen}
            />
          </div>
        </>
      )}
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
