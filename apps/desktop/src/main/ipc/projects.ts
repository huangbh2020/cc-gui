import type { IpcMain } from "electron";
import {
  IPC,
  CreateProjectSchema,
  DeleteProjectSchema,
  ArchiveProjectSchema,
  DeleteSessionSchema,
  ArchiveSessionSchema,
} from "@contracts/ipc";
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
      archived: false,
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

  // Hard-delete a project (cascades to its sessions + messages via DB FKs).
  ipcMain.handle(IPC.PROJECT_DELETE, (_evt, raw) => {
    const input = DeleteProjectSchema.parse(raw);
    ProjectRepo.delete(input.id);
    log.info(`project deleted: ${input.id}`);
  });

  // Set a project's archived flag (soft-delete; restorable).
  ipcMain.handle(IPC.PROJECT_ARCHIVE, (_evt, raw) => {
    const input = ArchiveProjectSchema.parse(raw);
    ProjectRepo.setArchived(input.id, input.archived);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after archive: ${input.id}`);
    log.info(`project ${input.archived ? "archived" : "restored"}: ${input.id}`);
    return { project };
  });

  // Hard-delete a session (cascades to its messages via DB FK).
  ipcMain.handle(IPC.SESSION_DELETE, (_evt, raw) => {
    const input = DeleteSessionSchema.parse(raw);
    SessionRepo.delete(input.id);
    log.info(`session deleted: ${input.id}`);
  });

  // Set a session's archived flag (soft-delete; restorable).
  ipcMain.handle(IPC.SESSION_ARCHIVE, (_evt, raw) => {
    const input = ArchiveSessionSchema.parse(raw);
    SessionRepo.setArchived(input.id, input.archived);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after archive: ${input.id}`);
    log.info(`session ${input.archived ? "archived" : "restored"}: ${input.id}`);
    return { session };
  });
}
