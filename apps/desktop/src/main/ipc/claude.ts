import type { IpcMain } from "electron";
import { dialog } from "electron";
import { IPC, StartSessionSchema, SendTurnSchema, InterruptSchema, ApproveSchema } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import { uid } from "@main/utils.js";
import { sessions, projectForSession } from "@main/store/memoryStore.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { resolveClaude } from "@main/claude/ClaudePathResolver.js";
import { log } from "@main/lib/logger.js";

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  // ── folder picker: lets the renderer ask for a project directory ──
  ipcMain.handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });

  // ── health check: is claude installed and resolvable? ──
  ipcMain.handle("claude:healthCheck", () => {
    const spec = resolveClaude();
    return { installed: !!spec, source: spec?.source ?? null, command: spec?.command ?? null };
  });

  ipcMain.handle(IPC.CLAUDE_START_SESSION, (_evt, raw) => {
    const input = StartSessionSchema.parse(raw);
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId: input.projectId,
      claudeSessionId: null, // P2: captured from system/init for --resume
      title: input.title ?? "New session",
      status: "idle",
      model: input.model ?? "default",
      permissionMode: input.permissionMode,
      createdAt: now,
      updatedAt: now,
    };
    sessions.set(session.id, session);
    runtimeManager.bindSession(session);
    log.info(`session started: ${session.id} (project ${input.projectId})`);
    return { session };
  });

  ipcMain.handle(IPC.CLAUDE_SEND_TURN, async (_evt, raw) => {
    const input = SendTurnSchema.parse(raw);
    const session = sessions.get(input.sessionId);
    if (!session) throw new Error(`session not found: ${input.sessionId}`);
    const project = projectForSession(input.sessionId);
    if (!project) throw new Error(`project not found for session ${input.sessionId}`);

    session.status = "running";
    sessions.set(session.id, session);
    await runtimeManager.sendTurn(session, { prompt: input.prompt, cwd: project.path });
  });

  ipcMain.handle(IPC.CLAUDE_INTERRUPT, async (_evt, raw) => {
    const input = InterruptSchema.parse(raw);
    runtimeManager.interrupt(input.sessionId);
    const session = sessions.get(input.sessionId);
    if (session) {
      session.status = "interrupted";
      sessions.set(session.id, session);
    }
  });

  ipcMain.handle(IPC.CLAUDE_APPROVE, async (_evt, raw) => {
    ApproveSchema.parse(raw);
    // P3: write permission_response to the child's stdin. P1 runs with no
    // approval flow (claude's default tools execute automatically).
  });
}
