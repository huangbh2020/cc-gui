import { useTheme } from "@renderer/lib/theme.js";
import { api } from "@renderer/lib/api.js";
import { IconSun, IconMoon, IconDeviceDesktop } from "@renderer/lib/icons.js";
import type { ThemeName } from "@contracts/theme";
import { RadioCard } from "./RadioCard.js";

/**
 * Settings panel: color-scheme (theme) picker.
 *
 * Three options:
 *   - 浅色 (light)  — always light
 *   - 深色 (dark)   — always dark
 *   - 跟随系统 (system) — follow the OS preference; flips automatically
 *
 * Selection is persisted via `api.theme.set`, which forwards to
 * nativeTheme.themeSource on the main side. The renderer's `useTheme`
 * subscription (mounted at App root) re-applies the `.dark` class the moment
 * the `theme:changed` push arrives, so the whole UI re-themes instantly —
 * including this very panel.
 *
 * For `system`, we also show the currently-resolved effective theme ("当前:
 * 浅色/深色") so the user can tell what's actually rendering.
 */
export function ThemePanel() {
  const { theme, effective } = useTheme();

  const pick = (next: ThemeName) => {
    // Optimistic: useTheme's subscription will update `theme` when the
    // theme:changed push arrives (~instant). No local pending state needed.
    void api.theme.set({ theme: next });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-content">界面主题</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-content-subtle">
          选择应用的外观配色。选择"跟随系统"时会随操作系统的设置自动切换。
        </p>
      </div>

      <div className="space-y-2">
        <RadioCard
          checked={theme === "light"}
          title="浅色"
          desc="始终使用浅色配色。"
          icon={<IconSun size={14} />}
          onSelect={() => pick("light")}
        />
        <RadioCard
          checked={theme === "dark"}
          title="深色"
          desc="始终使用深色配色。"
          icon={<IconMoon size={14} />}
          onSelect={() => pick("dark")}
        />
        <RadioCard
          checked={theme === "system"}
          title="跟随系统"
          desc={`随操作系统的深浅色设置自动切换。当前: ${effective === "dark" ? "深色" : "浅色"}。`}
          icon={<IconDeviceDesktop size={14} />}
          onSelect={() => pick("system")}
        />
      </div>
    </div>
  );
}
