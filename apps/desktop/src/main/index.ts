import { app, BrowserWindow, session } from "electron";
import { createMainWindow } from "@main/window.js";
import { registerIpcHandlers } from "@main/ipc/index.js";
import { initDb, closeDb } from "@main/store/db.js";
import { initTheme } from "@main/lib/theme.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { initUpdater } from "@main/updater.js";
import { is } from "@main/utils.js";
import { logStartup } from "@main/lib/startupTimer.js";

// Single-instance lock - only one GUI instance runs at a time.
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
  logStartup("whenReady entered");

  // Kick off DB init in the background (sql.js loads ~6MB asm.js + reads the
  // file + migrates). We DON'T await it - the window is created next so the
  // renderer starts loading immediately. IPC handlers await `awaitDb()`
  // internally (see ipc/index.ts), so any request that arrives before the DB
  // is ready simply queues instead of failing.
  void initDb();

  // CSP only in production - in dev, Vite injects inline HMR scripts that a
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

  // Apply the persisted theme preference. Fire-and-forget: initTheme() awaits
  // DB readiness internally, so the first frame uses the OS-default theme and
  // is corrected to the saved preference once the DB is ready. Only a user
  // preference that differs from the OS causes a brief first-frame flash.
  void initTheme();

  // Register IPC handlers (each awaits DB readiness before running).
  registerIpcHandlers();
  logStartup("IPC handlers registered");

  // Create the window immediately - don't wait for DB init to finish. The
  // renderer starts loading its JS/HMR while sql.js parses in parallel.
  createMainWindow();
  logStartup("createMainWindow returned");

  // Start the auto-updater (no-op in dev; only active in packaged builds).
  // Fire-and-forget: the first check is delayed 10s anyway, and the updater
  // module is lazy-loaded, so this never blocks window creation.
  void initUpdater();

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
