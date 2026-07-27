/**
 * IPC handlers for theme / color-scheme.
 * - get : return the persisted preference + currently-effective theme
 * - set : persist + apply (drives nativeTheme → Chromium prefers-color-scheme)
 */
import type { IpcMain } from "electron";
import { IPC, SetThemeSchema } from "@contracts/ipc";
import { applyTheme, getThemePreference, getEffectiveTheme } from "@main/lib/theme.js";

export function registerThemeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.THEME_GET, () => ({
    theme: getThemePreference(),
    effective: getEffectiveTheme(),
  }));

  ipcMain.handle(IPC.THEME_SET, (_evt, raw) => {
    const input = SetThemeSchema.parse(raw);
    return applyTheme(input.theme);
  });
}
