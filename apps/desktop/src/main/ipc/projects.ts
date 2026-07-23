import type { IpcMain } from "electron";
import { IPC, CreateProjectSchema } from "@contracts/ipc";
import type { Project } from "@contracts/session";
import { uid } from "@main/utils.js";

// In-memory store for P0. P2 swaps this for SQLite persistence.
const projects = new Map<string, Project>();

export function registerProjectHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.PROJECT_CREATE, (_evt, raw) => {
    const input = CreateProjectSchema.parse(raw);
    const now = Date.now();
    const project: Project = {
      id: uid("proj_"),
      name: input.name,
      path: input.path,
      createdAt: now,
      updatedAt: now,
    };
    projects.set(project.id, project);
    return { project };
  });

  ipcMain.handle(IPC.PROJECT_LIST, () => {
    return { projects: [...projects.values()] };
  });

  ipcMain.handle(IPC.PROJECT_SESSIONS, (_evt, _projectId: string) => {
    // P2 will load real sessions from SQLite.
    return { sessions: [] };
  });
}
