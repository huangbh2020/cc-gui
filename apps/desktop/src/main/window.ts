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

/** Title-bar overlay colour scheme that matches the app theme. The overlay sits
 *  behind the native min/max/close buttons when `titleBarStyle: 'hidden'` is
 *  active, so it must visually blend with the custom titlebar in the renderer.
 *
 *  `height` must match the renderer titlebar's height (h-10 = 40px): Electron
 *  draws the overlay aligned to the top of the window, and the buttons are
 *  centered within `height`. If this is smaller than the bar (e.g. 32), the
 *  buttons sit too high instead of being vertically centered. */
function overlayColors() {
  const dark = getEffectiveTheme() === "dark";
  return {
    color: dark ? "#18181b" : "#ffffff",
    symbolColor: dark ? "#a1a1aa" : "#71717a",
    height: 40,
  };
}

/** Update the title-bar overlay colors (called when the theme switches).
 *
 *  `setTitleBarOverlay` only exists on Windows and Linux, where
 *  `titleBarOverlay` paints the area behind the native min/max/close buttons.
 *  macOS uses the traffic-light buttons (see `trafficLightPosition`) and has no
 *  overlay, so the call is a no-op there — without this guard it throws
 *  "setTitleBarOverlay is not a function" on macOS. */
export function updateTitleBarOverlay(): void {
  if (process.platform === "darwin") return;
  mainWindow?.setTitleBarOverlay(overlayColors());
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
    // Hidden title-bar + overlay lets us render custom content (the toggle
    // button plus a draggable handle) in the title-bar row alongside the
    // native window-control buttons (min / max / close).  The overlay colours
    // are set once here and kept in sync by updateTitleBarOverlay().
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(),
    // macOS only: pin the traffic-light buttons (close/min/zoom) so they sit
    // vertically centered in our 40px (h-10) custom titlebar. Without this,
    // macOS uses its default Y (~14px from the top), which is tuned for the
    // standard ~28px titlebar and leaves the buttons sitting too high in our
    // taller bar. The 12px-diameter circles are vertically centered when the
    // group origin is at y = (40 - 14) / 2 ≈ 13. Ignored on Windows/Linux.
    trafficLightPosition: { x: 20, y: 13 },
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
