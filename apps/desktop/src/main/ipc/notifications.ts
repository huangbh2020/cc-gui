import type { IpcMain } from "electron";
import { IPC, NOTIFICATION_PREFS_SETTING_KEY, FocusSessionSchema, NotificationPrefsSchema, type NotificationPrefs } from "@contracts/ipc";
import { notificationManager } from "@main/notifications/NotificationManager.js";
import { SettingRepo } from "@main/store/repositories.js";
import { sendToRenderer } from "@main/window.js";

/** Register notification-related IPC handlers (get/set prefs + focus session). */
export function registerNotificationHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.NOTIFICATION_GET_PREFS, async () => {
    return { prefs: notificationManager.getPrefs() };
  });

  ipc.handle(IPC.NOTIFICATION_SET_PREFS, async (_event, raw) => {
    const parsed = NotificationPrefsSchema.parse(raw);
    const prefs: NotificationPrefs = {
      osEnabled: parsed.osEnabled,
      turnComplete: parsed.turnComplete,
      errors: parsed.errors,
      blocking: parsed.blocking,
      backgroundTasks: parsed.backgroundTasks,
    };
    // Persist to the settings table as JSON.
    SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, JSON.stringify(prefs));
    // Update the in-memory prefs so the observer picks up the change immediately.
    notificationManager.setPrefs(prefs);
    return { prefs };
  });

  // Focus a session (show + focus the window, then tell the renderer to
  // navigate). Used when the renderer wants to jump to a session - e.g. from
  // a toast click (though that path also works purely renderer-side via
  // openTab; this RPC ensures the window is brought to front first).
  ipc.handle(IPC.NOTIFICATION_FOCUS_SESSION, async (_event, raw) => {
    const input = FocusSessionSchema.parse(raw);
    const { getMainWindow } = await import("@main/window.js");
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendToRenderer(IPC.NOTIFICATION_FOCUS_SESSION, {
      channel: IPC.NOTIFICATION_FOCUS_SESSION,
      sessionId: input.sessionId,
    });
  });
}
