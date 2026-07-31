/**
 * IPC handler for opening a path in the OS file manager.
 *
 * Two channels:
 *  - `shell:openPath`           - open a project root folder itself. The path
 *    MUST be an exact match (after normalization) for a known, non-archived
 *    project root.
 *  - `shell:showItemInFolder`   - reveal a file or sub-directory inside a
 *    project root, selecting it in Finder/Explorer. The path MUST resolve
 *    inside (or equal) a known, non-archived project root - the same
 *    containment rule the file handlers use.
 *
 * We never let the renderer open arbitrary locations - only paths under
 * directories the user has explicitly added as projects. A refused or failing
 * call logs and resolves (no throw into the renderer).
 */
import type { IpcMain } from "electron";
import { shell } from "electron";
import { resolve, sep } from "node:path";
import { IPC, OpenPathSchema, ShowItemInFolderSchema } from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** True if `abs` is inside `root` (or equals it), after normalizing both.
 *  Mirrors the containment check in `files.ts` so both surfaces share one
 *  security rule. The separator-aware prefix check prevents "/foo/bar" from
 *  matching root "/foo/ba". */
function pathWithin(root: string, abs: string): boolean {
  const r = resolve(root);
  const a = resolve(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

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

  ipcMain.handle(IPC.SHELL_SHOW_ITEM_IN_FOLDER, async (_evt, raw) => {
    const input = ShowItemInFolderSchema.parse(raw);
    // Accept any path that resolves inside a known, non-archived project root
    // (or equals it). This lets the file-tree context menu reveal individual
    // files/sub-dirs while still refusing anything outside a project.
    const within = ProjectRepo.list()
      .filter((p) => !p.archived)
      .some((p) => pathWithin(p.path, input.path));
    if (!within) {
      log.warn(`shell.showItemInFolder refused (outside project root): ${input.path}`);
      return;
    }
    // showItemInFolder opens the containing folder and selects the item. It
    // has no error return; on failure the OS simply does nothing.
    shell.showItemInFolder(input.path);
  });
}
