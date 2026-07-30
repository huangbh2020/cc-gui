/**
 * IPC handler for opening a path in the OS file manager.
 *
 * Single channel `shell:openPath`. The security rule mirrors the file
 * handlers: the supplied path MUST be an exact match (after normalization) for
 * a known, non-archived project root. We never let the renderer open arbitrary
 * locations - only directories the user has explicitly added as projects. A
 * refused or failing call logs and resolves (no throw into the renderer).
 */
import type { IpcMain } from "electron";
import { shell } from "electron";
import { resolve } from "node:path";
import { IPC, OpenPathSchema } from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

export function registerShellHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_evt, raw) => {
    const input = OpenPathSchema.parse(raw);
    // Only allow opening a directory that is an exact match for a known
    // project root. Normalized comparison handles trailing-separator / case
    // differences between the folder picker and the persisted Project.path.
    const known = ProjectRepo.list()
      .filter((p) => !p.archived)
      .some((p) => resolve(p.path) === resolve(input.path));
    if (!known) {
      log.warn(`shell.openPath refused (not a project root): ${input.path}`);
      return;
    }
    // openPath returns an error string on failure ("" on success).
    const err = await shell.openPath(input.path);
    if (err) {
      log.warn(`shell.openPath failed for "${input.path}": ${err}`);
    }
  });
}
