/**
 * NotificationManager - OS-level desktop notifications for background session
 * activity.
 *
 * Subscribes to the RuntimeManager's event observer and fires an OS
 * Notification when a noteworthy event arrives for a session while the main
 * window is NOT focused (the user has switched away / minimized). When the
 * window IS focused, no OS notification is shown - the in-app badge + toast
 * layer (renderer) handles surfacing instead.
 *
 * Notification categories (configurable via NotificationPrefs):
 *  - blocking:   approval.request / question.ask / plan.approval_request
 *                (the agent is stalled until the user responds)
 *  - turnComplete: turn.done (non-interrupted, non-tool_use)
 *  - errors:     error
 *  - backgroundTasks: subagent.update where a backgrounded task just finished
 *
 * Clicking a notification shows + focuses the window and pushes
 * `notification:focusSession` so the renderer navigates to that session.
 */
import { Notification } from "electron";
import { join } from "node:path";
import type { RuntimeEvent } from "@contracts/runtime";
import { IPC, DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_PREFS_SETTING_KEY, type NotificationPrefs } from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { getMainWindow, sendToRenderer } from "@main/window.js";
import { SettingRepo } from "@main/store/repositories.js";
import { SessionRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** Path to the app icon for OS notifications. Same source image as the
 *  taskbar/window icon (build/icon.png); resolves relative to the compiled
 *  main output (out/main → ../../build/icon.png). On packaged builds the icon
 *  is embedded in the executable and the OS uses that, but passing it
 *  explicitly guarantees the notification card shows the logo in dev too. */
const NOTIFICATION_ICON = join(__dirname, "../../build/icon.png");

/** JSON-parse with a typed fallback. Returns defaults on any parse error. */
function parsePrefs(raw: string | null): NotificationPrefs {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
  try {
    const obj = JSON.parse(raw) as Partial<NotificationPrefs>;
    return { ...DEFAULT_NOTIFICATION_PREFS, ...obj };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

class NotificationManager {
  private prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  private started = false;
  /** Tracks the previous subagent roster per session so we can detect
   *  running -> completed/failed transitions (background task finished). */
  private prevSubagents = new Map<string, Map<string, "running" | "completed" | "failed" | "killed">>();

  /** Load prefs from the DB and attach the event observer. Called once at
   *  boot (after DB init). Safe to call multiple times - only starts once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.reloadPrefs();
    runtimeManager.setObserver((e) => this.onEvent(e));
    log.info("NotificationManager started");
  }

  /** Reload prefs from the settings table. Called on boot and after the user
   *  changes notification settings in the panel. */
  reloadPrefs(): void {
    try {
      const raw = SettingRepo.get(NOTIFICATION_PREFS_SETTING_KEY);
      this.prefs = parsePrefs(raw);
    } catch (err) {
      log.error(`NotificationManager: failed to load prefs: ${(err as Error).message}`);
    }
  }

  getPrefs(): NotificationPrefs {
    return { ...this.prefs };
  }

  setPrefs(prefs: NotificationPrefs): void {
    this.prefs = { ...prefs };
  }

  /** The main event observer. Decides whether an OS notification is warranted. */
  private onEvent(e: RuntimeEvent): void {
    // Only notify when the window is unfocused. When focused, the renderer's
    // in-app layer (badges + toasts) handles surfacing.
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isFocused() && !win.isMinimized()) return;

    const result = this.evaluate(e);
    if (!result) return;

    this.showNotification(result.title, result.body, e.sessionId);
  }

  /** Map a RuntimeEvent to a notification {title, body} or null (no notify). */
  private evaluate(e: RuntimeEvent): { title: string; body: string } | null {
    // Blocking events - the agent is stalled waiting for the user.
    if (e.type === "approval.request") {
      if (!this.prefs.blocking) return null;
      return {
        title: "需要审批工具调用",
        body: `${this.sessionTitle(e.sessionId)}: ${e.toolName}`,
      };
    }
    if (e.type === "question.ask") {
      if (!this.prefs.blocking) return null;
      const firstQ = e.questions[0];
      return {
        title: "Agent 有问题要问你",
        body: `${this.sessionTitle(e.sessionId)}${firstQ ? `: ${firstQ.question}` : ""}`,
      };
    }
    if (e.type === "plan.approval_request") {
      if (!this.prefs.blocking) return null;
      return {
        title: "计划待审批",
        body: `${this.sessionTitle(e.sessionId)}: 查看并批准执行计划`,
      };
    }

    // Turn completion.
    if (e.type === "turn.done") {
      if (!this.prefs.turnComplete) return null;
      // Skip interrupted (user-initiated) and tool_use (intermediate) turns.
      if (e.reason === "interrupted" || e.reason === "tool_use") return null;
      return {
        title: "回合完成",
        body: `${this.sessionTitle(e.sessionId)}: Agent 已完成本轮任务`,
      };
    }

    // Errors.
    if (e.type === "error") {
      if (!this.prefs.errors) return null;
      return {
        title: "发生错误",
        body: `${this.sessionTitle(e.sessionId)}: ${e.message}`,
      };
    }

    // Backgrounded subagent completion.
    if (e.type === "subagent.update") {
      // Always track the roster so the transition map stays fresh (even when
      // backgroundTasks pref is off, so it's correct when toggled back on).
      const prev = this.prevSubagents.get(e.sessionId) ?? new Map();
      const justFinished = e.agents.some((a) => {
        const was = prev.get(a.taskId);
        prev.set(a.taskId, a.status);
        return was === "running" && (a.status === "completed" || a.status === "failed");
      });
      this.prevSubagents.set(e.sessionId, prev);
      if (!this.prefs.backgroundTasks || !justFinished) return null;
      return {
        title: "后台任务完成",
        body: `${this.sessionTitle(e.sessionId)}: 子代理任务已结束`,
      };
    }

    return null;
  }

  /** Resolve a session title for the notification body. Falls back to a
   *  generic label if the session isn't in the DB (e.g. race with delete). */
  private sessionTitle(sessionId: string): string {
    try {
      const s = SessionRepo.get(sessionId);
      return s?.title || "会话";
    } catch {
      return "会话";
    }
  }

  /** Show an OS notification. Clicking it focuses the window + navigates the
   *  renderer to the session. */
  private showNotification(title: string, body: string, sessionId: string): void {
    if (!this.prefs.osEnabled) return;
    if (!Notification.isSupported()) return;

    const notif = new Notification({ title, body, icon: NOTIFICATION_ICON, silent: false });
    notif.on("click", () => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      // Show + focus the window (show is essential - the window may be hidden
      // to tray / minimized). On macOS, focus() alone doesn't un-minimize.
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // Tell the renderer to navigate to this session.
      sendToRenderer(IPC.NOTIFICATION_FOCUS_SESSION, {
        channel: IPC.NOTIFICATION_FOCUS_SESSION,
        sessionId,
      });
    });
    notif.show();
  }
}

/** Singleton. Started in index.ts after DB init. */
export const notificationManager = new NotificationManager();
