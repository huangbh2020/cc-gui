import { useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/**
 * Runtime application of user-configurable appearance settings.
 *
 * The settings (font size, user-message bg color, global accent color) live
 * in the session store (hydrated from the `settings` SQLite table). This
 * module mirrors them onto <html> as CSS custom properties so they cascade
 * into the rendering without per-component plumbing:
 *
 *   --chat-font-size : consumed by `[font-size:var(--chat-font-size)]`
 *                       classes in ChatPane + Markdown.
 *   --user-bubble    : an "R G B" triplet consumed by the `userBubble`
 *                       Tailwind color token (composes `/10` alpha).
 *   --accent         : an "R G B" triplet consumed by the `accent` Tailwind
 *                       color token — the global emphasis color (buttons,
 *                       links, selected states, focus rings, prompt-card
 *                       accents). Composes `/10`, `/15`, `/60` etc. alpha.
 *
 * Static fallbacks for all three vars live in styles.css (:root + .dark);
 * when the user has NOT customized a value we REMOVE the inline property so
 * the stylesheet default re-asserts (and correctly differs between light/
 * dark — e.g. --accent is emerald-600 in light, emerald-500 in dark).
 *
 * This is the project's first runtime CSS-variable write; lib/theme.ts's
 * `applyThemeClass` is the closest precedent (DOM mutation on <html>).
 */

/** Write the chat font size as `--chat-font-size` on <html>. */
export function applyChatFontSize(px: number): void {
  document.documentElement.style.setProperty("--chat-font-size", `${px}px`);
}

/** Write the right-panel base font size as `--right-panel-font-size` on
 *  <html>. The derived `--rp-fs-sm/xs/xxs` variants (defined in styles.css
 *  via calc) track this automatically. Also mirrored into the xterm
 *  terminal fontSize directly from the store (see TerminalView). */
export function applyRightPanelFontSize(px: number): void {
  document.documentElement.style.setProperty("--right-panel-font-size", `${px}px`);
}

/** Write the user-message bg color (R G B triplet) as `--user-bubble` on
 *  <html>. Pass null to remove the override and fall back to the theme
 *  default defined in styles.css. */
export function applyUserBubbleColor(rgbTriplet: string | null): void {
  if (rgbTriplet) {
    document.documentElement.style.setProperty("--user-bubble", rgbTriplet);
  } else {
    document.documentElement.style.removeProperty("--user-bubble");
  }
}

/** Write the global brand/accent color (R G B triplet) as `--accent` on
 *  <html>. Pass null to remove the override and fall back to the per-theme
 *  default defined in styles.css (emerald-600 light / emerald-500 dark). */
export function applyAccentColor(rgbTriplet: string | null): void {
  if (rgbTriplet) {
    document.documentElement.style.setProperty("--accent", rgbTriplet);
  } else {
    document.documentElement.style.removeProperty("--accent");
  }
}

/**
 * Keep the three appearance CSS vars in sync with the session store. Mount
 * once at the app root (alongside useTheme). Re-runs whenever the store
 * values change (user dragged the slider / picked a color in Settings),
 * re-applying all three vars idempotently.
 */
export function useChatAppearance(): void {
  const chatFontSize = useSessionStore((s) => s.chatFontSize);
  const userMessageColor = useSessionStore((s) => s.userMessageColor);
  const accentColor = useSessionStore((s) => s.accentColor);

  useEffect(() => {
    applyChatFontSize(chatFontSize);
  }, [chatFontSize]);

  useEffect(() => {
    applyUserBubbleColor(userMessageColor);
  }, [userMessageColor]);

  useEffect(() => {
    applyAccentColor(accentColor);
  }, [accentColor]);
}

/**
 * Keep the right-panel font-size CSS var in sync with the session store.
 * Mount once at the app root (alongside useChatAppearance). Re-runs whenever
 * the store value changes (user dragged the slider in Settings), re-applying
 * the var idempotently. The derived --rp-fs-* variants (calc'd in
 * styles.css) track this base automatically.
 *
 * The xterm terminal consumes the store value directly (not the CSS var)
 * since its fontSize is a JS option, not a style - see TerminalView.
 */
export function useRightPanelAppearance(): void {
  const rightPanelFontSize = useSessionStore((s) => s.rightPanelFontSize);

  useEffect(() => {
    applyRightPanelFontSize(rightPanelFontSize);
  }, [rightPanelFontSize]);
}
