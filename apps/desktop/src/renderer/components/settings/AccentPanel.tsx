import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { IconX } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/**
 * Settings panel: global brand/accent color.
 *
 * The accent color is the app's global emphasis color — buttons, links,
 * selected states, focus rings, and the accent highlights on the three
 * prompt cards (QuestionPrompt / ApprovalPrompt / PlanApprovalPrompt) all
 * follow the `accent` Tailwind token, which is backed by the `--accent` CSS
 * variable. This panel lets the user override that variable at runtime.
 *
 * Persisted through the generic `setting.set` pipeline (same path as
 * chatFontSize / userMessageColor) under the `ui.accentColor` key, as an
 * "R G B" triplet so the `accent` token can compose `/10` / `/60` alpha.
 * Applied at runtime by lib/appearance.ts (`applyAccentColor`), which
 * writes `--accent` on <html>; null removes the override so the per-theme
 * stylesheet default re-asserts (emerald-600 light / emerald-500 dark).
 *
 * Single color is shared across light + dark themes (same trade-off as the
 * user-message bg color). The UI offers a curated preset swatch row for
 * one-click picks plus a native color picker for free-form choice.
 */

/** Curated preset swatches. `value` is the "R G B" triplet we persist; the
 *  hex is used for the swatch background. Ordered to cover the spectrum
 *  with colors that keep acceptable contrast in both light and dark. */
const PRESETS: { name: string; triplet: string; hex: string }[] = [
  { name: "翠绿", triplet: "5 150 105", hex: "#059669" }, // emerald-600 (= default)
  { name: "天蓝", triplet: "2 132 199", hex: "#0284c7" }, // sky-600
  { name: "靛蓝", triplet: "67 56 202", hex: "#4338ca" }, // indigo-700
  { name: "青色", triplet: "13 148 136", hex: "#0d9488" }, // teal-600
  { name: "紫罗兰", triplet: "124 58 237", hex: "#7c3aed" }, // violet-600
  { name: "玫瑰红", triplet: "225 29 72", hex: "#e11d48" }, // rose-600
  { name: "琥珀", triplet: "217 119 6", hex: "#d97706" }, // amber-600
  { name: "橙色", triplet: "234 88 12", hex: "#ea580c" }, // orange-600
];

/** Convert "#rrggbb" → "R G B" triplet string for CSS var storage. */
function hexToTriplet(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Convert "R G B" triplet → "#rrggbb" for the color input. Returns null if
 *  the triplet is malformed. */
function tripletToHex(triplet: string | null): string | null {
  if (!triplet) return null;
  const parts = triplet.trim().split(/\s+/).map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return null;
  }
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`;
}

export function AccentPanel() {
  const accentColor = useSessionStore((s) => s.accentColor);
  const setAccentColor = useSessionStore((s) => s.setAccentColor);

  // Local pending hex from the free-form picker, for instant swatch
  // feedback while the IPC write is in flight. Cleared on mount.
  const [pendingHex, setPendingHex] = useState<string | "">("");
  useEffect(() => {
    setPendingHex("");
  }, []);

  const currentHex =
    pendingHex ||
    tripletToHex(accentColor) ||
    tripletToHex(hexToTriplet("#059669"))!; // fallback = emerald default

  const pickPreset = (triplet: string) => {
    setPendingHex("");
    void setAccentColor(triplet);
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-content">品牌色</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-content-subtle">
          自定义应用的全局强调色,影响按钮、链接、选中态、输入框聚焦边框等。点击预设快速切换,或用取色器自由选择。
        </p>
      </div>

      <div className="space-y-3 rounded-md border border-edge bg-surface/40 px-3 py-2.5">
        {/* Preset swatches */}
        <div>
          <div className="mb-2 text-xs font-medium text-content">预设颜色</div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const active = accentColor === p.triplet && !pendingHex;
              return (
                <button
                  key={p.triplet}
                  type="button"
                  onClick={() => pickPreset(p.triplet)}
                  title={`${p.name} · ${p.hex.toUpperCase()}`}
                  aria-label={`选择${p.name}`}
                  aria-pressed={active}
                  className={cn(
                    "relative h-8 w-8 rounded-full border-2 transition-transform hover:scale-110",
                    active
                      ? "border-content ring-2 ring-content/20 ring-offset-2 ring-offset-surface"
                      : "border-edge",
                  )}
                  style={{ backgroundColor: p.hex }}
                />
              );
            })}
          </div>
        </div>

        {/* Free-form picker + reset */}
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-content" htmlFor="accent-color">
            自定义颜色
          </label>
          <button
            type="button"
            onClick={() => {
              setPendingHex("");
              void setAccentColor(null);
            }}
            disabled={!accentColor && !pendingHex}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
              "text-content-subtle hover:bg-surface-hover hover:text-content-muted",
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            )}
            title="恢复为主题默认色(翠绿)"
          >
            <IconX size={10} />
            恢复默认
          </button>
        </div>
        <div className="flex items-center gap-3">
          <input
            id="accent-color"
            type="color"
            value={currentHex}
            onChange={(e) => {
              const hex = e.target.value;
              const triplet = hexToTriplet(hex);
              setPendingHex(hex);
              if (triplet) void setAccentColor(triplet);
            }}
            className="h-8 w-12 cursor-pointer rounded border border-edge bg-transparent p-0.5"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-content-muted">
              {accentColor
                ? `自定义 ${currentHex.toUpperCase()}`
                : "主题默认色(翠绿)"}
            </div>
            <div className="text-[10px] text-content-subtle">
              颜色将实时应用到整个界面,无需重启。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
