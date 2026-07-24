import type { IpcMain } from "electron";
import { IPC, CreateProjectSchema } from "@contracts/ipc";
import type { Project } from "@contracts/session";
import { uid } from "@main/utils.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
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
    ProjectRepo.create(project);
    log.info(`project created: ${project.name} (${project.path})`);
    return { project };
  });

  ipcMain.handle(IPC.PROJECT_LIST, () => {
    return { projects: ProjectRepo.list() };
  });

  ipcMain.handle(IPC.PROJECT_SESSIONS, (_evt, projectId: string) => {
    return { sessions: SessionRepo.listByProject(projectId) };
  });
}
