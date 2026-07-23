import type { IpcMain } from "electron";
import { IPC, StartSessionSchema, SendTurnSchema, InterruptSchema, ApproveSchema } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import { uid } from "@main/utils.js";

// In-memory session store for P0. P1 wires these to a real ClaudeRuntime.
const sessions = new Map<string, Session>();

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CLAUDE_START_SESSION, (_evt, raw) => {
    const input = StartSessionSchema.parse(raw);
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId: input.projectId,
      claudeSessionId: null, // filled on first turn, for --resume
      title: input.title ?? "New session",
      status: "idle",
      model: input.model ?? "default",
      permissionMode: input.permissionMode,
      createdAt: now,
      updatedAt: now,
    };
    sessions.set(session.id, session);
    return { session };
  });

  ipcMain.handle(IPC.CLAUDE_SEND_TURN, async (_evt, raw) => {
    const input = SendTurnSchema.parse(raw);
    // P1: spawn claude.exe here and stream events back via sendToRenderer.
    void input;
  });

  ipcMain.handle(IPC.CLAUDE_INTERRUPT, async (_evt, raw) => {
    InterruptSchema.parse(raw);
    // P1: tree-kill the child process for this session.
  });

  ipcMain.handle(IPC.CLAUDE_APPROVE, async (_evt, raw) => {
    ApproveSchema.parse(raw);
    // P1: write permission_response to the child's stdin.
  });
}
