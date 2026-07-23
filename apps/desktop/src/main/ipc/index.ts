import { ipcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { registerProjectHandlers } from "./projects.js";
import { registerClaudeHandlers } from "./claude.js";

/** Register all renderer→main IPC handlers. */
export function registerIpcHandlers(): void {
  registerProjectHandlers(ipcMain);
  registerClaudeHandlers(ipcMain);
}

// Re-export channel constants so handlers stay aligned with the contract.
export { IPC };
