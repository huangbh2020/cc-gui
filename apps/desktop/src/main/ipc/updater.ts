/**
 * IPC handlers for auto-update (electron-updater).
 *
 * Thin wrappers over the updater module (src/main/updater.ts). The updater
 * module owns all autoUpdater logic and guards dev/prod; these handlers just
 * expose it to the renderer via the typed RPC contract.
 *
 * No input validation needed - all three RPCs are parameterless.
 */
import type { IpcMain } from "electron";
import { IPC, type CheckForUpdatesResult } from "@contracts/ipc";
import { checkForUpdates, downloadUpdate, quitAndInstall } from "@main/updater.js";

export function registerUpdaterHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.APP_CHECK_FOR_UPDATES, async (): Promise<CheckForUpdatesResult> => {
    return checkForUpdates();
  });

  ipcMain.handle(IPC.APP_DOWNLOAD_UPDATE, async (): Promise<void> => {
    await downloadUpdate();
  });

  ipcMain.handle(IPC.APP_QUIT_AND_INSTALL, async (): Promise<void> => {
    await quitAndInstall();
  });
}
