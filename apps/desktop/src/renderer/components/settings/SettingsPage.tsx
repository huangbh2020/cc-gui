import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ThreePaneLayout } from "@renderer/components/layout/ThreePaneLayout.js";
import { CustomModelsPanel } from "./CustomModelsPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { AppearancePanel } from "./AppearancePanel.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { GitPanel } from "./GitPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { AboutPanel } from "./AboutPanel.js";

/**
 * Settings page with a left functional menu + right content panel layout.
 *
 * Rendered as a sibling view to the workspace (toggled by `settingsOpen` in
 * the session store). Reuses the same ThreePaneLayout shell as the main
 * workspace - the only difference is the right sidebar is collapsed and the
 * left sidebar hosts the settings navigation instead of the project tree.
 *
 * Available sections:
 *  - 模型配置 (CustomModelsPanel - two-column: provider list + config form)
 *  - Skills  (SkillsPanel - two-column: skill list + raw SKILL.md editor)
 *  - 外观    (AppearancePanel - flat one-row-per-feature list)
 *  - Git     (GitPanel)
 *  - 终端    (TerminalPanel - shell override + per-project commands)
 *  - 关于    (AboutPanel - version / license / repo links)
 *
 * (“通用” section temporarily hidden - not yet implemented.)
 *
 * Note: the legacy “Claude CLI 路径” panel was removed - the Agent SDK bundles
 * its own claude binary, so an externally-configured path is no longer used.
 */
type SectionId = "general" | "custom-models" | "skills" | "appearance" | "shortcuts" | "git" | "terminal" | "about";

interface NavItem {
  id: SectionId;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  // { id: "general", label: "通用" }, // 暂时屏蔽:通用设置尚未实现,日后恢复
  { id: "custom-models", label: "模型配置" },
  { id: "skills", label: "Skills" },
  { id: "appearance", label: "外观" },
  { id: "shortcuts", label: "快捷键" },
  { id: "git", label: "Git" },
  { id: "terminal", label: "终端" },
  { id: "about", label: "关于" },
];

export function SettingsPage() {
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Read the same persisted leftWidth the workspace sidebar + titlebar left
  // strip use, so the settings nav sidebar stays exactly aligned with the
  // titlebar's sidebar strip above (whose width also comes from this store
  // value). Without this the settings sidebar was a hardcoded 280px while the
  // titlebar strip tracked the user's dragged width - they'd drift apart.
  const leftWidth = useSessionStore((s) => s.leftWidth);
  const [active, setActive] = useState<SectionId>("custom-models");

  // Esc returns to the workspace (preserves the modal's keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen]);

  return (
    <ThreePaneLayout
      left={
        <nav
          className="space-y-0.5 px-2 py-3"
          style={{ fontSize: "var(--right-panel-font-size)" }}
        >
          {NAV_ITEMS.map((item) => {
            const isActive = item.id === active;
            return (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className={cn(
                  "relative block w-full rounded px-3 py-2 text-left transition-colors",
                  isActive
                    ? "bg-surface-hover font-medium text-content"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                )}
              >
                {isActive && (
                  <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                )}
                {item.label}
              </button>
            );
          })}
        </nav>
      }
      center={
        <div
          // `h-full` (not flex-1) is required here: the parent in
          // ThreePaneLayout is a non-flex `overflow-hidden` box, so `flex-1`
          // was inert and this wrapper fell back to content height. That broke
          // the height chain — child panels using `h-full` couldn't resolve,
          // their internal `overflow-y-auto` regions never scrolled, and tall
          // content (e.g. a long skill list) pushed the bottom "新建" button
          // off-screen (clipped by the outer overflow-hidden). h-full makes this
          // wrapper a definite height so child panels fill it and scroll
          // internally; overflow-y-auto still lets non-internal-scroll panels
          // (Git/Terminal/About) scroll when their content is tall.
          className="min-h-0 h-full overflow-y-auto px-6 py-5"
          style={{ fontSize: "var(--right-panel-font-size)" }}
        >
          {active === "custom-models" && <CustomModelsPanel />}
          {active === "skills" && <SkillsPanel />}
          {active === "appearance" && <AppearancePanel />}
          {active === "shortcuts" && <ShortcutsPanel />}
          {active === "git" && <GitPanel />}
          {active === "terminal" && <TerminalPanel />}
          {active === "about" && <AboutPanel />}
        </div>
      }
      right={null}
      leftOpen
      rightOpen={false}
      leftWidth={leftWidth}
    />
  );
}
