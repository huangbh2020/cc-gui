import type { ComponentType } from "react";
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

/** Right panel: tabbed inspector for files / git / terminal / browser.
 *
 *  P4 implements the Files tab (file tree + Monaco editor/diff). Git /
 *  Terminal / Browser remain placeholders pending later phases. The active
 *  tab is read from / written to the session store (persisted in the
 *  settings table), so it survives restarts.
 *
 *  This file owns only the tab chrome + body routing. Each tab's content is
 *  a dedicated component (or a placeholder) rendered into the scroll-free
 *  flex body below — FilesPanel manages its own internal scrolling. */
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
                "flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium uppercase tracking-wide transition-colors",
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

      {/* Body — FilesPanel owns its layout (tree + editor); the placeholders
          are simple centered empty-states. The body must NOT scroll itself
          (FilesPanel needs full height for Monaco); placeholders center
          their own content. */}
      <div className="min-h-0 flex-1">
        {tab === "files" && <FilesPanel />}
        {tab === "git" && <GitPanel />}
        {tab === "terminal" && <Placeholder label="Terminal" hint="集成终端(P4 之后)" />}
        {tab === "browser" && <Placeholder label="Browser" hint="浏览器预览(P5)" />}
      </div>
    </div>
  );
}

/** Centered placeholder for not-yet-implemented tabs. */
function Placeholder({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <span className="text-xs font-medium uppercase tracking-wide text-content-subtle">
        {label}
      </span>
      <span className="text-[11px] text-content-subtle">{hint}</span>
    </div>
  );
}
