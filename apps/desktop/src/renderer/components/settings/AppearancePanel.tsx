import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useTheme } from "@renderer/lib/theme.js";
import { api } from "@renderer/lib/api.js";
import { hexToTriplet, tripletToHex } from "@renderer/lib/colorUtils.js";
import { useSessionStore, CHAT_FONT_SIZE_MIN, CHAT_FONT_SIZE_MAX } from "@renderer/stores/sessionStore.js";
import { Button, Select } from "@renderer/components/ui/index.js";
import { IconRefresh } from "@renderer/lib/icons.js";
import type { ThemeName } from "@contracts/theme";
import { DISPLAY_MODE_SETTING_KEY, type DisplayMode } from "@contracts/ipc";
import { SettingRow } from "./SettingRow.js";

/**
 * Appearance settings — a flat, one-row-per-feature list.
 *
 * Consolidates what used to be four separate stacked panels (ThemePanel,
 * DisplayModePanel, ChatAppearancePanel, AccentPanel) into a single compact
 * view: left column = feature description, right column = a small control
 * (dropdown / color swatch / slider). Each setting's persistence path is
 * unchanged from before — only the presentation is reworked.
 *
 * Persistence summary (all unchanged):
 *  - theme           → api.theme.set → nativeTheme.themeSource on main
 *  - displayMode     → setting.set(DISPLAY_MODE_SETTING_KEY, …)
 *  - chatFontSize    → setting.set(ui.chatFontSize, …)
 *  - userMessageColor→ setting.set(ui.userMessageColor, …)   "R G B" | null
 *  - accentColor     → setting.set(ui.accentColor, …)        "R G B" | null
 */

/** Default font size shown when no override is set (matches styles.css). */
const DEFAULT_FONT_SIZE = 14;

/** Hex of the default accent color (emerald-600). Used as the picker fallback. */
const DEFAULT_ACCENT_HEX = "#059669";

/** Hex of the default user-message bg color (violet-600). Picker fallback. */
const DEFAULT_USER_BUBBLE_HEX = "#7c3aed";

/** Curated accent presets. `triplet` is what we persist; `hex` drives the swatch.
 *  Ordered across the spectrum; all keep acceptable contrast in light + dark. */
const ACCENT_PRESETS: { name: string; triplet: string; hex: string }[] = [
  { name: "翠绿", triplet: "5 150 105", hex: "#059669" }, // emerald-600 (= default)
  { name: "天蓝", triplet: "2 132 199", hex: "#0284c7" }, // sky-600
  { name: "靛蓝", triplet: "67 56 202", hex: "#4338ca" }, // indigo-700
  { name: "青色", triplet: "13 148 136", hex: "#0d9488" }, // teal-600
  { name: "紫罗兰", triplet: "124 58 237", hex: "#7c3aed" }, // violet-600
  { name: "玫瑰红", triplet: "225 29 72", hex: "#e11d48" }, // rose-600
  { name: "琥珀", triplet: "217 119 6", hex: "#d97706" }, // amber-600
  { name: "橙色", triplet: "234 88 12", hex: "#ea580c" }, // orange-600
];

const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const DISPLAY_MODE_OPTIONS: { value: DisplayMode; label: string }[] = [
  { value: "single", label: "单会话模式" },
  { value: "tabs", label: "Tab 标签模式" },
];

export function AppearancePanel() {
  const { theme, effective } = useTheme();

  // ── Display mode ──
  const displayMode = useSessionStore((s) => s.displayMode);
  const setDisplayMode = useSessionStore((s) => s.setDisplayMode);

  // ── Chat font size ──
  const chatFontSize = useSessionStore((s) => s.chatFontSize);
  const setChatFontSize = useSessionStore((s) => s.setChatFontSize);

  // ── User message bg color ──
  const userMessageColor = useSessionStore((s) => s.userMessageColor);
  const setUserMessageColor = useSessionStore((s) => s.setUserMessageColor);

  // ── Accent color ──
  const accentColor = useSessionStore((s) => s.accentColor);
  const setAccentColor = useSessionStore((s) => s.setAccentColor);

  // Local pending hex strings for snappy color-picker feedback while the IPC
  // write is in flight. The store value is the source of truth; pending just
  // makes the swatch/picker flip instantly. Reset on each fresh mount.
  const [pendingUserHex, setPendingUserHex] = useState<string>("");
  const [pendingAccentHex, setPendingAccentHex] = useState<string>("");
  useEffect(() => {
    setPendingUserHex("");
    setPendingAccentHex("");
  }, []);

  const userColorHex =
    pendingUserHex ||
    tripletToHex(userMessageColor) ||
    DEFAULT_USER_BUBBLE_HEX;
  const accentHex =
    pendingAccentHex ||
    tripletToHex(accentColor) ||
    DEFAULT_ACCENT_HEX;

  const effectiveLabel = effective === "dark" ? "深色" : "浅色";

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-content">外观</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-content-subtle">
          调整界面主题、聊天样式与全局强调色,所有改动实时生效。
        </p>
      </div>

      {/* Rows share a `divide-y` so each SettingRow is separated by a hairline
          without each row having to know about borders. */}
      <div className="divide-y divide-edge">
        {/* ── Theme ── */}
        <SettingRow
          title="界面主题"
          desc={
            <>
              选择应用的外观配色;选&quot;跟随系统&quot;会随操作系统自动切换。
              {theme === "system" && (
                <span className="text-content-muted"> 当前:{effectiveLabel}。</span>
              )}
            </>
          }
          htmlFor="setting-theme"
        >
          <Select.Root
            value={theme}
            onValueChange={(v) => void api.theme.set({ theme: v as ThemeName })}
          >
            <Select.Trigger id="setting-theme" className="min-w-[8rem]">
              <Select.Value>
                {(val: ThemeName) =>
                  THEME_OPTIONS.find((o) => o.value === val)?.label ?? "浅色"
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {THEME_OPTIONS.map((o) => (
                      <Select.Item key={o.value} value={o.value}>
                        <Select.ItemText>{o.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {/* ── Display mode ── */}
        <SettingRow
          title="中间面板显示模式"
          desc="点击左侧线程时,中间聊天区的呈现方式。"
          htmlFor="setting-displaymode"
        >
          <Select.Root
            value={displayMode}
            onValueChange={(v) => void setDisplayMode(v as DisplayMode)}
          >
            <Select.Trigger id="setting-displaymode" className="min-w-[10rem]">
              <Select.Value>
                {(val: DisplayMode) =>
                  DISPLAY_MODE_OPTIONS.find((o) => o.value === val)?.label ??
                  "单会话模式"
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {DISPLAY_MODE_OPTIONS.map((o) => (
                      <Select.Item key={o.value} value={o.value}>
                        <Select.ItemText>{o.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {/* ── Chat font size ── */}
        <SettingRow
          title="聊天字体大小"
          desc={`自定义聊天内容的字体大小(${CHAT_FONT_SIZE_MIN}–${CHAT_FONT_SIZE_MAX} px)。`}
          htmlFor="setting-fontsize"
        >
          <input
            id="setting-fontsize"
            type="range"
            min={CHAT_FONT_SIZE_MIN}
            max={CHAT_FONT_SIZE_MAX}
            step={1}
            value={chatFontSize}
            onChange={(e) => void setChatFontSize(Number(e.target.value))}
            className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-surface-hover accent-accent"
          />
          <span className="w-10 text-right text-[11px] tabular-nums text-content-muted">
            {chatFontSize}px
          </span>
        </SettingRow>

        {/* ── User message background color ── */}
        <SettingRow
          title="用户消息背景色"
          desc={
            userMessageColor
              ? `自定义 ${userColorHex.toUpperCase()}`
              : "主题默认色"
          }
          htmlFor="setting-usercolor"
        >
          <input
            id="setting-usercolor"
            type="color"
            value={userColorHex}
            onChange={(e) => {
              const hex = e.target.value;
              const triplet = hexToTriplet(hex);
              setPendingUserHex(hex);
              if (triplet) void setUserMessageColor(triplet);
            }}
            className="h-7 w-10 cursor-pointer rounded border border-edge bg-transparent p-0.5"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPendingUserHex("");
              void setUserMessageColor(null);
            }}
            disabled={!userMessageColor && !pendingUserHex}
            title="恢复为主题默认色"
            className="gap-1 px-1.5"
          >
            <IconRefresh size={11} />
            恢复默认
          </Button>
        </SettingRow>

        {/* ── Accent color ── */}
        <SettingRow
          title="品牌强调色"
          desc={
            accentColor
              ? `自定义 ${accentHex.toUpperCase()}`
              : "主题默认色(翠绿)"
          }
          descExtra={
            <span className="text-[10px] text-content-subtle">
              影响按钮、链接、选中态、输入框聚焦边框等。
            </span>
          }
          controlAlign="start"
        >
          {/* Preset swatches */}
          <div className="flex flex-wrap gap-1.5">
            {ACCENT_PRESETS.map((p) => {
              const active = accentColor === p.triplet && !pendingAccentHex;
              return (
                <button
                  key={p.triplet}
                  type="button"
                  onClick={() => {
                    setPendingAccentHex("");
                    void setAccentColor(p.triplet);
                  }}
                  title={`${p.name} · ${p.hex.toUpperCase()}`}
                  aria-label={`选择${p.name}`}
                  aria-pressed={active}
                  className={cn(
                    "h-6 w-6 rounded-full border-2 transition-transform hover:scale-110",
                    active
                      ? "border-content ring-2 ring-content/20 ring-offset-1 ring-offset-surface"
                      : "border-edge",
                  )}
                  style={{ backgroundColor: p.hex }}
                />
              );
            })}
          </div>
          <input
            id="setting-accent"
            type="color"
            value={accentHex}
            onChange={(e) => {
              const hex = e.target.value;
              const triplet = hexToTriplet(hex);
              setPendingAccentHex(hex);
              if (triplet) void setAccentColor(triplet);
            }}
            className="h-7 w-10 cursor-pointer rounded border border-edge bg-transparent p-0.5"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPendingAccentHex("");
              void setAccentColor(null);
            }}
            disabled={!accentColor && !pendingAccentHex}
            title="恢复为主题默认色(翠绿)"
            className="gap-1 px-1.5"
          >
            <IconRefresh size={11} />
            恢复默认
          </Button>
        </SettingRow>
      </div>

      {/* Tiny footer note — the divide-y wrapper above intentionally doesn't
          include this so the last accent row is the final separated row. */}
      <p className="pt-1 text-[10px] text-content-subtle">
        提示:主题切换整窗即时生效;颜色透明度按各场景预设固定,无需手动调节。
      </p>
    </section>
  );
}
