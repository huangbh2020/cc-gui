/**
 * IPC handlers for native OS dialogs.
 *
 * Two channels:
 *  - `dialog:pickFiles`   - multi-file picker. Intentionally NOT scoped to a
 *    project root: this is the escape hatch that lets the composer "添加上下文"
 *    button attach files that live outside the active project. Returns the
 *    selected absolute paths (empty array on cancel).
 *  - `dialog:pickFolder`  - single-directory picker used to add a new project
 *    root. Uses a raw string channel (kept for back-compat with the existing
 *    preload/sessionStore callers) rather than a typed `RpcMap` entry.
 *
 * Both handlers are thin wrappers over Electron's `dialog.showOpenDialog`.
 * The selection happens in the OS-native modal, so no path-traversal guard
 * is needed here — the user explicitly picks what they want attached.
 */
import type { IpcMain } from "electron";
import { dialog } from "electron";
import { IPC, DialogPickFilesSchema } from "@contracts/ipc";

export function registerDialogHandlers(ipcMain: IpcMain): void {
  // ── multi-file picker (project-external files allowed) ──
  ipcMain.handle(IPC.DIALOG_PICK_FILES, async (_evt, raw) => {
    const input = DialogPickFilesSchema.parse(raw);
    const result = await dialog.showOpenDialog({
      title: input.title ?? "选择文件",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) return { paths: [] };
    return { paths: result.filePaths };
  });

  // ── folder picker: lets the renderer ask for a project directory ──
  // Raw string channel (pre-typed-contract era); kept as-is for back-compat.
  ipcMain.handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });
}
