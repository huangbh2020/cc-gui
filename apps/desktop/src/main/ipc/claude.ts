import type { IpcMain } from "electron";
import { dialog } from "electron";
import { spawn } from "node:child_process";
import {
  IPC,
  StartSessionSchema,
  SendTurnSchema,
  InterruptSchema,
  ApproveSchema,
  SessionMessagesSchema,
  SaveMessagesSchema,
  GetSettingSchema,
  SetSettingSchema,
  TestClaudePathSchema,
} from "@contracts/ipc";
import type { SaveMessagesInput, TestClaudePathResult } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import { uid } from "@main/utils.js";
import { SessionRepo, ProjectRepo, MessageRepo, SettingRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { resolveClaude, resolveClaudeSpec, resetClaudeResolution, CLAUDE_PATH_SETTING_KEY } from "@main/claude/ClaudePathResolver.js";
import { log } from "@main/lib/logger.js";

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  // ── folder picker: lets the renderer ask for a project directory ──
  ipcMain.handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });

  // ── health check: is claude installed and resolvable? ──
  // Re-probe live each time (user may have just configured a path in Settings).
  ipcMain.handle("claude:healthCheck", async () => {
    const spec = await resolveClaude();
    return { installed: !!spec, source: spec?.source ?? null, command: spec?.command ?? null };
  });

  ipcMain.handle(IPC.CLAUDE_START_SESSION, (_evt, raw) => {
    const input = StartSessionSchema.parse(raw);
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId: input.projectId,
      claudeSessionId: null, // captured from system/init once the first turn runs
      title: input.title ?? "New session",
      status: "idle",
      model: input.model ?? "default",
      effort: input.effort,
      permissionMode: input.permissionMode,
      createdAt: now,
      updatedAt: now,
    };
    SessionRepo.create(session);
    runtimeManager.bindSession(session);
    log.info(`session started: ${session.id} (project ${input.projectId})`);
    return { session };
  });

  ipcMain.handle(IPC.CLAUDE_SEND_TURN, async (_evt, raw) => {
    const input = SendTurnSchema.parse(raw);
    const session = SessionRepo.get(input.sessionId);
    if (!session) throw new Error(`session not found: ${input.sessionId}`);
    const project = ProjectRepo.get(session.projectId);
    if (!project) throw new Error(`project not found for session ${input.sessionId}`);

    // Auto-title from the first user message, if the title is still the default.
    // We return the (possibly updated) session so the renderer can refresh.
    let updated = session;
    if (session.title === "New session" && input.prompt.trim()) {
      const title = input.prompt.trim().slice(0, 40) + (input.prompt.trim().length > 40 ? "…" : "");
      SessionRepo.updateTitle(session.id, title);
      updated = { ...session, title };
    }

    SessionRepo.updateStatus(session.id, "running");
    // Lazily bind a runtime for this session (no-op if already bound). Needed
    // for sessions reactivated after an app restart — they have a persisted
    // claudeSessionId but no in-memory runtime yet.
    runtimeManager.bindSession(updated);
    await runtimeManager.sendTurn(updated, { prompt: input.prompt, cwd: project.path });
    return { session: SessionRepo.get(session.id) ?? updated };
  });

  ipcMain.handle(IPC.CLAUDE_INTERRUPT, async (_evt, raw) => {
    const input = InterruptSchema.parse(raw);
    runtimeManager.interrupt(input.sessionId);
    SessionRepo.updateStatus(input.sessionId, "interrupted");
  });

  ipcMain.handle(IPC.CLAUDE_APPROVE, async (_evt, raw) => {
    ApproveSchema.parse(raw);
    // P3: write permission_response to the child's stdin. P1 runs with no
    // approval flow (claude's default tools execute automatically).
  });

  // ── P2: message persistence ──
  // Renderer sends the full ChatMessage[] snapshot at turn boundaries; we
  // replace whatever is stored for the session in one transaction. Cast to the
  // domain input type — the schema validated shape; the domain type carries
  // the required-content guarantee that zod's infer of z.unknown() drops.
  ipcMain.handle(IPC.SESSION_SAVE_MESSAGES, (_evt, raw) => {
    const input = SaveMessagesSchema.parse(raw) as SaveMessagesInput;
    MessageRepo.replaceAll(input.sessionId, input.messages);
  });

  // Load a session's persisted history (called when switching sessions or
  // reactivating a session after app restart).
  ipcMain.handle(IPC.SESSION_MESSAGES, (_evt, raw) => {
    const input = SessionMessagesSchema.parse(raw);
    return { messages: MessageRepo.listBySession(input.sessionId) };
  });

  // ── Settings & claude path config ──
  ipcMain.handle(IPC.SETTING_GET, (_evt, raw) => {
    const input = GetSettingSchema.parse(raw);
    return { value: SettingRepo.get(input.key) };
  });

  ipcMain.handle(IPC.SETTING_SET, (_evt, raw) => {
    const input = SetSettingSchema.parse(raw);
    SettingRepo.set(input.key, input.value);
    // If the claude path changed, drop the cached auto-resolution so the next
    // probe picks up the new setting (user config is re-read live anyway, but
    // this also re-probes when the user clears the setting).
    if (input.key === CLAUDE_PATH_SETTING_KEY) resetClaudeResolution();
  });

  // Native file picker for choosing the claude executable.
  ipcMain.handle(IPC.DIALOG_PICK_FILE, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Claude CLI", extensions: ["exe", "cmd", "cjs", "bat"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });

  // Probe a candidate claude path by running `claude --version`. Pure
  // one-shot — doesn't touch the resolution cache or the stored setting.
  ipcMain.handle(IPC.CLAUDE_TEST_PATH, async (_evt, raw): Promise<TestClaudePathResult> => {
    const input = TestClaudePathSchema.parse(raw);
    const spec = resolveClaudeSpec(input.path);
    if (!spec) {
      return { ok: false, error: "File does not exist at that path." };
    }
    return new Promise((resolve) => {
      const args = [...spec.preArgs, "--version"];
      const child = spawn(spec.command, args, {
        windowsHide: true,
        shell: spec.command.endsWith(".cmd"),
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: "Timed out (claude --version took >10s)." });
      }, 10000);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `Failed to launch: ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const version = stdout.trim();
        if (code === 0 && version) {
          resolve({ ok: true, version });
        } else {
          resolve({
            ok: false,
            error: stderr.trim() || `Exited with code ${code} and no output.`,
          });
        }
      });
    });
  });
}
