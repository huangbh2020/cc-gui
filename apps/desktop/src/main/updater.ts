/**
 * Auto-update module (electron-updater, GitHub Releases channel).
 *
 * electron-updater only works inside a packaged app (it reads app-update.yml
 * from the asar/resources dir, which doesn't exist in dev). So in dev every
 * entry point short-circuits to a no-op / "up-to-date" result - the updater
 * simply isn't active during `pnpm dev`.
 *
 * Flow:
 *  - On boot (prod), `initUpdater()` wires autoUpdater listeners and schedules
 *    a delayed first check (10s) plus a recurring check (every 4h).
 *  - `update-available` -> push `update:available` to renderer (autoDownload
 *    is OFF, so the user opts in via the About panel's "download" button).
 *  - `app.downloadUpdate()` -> `autoUpdater.downloadUpdate()`.
 *  - `update-downloaded` -> push `update:downloaded`; the renderer offers
 *    "restart & install" -> `app.quitAndInstall()`.
 *
 * Every public function is wrapped so update failures never crash the app -
 * the updater is a convenience, not a core path.
 */
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { IPC, type CheckForUpdatesResult } from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { is } from "@main/utils.js";

/** Delay before the first automatic update check after boot (ms). */
const FIRST_CHECK_DELAY_MS = 10_000;
/** Interval between recurring update checks (ms) - every 4 hours. */
const RECURRING_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Whether the updater is active (packaged app only). */
let initialized = false;

/** Track the latest update info so the check RPC can report it synchronously. */
let pendingVersion: string | null = null;

/** Wire autoUpdater event listeners and schedule periodic checks.
 *  Safe to call in dev - it short-circuits and does nothing. */
export function initUpdater(): void {
  if (!is.prod) {
    // electron-updater has no app-update.yml to read in dev; skip entirely.
    return;
  }

  try {
    // Don't auto-download - let the user opt in from the About panel.
    autoUpdater.autoDownload = false;
    // Install on quit if a download has completed (harmless if none pending).
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      pendingVersion = info.version ?? null;
      log.info(`updater: update available ${pendingVersion ?? "(unknown version)"}`);
      sendToRenderer(IPC.UPDATE_AVAILABLE, {
        channel: IPC.UPDATE_AVAILABLE,
        version: info.version ?? "",
        releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
        releaseDate: info.releaseDate,
      });
    });

    autoUpdater.on("update-not-available", (info) => {
      pendingVersion = null;
      log.info(`updater: up-to-date (${info.version ?? app.getVersion()})`);
    });

    autoUpdater.on("update-downloaded", (info) => {
      const version = info.version ?? "";
      log.info(`updater: update downloaded ${version}`);
      sendToRenderer(IPC.UPDATE_DOWNLOADED, {
        channel: IPC.UPDATE_DOWNLOADED,
        version,
        releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
      });
    });

    autoUpdater.on("error", (err) => {
      log.error(`updater: error ${err?.message ?? String(err)}`);
    });

    autoUpdater.on("download-progress", (progress) => {
      // Progress is informational; we don't surface it to the renderer yet.
      log.info(
        `updater: downloading ${progress.percent?.toFixed(1) ?? "?"}% (${progress.transferred}/${progress.total})`,
      );
    });

    // Delayed first check, then recurring.
    setTimeout(() => {
      void checkForUpdates();
    }, FIRST_CHECK_DELAY_MS);
    setInterval(() => {
      void checkForUpdates();
    }, RECURRING_CHECK_INTERVAL_MS);

    initialized = true;
    log.info("updater: initialized (GitHub Releases channel)");
  } catch (err) {
    log.error(`updater: init failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Check for updates. In dev, returns "up-to-date" without hitting the network.
 *  In prod, triggers autoUpdater.checkForUpdates() and resolves once the check
 *  completes (or errors). */
export async function checkForUpdates(): Promise<CheckForUpdatesResult> {
  if (!is.prod || !initialized) {
    return { status: "up-to-date", version: app.getVersion() };
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    // If a newer version exists, `update-available` will have fired and set
    // pendingVersion. Otherwise the check resolves and we're up-to-date.
    if (pendingVersion) {
      return { status: "available", version: pendingVersion };
    }
    const version = result?.updateInfo?.version ?? app.getVersion();
    return { status: "up-to-date", version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`updater: checkForUpdates failed ${msg}`);
    return { status: "error", error: msg };
  }
}

/** Begin downloading the pending update (user opted in from the UI).
 *  No-op in dev or when no update is pending. */
export async function downloadUpdate(): Promise<void> {
  if (!is.prod || !initialized) return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    log.error(`updater: downloadUpdate failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Quit the app and install the downloaded update. No-op if nothing downloaded. */
export async function quitAndInstall(): Promise<void> {
  if (!is.prod || !initialized) return;
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    log.error(`updater: quitAndInstall failed ${err instanceof Error ? err.message : String(err)}`);
  }
}
