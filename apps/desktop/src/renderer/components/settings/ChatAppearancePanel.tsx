import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { IconX } from "@renderer/lib/icons.js";
import {
  useSessionStore,
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
} from "@renderer/stores/sessionStore.js";

/**
 * Settings panel: user-configurable chat appearance.
 *
 * Two controls, both persisted through the generic `setting.set` pipeline
 * (same path as displayMode) and applied at runtime by lib/appearance.ts as
 * CSS variables on <html>:
 *  - Chat content font size: a range slider (12–20 px).
 *  - User-message background color: an HTML color picker. The picker yields
 *    `#rrggbb`; we convert to an "R G B" triplet for storage (so the
 *    `userBubble` Tailwind token can compose `/10` alpha). Null = theme
 *    default (the --user-bubble var defined in styles.css).
 *
 * Both controls update optimistically (local pending state) so the slider /
 * swatch feel responsive while the DB write is in flight.
 */

/** Default font size shown when no override is set (matches styles.css). */
const DEFAULT_FONT_SIZE = 14;

/** Convert "#rrggbb" → "R G B" triplet string for CSS var storage. */
function hexToTriplet(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Convert "R G B" triplet → "#rrggbb" for the color input. Returns null if
 *  the triplet is malformed (caller falls back to a default swatch). */
function tripletToHex(triplet: string | null): string | null {
  if (!triplet) return null;
  const parts = triplet.trim().split(/\s+/).map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return null;
  }
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`;
}

export function ChatAppearancePanel() {
  const chatFontSize = useSessionStore((s) => s.chatFontSize);
  const setChatFontSize = useSessionStore((s) => s.setChatFontSize);
  const userMessageColor = useSessionStore((s) => s.userMessageColor);
  const setUserMessageColor = useSessionStore((s) => s.setUserMessageColor);

  // Local pending state for snappy UI feedback while the IPC write is in
  // flight. The store value is the source of truth; pending just lets the
  // control flip instantly. Reset on each fresh mount (SettingsModal
  // unmounts panels on nav switch).
  const [pendingFont, setPendingFont] = useState<number | null>(null);
  const [pendingColor, setPendingColor] = useState<string | "">("");
  useEffect(() => {
    setPendingFont(null);
    setPendingColor("");
  }, []);

  const currentFont = pendingFont ?? chatFontSize;
  // The color input is driven by pending (transient hex from the picker) if
  // set, else the stored triplet converted back to hex, else a neutral
  // default swatch (violet = the theme default).
  const currentColorHex =
    pendingColor ||
    tripletToHex(userMessageColor) ||
    tripletToHex(hexToTriplet("#7c3aed"))!; // fallback = info/default

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-content">聊天外观</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-content-subtle">
          自定义聊天内容的字体大小,以及用户输入消息的背景颜色。
        </p>
      </div>

      {/* ── Font size ── */}
      <div className="space-y-2 rounded-md border border-edge bg-surface/40 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-content" htmlFor="chat-font-size">
            字体大小
          </label>
          <span className="tabular-nums text-[11px] text-content-muted">{currentFont}px</span>
        </div>
        <input
          id="chat-font-size"
          type="range"
          min={CHAT_FONT_SIZE_MIN}
          max={CHAT_FONT_SIZE_MAX}
          step={1}
          value={currentFont}
          onChange={(e) => {
            const px = Number(e.target.value);
            // Optimistic local update for instant feedback.
            setPendingFont(px);
            void setChatFontSize(px);
          }}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-hover accent-accent"
        />
        <div className="flex justify-between text-[10px] text-content-subtle">
          <span>{CHAT_FONT_SIZE_MIN}px</span>
          <span>默认 {DEFAULT_FONT_SIZE}px</span>
          <span>{CHAT_FONT_SIZE_MAX}px</span>
        </div>
        {/* Live preview of the chosen size on a sample line. */}
        <div
          className="mt-1 rounded bg-surface-muted/60 px-2 py-1.5 text-content"
          style={{ fontSize: `${currentFont}px` }}
        >
          预览:这是一条示例消息内容。
        </div>
      </div>

      {/* ── User message background color ── */}
      <div className="space-y-2 rounded-md border border-edge bg-surface/40 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-content" htmlFor="user-msg-color">
            用户消息背景色
          </label>
          {/* Reset to theme default. Disabled when no custom color is set. */}
          <button
            type="button"
            onClick={() => {
              setPendingColor("");
              void setUserMessageColor(null);
            }}
            disabled={!userMessageColor && !pendingColor}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
              "text-content-subtle hover:bg-surface-hover hover:text-content-muted",
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            )}
            title="恢复为主题默认色"
          >
            <IconX size={10} />
            恢复默认
          </button>
        </div>
        <div className="flex items-center gap-3">
          {/* Native color picker — outputs #rrggbb. Sized as a swatch. */}
          <input
            id="user-msg-color"
            type="color"
            value={currentColorHex}
            onChange={(e) => {
              const hex = e.target.value;
              const triplet = hexToTriplet(hex);
              setPendingColor(hex);
              if (triplet) void setUserMessageColor(triplet);
            }}
            className="h-8 w-12 cursor-pointer rounded border border-edge bg-transparent p-0.5"
          />
          <div className="min-w-0 flex-1">
            {/* Show the effective value: custom hex or "theme default". */}
            <div className="text-[11px] text-content-muted">
              {userMessageColor
                ? `自定义 ${currentColorHex.toUpperCase()}`
                : "主题默认色"}
            </div>
            <div className="text-[10px] text-content-subtle">
              背景透明度固定为 10%,颜色仅影响用户输入的消息气泡。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
