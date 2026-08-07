import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconGitBranch,
  IconWorld,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";

/** Right panel: a vertical icon rail + a main panel area (IDE-style).
 *
 *  The narrow rail on the left is always visible and holds three icons:
 *    - Files  → shows FilesPanel in the main area
 *    - Git    → shows GitPanel in the main area
 *    - Browser → opens the full-workspace browser overlay (the overlay is
 *      rendered at the App root, not here; clicking just flips
 *      browserPanelOpen). The rail icon mirrors the old titlebar toggle.
 *
 *  The active panel (files / git) is read from / written to the session store
 *  (persisted in the settings table), so it survives restarts. The browser
 *  icon is highlighted while its overlay is open and shows a badge with the
 *  open-tab count. */
export function RightPanel() {
  const tab = useSessionStore((s) => s.rightPanelTab);
  const setTab = useSessionStore((s) => s.setRightPanelTab);
  const browserPanelOpen = useSessionStore((s) => s.browserPanelOpen);
  const setBrowserPanelOpen = useSessionStore((s) => s.setBrowserPanelOpen);
  const browserTabCount = useSessionStore((s) => s.browserTabCount);

  return (
    <div className="flex h-full">
      {/* Main panel area — must NOT scroll itself (children own height /
          overflow). Renders the panel matching the active tab. The browser
          overlay is rendered elsewhere (App root) and covers the whole
          workspace, so nothing is rendered for it here. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "files" && <FilesPanel />}
        {tab === "git" && <GitPanel />}
      </div>

      {/* Vertical icon rail — always visible. Each icon is a square button;
          the active one is marked with the accent token. */}
      <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-edge bg-surface-muted py-2">
        <RailButton
          active={tab === "files"}
          onClick={() => setTab("files")}
          title="文件"
        >
          <IconFolder size={20} className="shrink-0" />
        </RailButton>
        <RailButton
          active={tab === "git"}
          onClick={() => setTab("git")}
          title="Git"
        >
          <IconGitBranch size={20} className="shrink-0" />
        </RailButton>
        {/* Browser — opens the full-workspace overlay (not a panel swap). */}
        <div className="relative">
          <RailButton
            active={browserPanelOpen}
            onClick={() => setBrowserPanelOpen(!browserPanelOpen)}
            title={browserPanelOpen ? "隐藏浏览器" : "打开浏览器"}
          >
            <IconWorld size={20} className="shrink-0" />
          </RailButton>
          {browserTabCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white">
              {browserTabCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** A square icon button in the vertical rail. Active state uses the accent
 *  token; idle state uses the muted content token with a hover surface. */
function RailButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-content-muted hover:bg-surface-hover hover:text-content",
      )}
    >
      {children}
    </button>
  );
}
