import { ClaudeRuntime, type TurnRequest } from "./ClaudeRuntime.js";
import { sendToRenderer } from "@main/window.js";
import { IPC } from "@contracts/ipc";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import { SessionRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

interface SessionRuntime {
  runtime: ClaudeRuntime;
  /** claude's own session id, captured to enable --resume across turns. */
  claudeSessionId: string | null;
}

/**
 * One runtime per GUI session. Bridges normalized events to the renderer
 * over IPC and remembers the claude session id so subsequent turns resume.
 */
class RuntimeManager {
  private runtimes = new Map<string, SessionRuntime>();

  /** Wire up the event pipe for a session (called on startSession, and again
   * when a persisted session is reactivated via selectSession). */
  bindSession(session: Session): void {
    // If already bound, keep the existing runtime (it may be mid-turn or hold
    // a captured claude session id). Only create on first bind.
    if (this.runtimes.has(session.id)) return;
    const emit = (e: RuntimeEvent) => {
      sendToRenderer(IPC.CLAUDE_EVENT, { channel: IPC.CLAUDE_EVENT, sessionId: e.sessionId, event: e });
    };
    // Capture claude's own session id from the system/init line and persist it,
    // so the next turn can --resume and a restarted app keeps the link.
    const onClaudeSessionId = (claudeSessionId: string) => {
      this.onClaudeSessionCaptured(session.id, claudeSessionId);
    };
    this.runtimes.set(session.id, {
      runtime: new ClaudeRuntime(emit, onClaudeSessionId),
      claudeSessionId: session.claudeSessionId,
    });
  }

  /** Persist claude's session id (memory + SQLite) so future turns resume. */
  private onClaudeSessionCaptured(guiSessionId: string, claudeSessionId: string): void {
    const rt = this.runtimes.get(guiSessionId);
    if (!rt) return;
    // Idempotent — skip if unchanged to avoid redundant writes on every turn.
    if (rt.claudeSessionId === claudeSessionId) return;
    rt.claudeSessionId = claudeSessionId;
    try {
      SessionRepo.updateClaudeSessionId(guiSessionId, claudeSessionId);
    } catch (err) {
      log.error(`failed to persist claude session id: ${(err as Error).message}`);
    }
  }

  /** Send a user turn. Captures the claude session id emitted during the run. */
  async sendTurn(session: Session, input: { prompt: string; cwd: string }): Promise<void> {
    const rt = this.runtimes.get(session.id);
    if (!rt) {
      log.warn(`sendTurn: no runtime bound for session ${session.id}`);
      return;
    }
    if (rt.runtime.isRunning()) {
      log.warn(`sendTurn: session ${session.id} already running, ignoring`);
      return;
    }
    const req: TurnRequest = {
      sessionId: session.id,
      prompt: input.prompt,
      cwd: input.cwd,
      model: session.model !== "default" ? session.model : undefined,
      effort: session.effort,
      permissionMode: session.permissionMode,
      resumeSessionId: rt.claudeSessionId,
    };
    // Run in the background; events stream via emit(). We don't await here so
    // the IPC handler returns immediately and the renderer stays responsive.
    rt.runtime.runTurn(req).catch((err) => {
      log.error(`runTurn failed: ${err?.message ?? err}`);
    });
  }

  interrupt(sessionId: string): void {
    this.runtimes.get(sessionId)?.runtime.interrupt();
  }

  dispose(sessionId: string): void {
    this.runtimes.get(sessionId)?.runtime.interrupt();
    this.runtimes.delete(sessionId);
  }
}

export const runtimeManager = new RuntimeManager();
