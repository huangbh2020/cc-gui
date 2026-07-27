import { useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/**
 * Runtime application of user-configurable chat appearance settings.
 *
 * The settings (font size + user-message bg color) live in the session
 * store (hydrated from the `settings` SQLite table). This module mirrors
 * them onto <html> as CSS custom properties so they cascade into the chat
 * rendering without per-component plumbing:
 *
 *   --chat-font-size : consumed by `[font-size:var(--chat-font-size)]`
 *                       classes in ChatPane + Markdown.
 *   --user-bubble    : an "R G B" triplet consumed by the `userBubble`
 *                       Tailwind color token (composes `/10` alpha).
 *
 * Static fallbacks for both vars live in styles.css (:root + .dark); when
 * the user has NOT customized a value we REMOVE the inline property so the
 * stylesheet default re-asserts (and correctly differs between light/dark).
 *
 * This is the project's first runtime CSS-variable write; lib/theme.ts's
 * `applyThemeClass` is the closest precedent (DOM mutation on <html>).
 */

/** Write the chat font size as `--chat-font-size` on <html>. */
export function applyChatFontSize(px: number): void {
  document.documentElement.style.setProperty("--chat-font-size", `${px}px`);
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

/**
 * Keep the two appearance CSS vars in sync with the session store. Mount
 * once at the app root (alongside useTheme). Re-runs whenever the store
 * values change (user dragged the slider / picked a color in Settings),
 * re-applying both vars idempotently.
 */
export function useChatAppearance(): void {
  const chatFontSize = useSessionStore((s) => s.chatFontSize);
  const userMessageColor = useSessionStore((s) => s.userMessageColor);

  useEffect(() => {
    applyChatFontSize(chatFontSize);
  }, [chatFontSize]);

  useEffect(() => {
    applyUserBubbleColor(userMessageColor);
  }, [userMessageColor]);
}
