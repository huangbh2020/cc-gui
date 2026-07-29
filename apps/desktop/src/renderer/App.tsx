import { useEffect, useMemo, useState } from "react";
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
import { useChatAppearance, useRightPanelAppearance } from "./lib/appearance.js";
import { OpenTabsBar } from "./components/ide/OpenTabsBar.js";
import { FileEditor } from "./components/ide/FileEditor.js";

export function App() {
  // Subscribe to the claude event stream for the app's whole lifetime.
  useClaudeEvents();
  // Apply + keep in sync the color scheme (.dark on <html>).
  useTheme();
  // Apply + keep in sync the chat appearance CSS vars (--chat-font-size,
  // --user-bubble) from the user-configurable settings.
  useChatAppearance();
  // Apply + keep in sync the right-panel font-size CSS var
  // (--right-panel-font-size) for the files / git / terminal tabs.
  useRightPanelAppearance();

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

  // Auto-open the right panel when something requests its attention (the
  // 审查 button on a turn-files card, or any openFileInIde call). The store
  // can't reach into this local state, so it bumps a nonce we watch here.
  const ideFocusNonce = useSessionStore((s) => s.ideFocusNonce);
  useEffect(() => {
    if (ideFocusNonce > 0) setRightOpen(true);
  }, [ideFocusNonce]);

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

/** Center pane router: a horizontal split between the chat column (left)
 *  and the file-editor column (right). When no file is open the editor
 *  column is omitted and the chat column takes the full width — the layout
 *  the user sees when they haven't clicked any files yet.
 *
 *  The chat column chooses between single-session and tabbed layouts based
 *  on the user's `displayMode` preference (see the design notes in
 *  docs/tech-stack.md). The editor column hosts the Monaco FileEditor + its
 *  tab bar, and is only rendered when `ideActiveFile` is non-null. */
function CenterPane() {
  // The active file is scoped to the active project — switching projects
  // swaps to that project's open files (or hides the editor if none).
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null,
  );

  return (
    <div className="flex h-full min-h-0">
      {/* Chat column — takes full width when no file is open, otherwise 1/2. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatColumn />
      </div>
      {/* Editor column — only when a file is active. 1/2 width, left border
          as the visual divider. */}
      {activeFile && (
        <div className="flex min-w-0 flex-1 flex-col border-l border-edge bg-surface">
          <EditorColumn filePath={activeFile} />
        </div>
      )}
    </div>
  );
}

/** The chat half: SessionTabs strip (in tabs mode) + the active ChatPane.
 *  Keyed on sessionId so switching tabs re-mounts (clean composer state,
 *  fresh scroll position). */
function ChatColumn() {
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
  return <ChatPane key={activeSessionId ?? "empty"} sessionId={activeSessionId} />;
}

/** The editor half: OpenTabsBar (only in tabs mode) + the active FileEditor.
 *  Resolves the project path from the active project so FileEditor can show
 *  relative paths in its toolbar. */
function EditorColumn({ filePath }: { filePath: string }) {
  const editorMode = useSessionStore((s) => s.ideEditorMode);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId)?.path ?? null;
  }, [activeProjectId, projects]);

  return (
    <>
      {editorMode === "tabs" && <OpenTabsBar />}
      <div className="min-h-0 flex-1">
        {projectPath ? (
          <FileEditor key={filePath} filePath={filePath} projectPath={projectPath} />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">
            无法解析项目路径
          </div>
        )}
      </div>
    </>
  );
}
