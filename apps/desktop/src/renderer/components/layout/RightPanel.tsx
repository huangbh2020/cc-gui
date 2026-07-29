import { type ComponentType } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconGitBranch,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import type { RightPanelTab } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";

/** Right panel: tabbed inspector for files / git.
 *
 *  Both tabs are implemented. The active tab is read from / written to the
 *  session store (persisted in the settings table), so it survives restarts.
 *
 *  (Terminal used to be a tab here but moved to the bottom bar — see
 *  BottomTerminalBar — because the fixed 360px sidebar was too narrow for a
 *  usable terminal. Browser was a P5 placeholder that has since been removed.) */
type TabDef = {
  id: RightPanelTab;
  label: string;
  icon: ComponentType<TablerIconProps>;
};

const TABS: TabDef[] = [
  { id: "files", label: "Files", icon: IconFolder },
  { id: "git", label: "Git", icon: IconGitBranch },
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

      {/* Body — must NOT scroll itself (children own height / overflow). */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "files" && <FilesPanel />}
        {tab === "git" && <GitPanel />}
      </div>
    </div>
  );
}
