/**
 * Platform detection for the renderer.
 *
 * The renderer has no direct access to `process.platform` (contextIsolation
 * is on, nodeIntegration off), but layout decisions — e.g. reserving space
 * for macOS traffic lights vs. the Windows/Linux titleBarOverlay controls —
 * need to know the OS. `navigator.userAgent` is the standard, dependency-free
 * way to do this in Electron, computed once at module load.
 *
 * For anything that touches the main process (window creation, native APIs),
 * branch on `process.platform` there instead.
 */
type Platform = "mac" | "windows" | "linux";

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "mac";
  if (ua.includes("Win")) return "windows";
  return "linux";
}

export const platform: Platform = detectPlatform();
export const isMac = platform === "mac";
export const isWindows = platform === "windows";
