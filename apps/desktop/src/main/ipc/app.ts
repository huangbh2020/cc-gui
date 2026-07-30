/**
 * IPC handler for app / runtime info (About panel).
 *
 * Surfaces the app version (from `app.getVersion()`, which reads the root
 * package.json in dev and the built app's version in production) plus the
 * bundled Electron / Node / Chromium versions and the OS platform/arch.
 *
 * Parameterless, read-only RPC - no input validation needed.
 */
import type { IpcMain } from "electron";
import { app } from "electron";
import { IPC, type AppInfoResult } from "@contracts/ipc";

export function registerAppHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.APP_INFO, (): AppInfoResult => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? "?",
    node: process.versions.node ?? "?",
    chromium: process.versions.chrome ?? "?",
    platform: process.platform,
    arch: process.arch,
  }));
}
