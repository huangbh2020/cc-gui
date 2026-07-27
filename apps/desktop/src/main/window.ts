import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { is } from "@main/utils.js";
import { getEffectiveTheme } from "@main/lib/theme.js";

let mainWindow: BrowserWindow | null = null;

/** Background color matching the effective theme, so the first frame (before
 *  React mounts) doesn't flash the wrong color. Mirrors --surface in CSS. */
function bgColor(): string {
  return getEffectiveTheme() === "dark" ? "#18181b" : "#ffffff";
}

/** Create the primary three-pane window. */
export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "Claude GUI",
    backgroundColor: bgColor(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  // Forward renderer console messages to stderr so we can debug blank screens
  // without watching DevTools.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const tag = ["LOG", "WARN", "ERROR"][level] ?? "LOG";
    process.stderr.write(`[renderer:${tag}] ${message} (${sourceId}:${line})\n`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`[renderer:GONE] ${JSON.stringify(details)}\n`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stderr.write(`[renderer:FAIL_LOAD] ${code} ${desc} ${url}\n`);
  });

  // Open external links in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Load the renderer.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Send a push event to the renderer (main → renderer). */
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args);
}
