import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import type { ThemeName, EffectiveTheme } from "@contracts/theme";

/**
 * Toggle the `.dark` class on <html>, which (with `darkMode: 'class'` in the
 * Tailwind config) is what actually re-themes the UI. Exposed for the inline
 * FOUC script in index.html to call before React mounts.
 */
export function applyThemeClass(effective: EffectiveTheme): void {
  const root = document.documentElement;
  if (effective === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export interface ThemeState {
  /** The user's persisted preference. */
  theme: ThemeName;
  /** What's actually rendering (system resolved). */
  effective: EffectiveTheme;
}

/**
 * Subscribe to the theme: load the current preference on mount, keep the
 * `.dark` class in sync, and re-apply whenever the effective theme changes
 * (user picked a new one in settings, or the OS switched in 'system' mode).
 *
 * Mount once at the app root (App.tsx). Returns the current state so the
 * appearance panel can render its radio selection.
 */
export function useTheme(): ThemeState {
  const [state, setState] = useState<ThemeState>({ theme: "system", effective: "dark" });

  useEffect(() => {
    let cancelled = false;
    // Initial load: ask main for the persisted preference + effective value.
    void api.theme.get().then((s) => {
      if (cancelled) return;
      setState(s);
      applyThemeClass(s.effective);
    });
    // Live updates: main pushes theme.changed when the user picks a new theme
    // OR when the OS theme changes while in 'system' mode.
    const off = api.on.themeChanged((msg) => {
      setState({ theme: msg.theme, effective: msg.effective });
      applyThemeClass(msg.effective);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return state;
}
