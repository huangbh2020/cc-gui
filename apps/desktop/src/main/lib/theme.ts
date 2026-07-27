/**
 * Color-scheme (theme) controller — wraps Electron's nativeTheme so the rest
 * of the main process doesn't touch nativeTheme directly.
 *
 * The user picks a preference (`dark` | `light` | `system`) in Settings; we
 * persist it and forward it to `nativeTheme.themeSource`. Setting themeSource
 * flips Chromium's `prefers-color-scheme` media query, which (combined with
 * `darkMode: 'class'` + the `<html>.dark` toggle in renderer/lib/theme.ts)
 * re-themes the whole UI instantly.
 *
 * For `system`, nativeTheme follows the OS and fires `'updated'` when it
 * changes — we re-broadcast that to the renderer so the appearance panel can
 * show "currently: dark/light" and so any native window background stays in
 * sync. No polling required.
 */
import { nativeTheme } from "electron";
import type { ThemeName, EffectiveTheme } from "@contracts/theme";
import { THEME_SETTING_KEY } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { sendToRenderer, updateTitleBarOverlay } from "@main/window.js";
import { IPC } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";

let initialized = false;

function isDark(): boolean {
  return nativeTheme.shouldUseDarkColors;
}

function effective(): EffectiveTheme {
  return isDark() ? "dark" : "light";
}

function broadcast(): void {
  const theme = getThemePreference();
  sendToRenderer(IPC.THEME_CHANGED, {
    channel: IPC.THEME_CHANGED,
    theme,
    effective: effective(),
  });
}

/** Read the persisted theme preference (defaults to "system" if unset). */
export function getThemePreference(): ThemeName {
  const raw = SettingRepo.get(THEME_SETTING_KEY);
  if (raw === "dark" || raw === "light" || raw === "system") return raw;
  return "system";
}

/** Current resolved theme (what's actually rendering). */
export function getEffectiveTheme(): EffectiveTheme {
  return effective();
}

/**
 * Apply a theme preference: persist it and tell nativeTheme. nativeTheme then
 * drives Chromium's prefers-color-scheme; the renderer applies the .dark class
 * via its own useTheme subscription (or the theme.changed push).
 */
export function applyTheme(theme: ThemeName): { theme: ThemeName; effective: EffectiveTheme } {
  SettingRepo.set(THEME_SETTING_KEY, theme);
  nativeTheme.themeSource = theme;
  log.info(`theme applied: ${theme} (effective ${effective()})`);
  return { theme, effective: effective() };
}

/**
 * Initialize on app startup: load the persisted preference, apply it, and
 * wire up the nativeTheme 'updated' listener so OS-side changes (in `system`
 * mode) propagate to the renderer. Idempotent.
 *
 * Must run after initDb() (reads settings) and after the window exists
 * (broadcast targets it).
 */
export function initTheme(): void {
  if (initialized) return;
  initialized = true;
  const pref = getThemePreference();
  nativeTheme.themeSource = pref;
  log.info(`theme initialized: ${pref} (effective ${effective()})`);

  // OS theme changed (only meaningful in 'system' mode, but the event fires
  // regardless — cheap to re-broadcast). Also fires when WE set themeSource.
  nativeTheme.on("updated", () => {
    broadcast();
    updateTitleBarOverlay();
  });
}
