import { useEffect, useState, type ComponentType } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconGitBranch,
  IconTerminal2,
  IconGlobe,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import type { RightPanelTab } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { TerminalPanel } from "@renderer/components/ide/TerminalPanel.js";

/** Right panel: tabbed inspector for files / git / terminal / browser.
 *
 *  Files / Git / Terminal are implemented. Browser remains a placeholder
 *  (P5). The active tab is read from / written to the session store
 *  (persisted in the settings table), so it survives restarts.
 *
 *  TerminalPanel is keep-alive mounted (CSS-hidden when inactive) so PTYs
 *  and xterm scrollback survive leaving/returning to the Terminal tab.
 *  Files/Git stay conditionally mounted — they refetch cheaply. */
type TabDef = {
  id: RightPanelTab;
  label: string;
  icon: ComponentType<TablerIconProps>;
};

const TABS: TabDef[] = [
  { id: "files", label: "Files", icon: IconFolder },
  { id: "git", label: "Git", icon: IconGitBranch },
  { id: "terminal", label: "Terminal", icon: IconTerminal2 },
  { id: "browser", label: "Browser", icon: IconGlobe },
];

export function RightPanel() {
  const tab = useSessionStore((s) => s.rightPanelTab);
  const setTab = useSessionStore((s) => s.setRightPanelTab);
  // Lazy-mount terminal on first visit, then keep-alive so PTYs survive
  // switching away to Files/Git. Avoids spawning a shell on every app boot.
  const [terminalVisited, setTerminalVisited] = useState(() => tab === "terminal");
  useEffect(() => {
    if (tab === "terminal") setTerminalVisited(true);
  }, [tab]);

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip — icon + label, active marked by an accent underline. */}
      <div className="flex shrink-0 border-b border-edge">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 px-2 py-2 font-medium uppercase tracking-wide transition-colors [font-size:var(--rp-fs-sm)]",
                active
                  ? "border-b-2 border-accent text-content"
                  : "border-b-2 border-transparent text-content-subtle hover:text-content-muted",
              )}
              title={t.label}
            >
              <Icon size={14} className="shrink-0" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Body — must NOT scroll itself (children own height / overflow).
          Terminal stays mounted (hidden) after first visit. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "files" && <FilesPanel />}
        {tab === "git" && <GitPanel />}
        {terminalVisited && (
          <div
            className={cn(
              "absolute inset-0",
              tab === "terminal" ? "z-10" : "pointer-events-none invisible z-0",
            )}
            aria-hidden={tab !== "terminal"}
          >
            <TerminalPanel active={tab === "terminal"} />
          </div>
        )}
        {tab === "browser" && <Placeholder label="Browser" hint="浏览器预览(P5)" />}
      </div>
    </div>
  );
}

/** Centered placeholder for not-yet-implemented tabs. */
function Placeholder({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <span className="font-medium uppercase tracking-wide text-content-subtle [font-size:var(--rp-fs-sm)]">
        {label}
      </span>
      <span className="text-content-subtle [font-size:var(--rp-fs-xs)]">{hint}</span>
    </div>
  );
}
