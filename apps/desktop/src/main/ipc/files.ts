/**
 * IPC handler for on-demand file reads.
 *
 * The renderer runs under contextIsolation and has no filesystem access of
 * its own. The turn-files diff card needs a file's *current* (post-turn)
 * content to diff against the snapshotted `before` payload — this handler is
 * the only path that fetches it.
 *
 * Security: the path MUST resolve inside a known project root. We don't take
 * a cwd on trust from the renderer; instead we scan all persisted projects
 * and accept the first root that contains the path. A path that escapes every
 * project root (or a read failure / binary file) yields an empty string so
 * the caller degrades gracefully rather than crashing the diff view.
 */
import type { IpcMain } from "electron";
import { readFile } from "node:fs/promises";
import { IPC, FileReadSchema } from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { safeResolveOk } from "@main/lib/fileSnapshot.js";
import { log } from "@main/lib/logger.js";

export function registerFileHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.FILE_READ, async (_evt, raw) => {
    const input = FileReadSchema.parse(raw);
    // Find a project root that contains the requested path. We check every
    // project (cheap — there are rarely more than a handful) rather than
    // trusting a caller-supplied cwd.
    const projects = ProjectRepo.list();
    const root = projects.find((p) => safeResolveOk(p.path, input.filePath));
    if (!root) {
      log.warn(`file.readFile refused — path outside any project root: ${input.filePath}`);
      return { content: "" };
    }
    try {
      const content = await readFile(input.filePath, "utf-8");
      return { content };
    } catch (err) {
      // ENOENT (file gone), EACCES, or binary content that isn't valid utf-8.
      // Return empty so the diff degrades to "whole before deleted" rather
      // than throwing into the renderer.
      log.warn(`file.readFile failed for ${input.filePath}: ${(err as Error).message}`);
      return { content: "" };
    }
  });
}
