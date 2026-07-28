import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ThreePaneLayout } from "@renderer/components/layout/ThreePaneLayout.js";
import { ClaudePathPanel } from "./ClaudePathPanel.js";
import { CustomModelsPanel } from "./CustomModelsPanel.js";
import { AppearancePanel } from "./AppearancePanel.js";

/**
 * Settings page with a left functional menu + right content panel layout.
 *
 * Rendered as a sibling view to the workspace (toggled by `settingsOpen` in
 * the session store). Reuses the same ThreePaneLayout shell as the main
 * workspace — the only difference is the right sidebar is collapsed and the
 * left sidebar hosts the settings navigation instead of the project tree.
 *
 * Available sections:
 *  - 通用           (placeholder)
 *  - Claude CLI 路径 (ClaudePathPanel)
 *  - 模型配置        (CustomModelsPanel — two-column: provider list + config form)
 *  - 外观           (AppearancePanel — flat one-row-per-feature list)
 *  - 关于           (placeholder)
 *
 * Panels are conditionally rendered (mount/unmount on nav switch) rather than
 * kept alive — `ClaudePathPanel` is designed to reload its value on mount, so
 * fresh-mount per nav switch is the intended pattern.
 */
type SectionId = "general" | "claude-path" | "custom-models" | "appearance" | "about";

interface NavItem {
  id: SectionId;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "general", label: "通用" },
  { id: "claude-path", label: "Claude CLI 路径" },
  { id: "custom-models", label: "模型配置" },
  { id: "appearance", label: "外观" },
  { id: "about", label: "关于" },
];

export function SettingsPage() {
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const [active, setActive] = useState<SectionId>("claude-path");

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
        <nav className="space-y-0.5 px-2 py-3">
          {NAV_ITEMS.map((item) => {
            const isActive = item.id === active;
            return (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className={cn(
                  "relative block w-full rounded px-3 py-2 text-left text-xs transition-colors",
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
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {active === "general" && (
            <PlaceholderPanel title="通用" desc="启动项、语言、默认会话等通用配置(开发中)。" />
          )}
          {active === "claude-path" && <ClaudePathPanel />}
          {active === "custom-models" && <CustomModelsPanel />}
          {active === "appearance" && <AppearancePanel />}
          {active === "about" && (
            <PlaceholderPanel title="关于" desc="版本信息、开源协议与更新检查(开发中)。" />
          )}
        </div>
      }
      right={null}
      leftOpen
      rightOpen={false}
    />
  );
}

/** Minimal centered empty-state for not-yet-implemented sections. */
function PlaceholderPanel({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-2 text-2xl text-content-subtle">🚧</div>
      <h3 className="text-sm font-medium text-content-muted">{title}</h3>
      <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-content-subtle">{desc}</p>
    </div>
  );
}
