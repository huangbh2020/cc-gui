import { useEffect, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ClaudePathPanel } from "./ClaudePathPanel.js";
import { CustomModelsPanel } from "./CustomModelsPanel.js";
import { DisplayModePanel } from "./DisplayModePanel.js";
import { ThemePanel } from "./ThemePanel.js";

/**
 * Settings modal with a left functional menu + right content panel layout.
 *
 * Controlled by `settingsOpen` in the session store (opened from the LeftBar ⚙
 * footer, the CLI-missing CTA, or the model-dropdown "manage models" entry).
 *
 * Available sections:
 *  - 通用           (placeholder)
 *  - Claude CLI 路径 (ClaudePathPanel)
 *  - 自定义模型      (CustomModelsPanel)
 *  - 外观           (placeholder)
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
  { id: "custom-models", label: "自定义模型" },
  { id: "appearance", label: "外观" },
  { id: "about", label: "关于" },
];

export function SettingsModal() {
  const open = useSessionStore((s) => s.settingsOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  const [active, setActive] = useState<SectionId>("claude-path");

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setSettingsOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => setSettingsOpen(false)}
    >
      <div
        className="flex h-[520px] max-h-[88vh] w-[760px] max-w-[92vw] flex-col rounded-lg border border-edge bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold text-content">设置</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="rounded px-1.5 text-content-subtle hover:bg-surface-muted hover:text-content-muted"
            title="关闭"
          >
            ✕
          </button>
        </div>

        {/* Body: left nav + right content */}
        <div className="flex min-h-0 flex-1">
          <nav className="w-52 shrink-0 space-y-0.5 border-r border-edge bg-surface/50 px-2 py-3">
            {NAV_ITEMS.map((item) => {
              const isActive = item.id === active;
              return (
                <button
                  key={item.id}
                  onClick={() => setActive(item.id)}
                  className={`relative block w-full rounded px-3 py-2 text-left text-xs transition-colors ${
                    isActive
                      ? "bg-surface-muted font-medium text-content"
                      : "text-content-muted hover:bg-surface-hover hover:text-content"
                  }`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-4 -translate-y-1/2 w-0.5 rounded-full bg-accent" />
                  )}
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {active === "general" && (
              <PlaceholderPanel title="通用" desc="启动项、语言、默认会话等通用配置(开发中)。"/>
            )}
            {active === "claude-path" && <ClaudePathPanel />}
            {active === "custom-models" && <CustomModelsPanel />}
            {active === "appearance" && (
              <div className="space-y-6">
                <ThemePanel />
                <div className="border-t border-edge" />
                <DisplayModePanel />
              </div>
            )}
            {active === "about" && (
              <PlaceholderPanel title="关于" desc="版本信息、开源协议与更新检查(开发中)。"/>
            )}
          </div>
        </div>
      </div>
    </div>
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
