import type { IpcMain } from "electron";
import { IPC, CreateProjectSchema } from "@contracts/ipc";
import type { Project } from "@contracts/session";
import { uid } from "@main/utils.js";
import { projects, sessions } from "@main/store/memoryStore.js";
import { log } from "@main/lib/logger.js";

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
    log.info(`project created: ${project.name} (${project.path})`);
    return { project };
  });

  ipcMain.handle(IPC.PROJECT_LIST, () => {
    return { projects: [...projects.values()] };
  });

  ipcMain.handle(IPC.PROJECT_SESSIONS, (_evt, projectId: string) => {
    const list = [...sessions.values()].filter((s) => s.projectId === projectId);
    return { sessions: list };
  });
}
