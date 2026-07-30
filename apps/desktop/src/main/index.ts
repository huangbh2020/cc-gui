import { app, BrowserWindow, session } from "electron";
import { createMainWindow } from "@main/window.js";
import { registerIpcHandlers } from "@main/ipc/index.js";
import { initDb, closeDb } from "@main/store/db.js";
import { initTheme } from "@main/lib/theme.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { is } from "@main/utils.js";

// Single-instance lock — only one GUI instance runs at a time.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  // Someone tried to run a second instance — focus our window instead.
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    const [win] = wins;
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  // Open SQLite before registering handlers — handlers may be invoked as soon
  // as they're registered, and the DB must be ready. app.getPath("userData")
  // is only valid after whenReady. sql.js loads asynchronously, hence await.
  await initDb();

  // CSP only in production — in dev, Vite injects inline HMR scripts that a
  // strict CSP would block, leaving the page blank.
  if (is.prod) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
          ],
        },
      });
    });
  }

  // Apply the persisted theme preference BEFORE creating the window, so the
  // first frame's backgroundColor and the renderer's initial .dark class
  // match — no flash of the wrong theme.
  initTheme();

  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Quit when all windows are closed, except on macOS.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Close PTYs + bridge servers + DB cleanly on shutdown (best-effort).
app.on("before-quit", () => {
  BridgeRegistry.disposeAll();
  TerminalManager.disposeAll();
  closeDb();
});
