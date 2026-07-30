import { ipcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { registerProjectHandlers } from "./projects.js";
import { registerClaudeHandlers } from "./claude.js";
import { registerCustomModelHandlers } from "./customModel.js";
import { registerThemeHandlers } from "./theme.js";
import { registerFileHandlers } from "./files.js";
import { registerGitHandlers } from "./git.js";
import { registerTerminalHandlers } from "./terminal.js";
import { registerAppHandlers } from "./app.js";
import { registerShellHandlers } from "./shell.js";
import { registerUpdaterHandlers } from "./updater.js";

/** Register all renderer->main IPC handlers. */
export function registerIpcHandlers(): void {
  registerProjectHandlers(ipcMain);
  registerClaudeHandlers(ipcMain);
  registerCustomModelHandlers(ipcMain);
  registerThemeHandlers(ipcMain);
  registerFileHandlers(ipcMain);
  registerGitHandlers(ipcMain);
  registerTerminalHandlers(ipcMain);
  registerAppHandlers(ipcMain);
  registerShellHandlers(ipcMain);
  registerUpdaterHandlers(ipcMain);
}

// Re-export channel constants so handlers stay aligned with the contract.
export { IPC };
