import { useEffect, useMemo, useRef } from "react";
import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { Divider } from "./components/layout/Divider.js";
import { Titlebar } from "./components/layout/Titlebar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { BottomTerminalBar } from "./components/layout/BottomTerminalBar.js";
import { SettingsPage } from "./components/settings/SettingsPage.js";
import { CommandPalette } from "./components/layout/CommandPalette.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useSessionStore } from "./stores/sessionStore.js";
import { useTheme } from "./lib/theme.js";
import { useChatAppearance, useRightPanelAppearance } from "./lib/appearance.js";
import { OpenTabsBar } from "./components/ide/OpenTabsBar.js";
import { FileEditor } from "./components/ide/FileEditor.js";
import { GitDiffDialog } from "./components/ide/GitDiffDialog.js";

export function App() {
  // Subscribe to the claude event stream for the app's whole lifetime.
  useClaudeEvents();
  // Apply + keep in sync the color scheme (.dark on <html>).
  useTheme();
  // Apply + keep in sync the chat appearance CSS vars (--chat-font-size,
  // --user-bubble) from the user-configurable settings.
  useChatAppearance();
  // Apply + keep in sync the global side-panel + settings font-size CSS var
  // (--right-panel-font-size) for the left bar, right files/git/terminal
  // panels, and the settings page.
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

  /** Left / right sidebar + bottom terminal visibility. Lifted from local
   *  useState into the store so the command palette (and any other consumer)
   *  can toggle them. Workspace-only — the settings view pins leftOpen=true /
   *  rightOpen=false. NOT persisted (matches original behavior). */
  const leftOpen = useSessionStore((s) => s.leftOpen);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const bottomTerminalOpen = useSessionStore((s) => s.bottomTerminalOpen);
  const setBottomTerminalOpen = useSessionStore((s) => s.setBottomTerminalOpen);

  /** Draggable pane sizes + resize actions (from the store; persisted). */
  const leftWidth = useSessionStore((s) => s.leftWidth);
  const rightWidth = useSessionStore((s) => s.rightWidth);
  const bottomTerminalHeight = useSessionStore((s) => s.bottomTerminalHeight);
  const adjustLeftWidth = useSessionStore((s) => s.adjustLeftWidth);
  const adjustRightWidth = useSessionStore((s) => s.adjustRightWidth);
  const adjustBottomTerminalHeight = useSessionStore((s) => s.adjustBottomTerminalHeight);
  const resetLeftWidth = useSessionStore((s) => s.resetLeftWidth);
  const resetRightWidth = useSessionStore((s) => s.resetRightWidth);
  const resetBottomTerminalHeight = useSessionStore((s) => s.resetBottomTerminalHeight);

  /** Command palette (Cmd/Ctrl+K) visibility. */
  const setCommandPaletteOpen = useSessionStore((s) => s.setCommandPaletteOpen);

  // Auto-open the right panel when something requests its attention (the
  // 审查 button on a turn-files card, or any openFileInIde call). The store
  // can't reach into this local state, so it bumps a nonce we watch here.
  const ideFocusNonce = useSessionStore((s) => s.ideFocusNonce);
  useEffect(() => {
    if (ideFocusNonce > 0) setRightOpen(true);
  }, [ideFocusNonce, setRightOpen]);

  // Global Cmd/Ctrl+K toggles the command palette. Registered on window so it
  // works in both workspace and settings views. preventDefault stops the
  // browser's default Cmd+K behavior (focus search bar / caret browsing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen(!useSessionStore.getState().commandPaletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandPaletteOpen]);

  return (
    <div className="flex h-full w-full flex-col bg-surface text-content">
      {/* Command palette overlays both workspace and settings views. */}
      <CommandPalette />
      {settingsOpen ? (
        <>
          <Titlebar
            mode="settings"
            leftOpen
            rightOpen={false}
            bottomTerminalOpen={false}
            onBack={() => setSettingsOpen(false)}
          />
          {/* The settings page reuses the three-pane shell with the right
              panel collapsed, so visually it reads as the same workspace
              minus the IDE sidebar. The titlebar/center divider is a border-t
              on the center <main> in ThreePaneLayout, spanning only the center
              area (not the sidebar) so the left sidebar blends seamlessly into
              the titlebar's sidebar strip above. */}
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
            bottomTerminalOpen={bottomTerminalOpen}
            onToggleLeft={() => setLeftOpen(!leftOpen)}
            onToggleRight={() => setRightOpen(!rightOpen)}
            onToggleBottomTerminal={() => setBottomTerminalOpen(!bottomTerminalOpen)}
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
              bottomTerminal={<BottomTerminalBar active={bottomTerminalOpen} />}
              bottomTerminalOpen={bottomTerminalOpen}
              leftWidth={leftWidth}
              rightWidth={rightWidth}
              bottomTerminalHeight={bottomTerminalHeight}
              onResizeLeft={adjustLeftWidth}
              onResizeRight={adjustRightWidth}
              onResizeBottomTerminal={adjustBottomTerminalHeight}
              onResetLeft={resetLeftWidth}
              onResetRight={resetRightWidth}
              onResetBottomTerminal={resetBottomTerminalHeight}
            />
          </div>
          {/* Git diff dialog (the "dialog" open-mode). Portaled to <body>;
              renders nothing when closed or empty. Mounted at the workspace
              level so it overlays the editor while staying app-scoped. */}
          <GitDiffDialog />
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

  // Draggable chat|editor split. The editor column's share is a persisted
  // percentage; the chat column gets the remainder. The Divider reports a px
  // delta which we convert to a percentage delta using the container's
  // measured width (captured via ref on the split row).
  const editorWidthPct = useSessionStore((s) => s.editorWidthPct);
  const adjustEditorWidthPct = useSessionStore((s) => s.adjustEditorWidthPct);
  const resetEditorWidthPct = useSessionStore((s) => s.resetEditorWidthPct);
  const splitRef = useRef<HTMLDivElement>(null);

  // Convert a px drag delta into a percentage-point delta relative to the
  // container width. Dragging the divider RIGHT (delta>0) grows the editor.
  const handleEditorResize = (deltaPx: number) => {
    const el = splitRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustEditorWidthPct(Math.round((deltaPx / w) * 100));
  };

  return (
    <div ref={splitRef} className="flex h-full min-h-0">
      {/* Chat column — flex-basis is the remainder of the editor share so the
          two columns split the center pane proportionally. When no file is
          open it takes the full width (flex-1). */}
      <div
        className="flex min-w-0 flex-col"
        style={activeFile ? { flexGrow: 0, flexBasis: `${100 - editorWidthPct}%` } : { flexGrow: 1, flexBasis: "0%" }}
      >
        <ChatColumn />
      </div>
      {/* Divider between chat and editor — only when a file is open. */}
      {activeFile && (
        <Divider
          orientation="vertical"
          onResize={handleEditorResize}
          onDoubleClick={resetEditorWidthPct}
        />
      )}
      {/* Editor column — only when a file is active. Grows to its share. */}
      {activeFile && (
        <div
          className="flex min-w-0 flex-col border-l border-edge bg-surface"
          style={{ flexGrow: 0, flexBasis: `${editorWidthPct}%` }}
        >
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
