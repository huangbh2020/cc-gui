/**
 * PanelHeader — the page-level title block at the top of every settings panel.
 *
 * This is the TOP of the visual hierarchy inside a settings page:
 *   1. PanelHeader  — 页面标题 (text-base, semibold) + 描述
 *   2. SettingsSection — 分类标签 (small, muted) + 卡片
 *   3. SettingRow   — 卡片内的设置行
 *
 * `icon` renders an accent-tinted glyph next to the title; `action` is an
 * optional right-aligned slot (e.g. the shortcuts panel's "恢复全部默认"
 * button).
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";

export function PanelHeader({
  title,
  desc,
  icon: Icon,
  action,
  className,
}: {
  title: string;
  desc?: ReactNode;
  icon?: ComponentType<TablerIconProps>;
  /** Right-aligned action slot (e.g. a "恢复默认" button). */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start justify-between gap-4", className)}>
      <div className="flex min-w-0 items-start gap-2">
        {Icon && <Icon size={18} className="mt-0.5 shrink-0 text-accent" />}
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-snug text-content">
            {title}
          </h2>
          {desc && (
            <p className="mt-1 text-[0.7857em] leading-relaxed text-content-subtle">
              {desc}
            </p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
