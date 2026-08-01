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
 *  - `download-progress` -> push `update:downloadProgress` (percent + bytes)
 *    and persist the snapshot so reopening the About panel keeps the bar.
 *  - `update-downloaded` -> push `update:downloaded`; the renderer offers
 *    "restart & install" -> `app.quitAndInstall()`.
 *
 * The download/downloaded states are persisted to the settings table
 * (UPDATE_STATE_SETTING_KEY) so that remounting the About panel or restarting
 * the app mid-flow restores the banner instead of dropping back to idle.
 *
 * Every public function is wrapped so update failures never crash the app -
 * the updater is a convenience, not a core path.
 */
import { app } from "electron";
// electron-updater ships as CommonJS; under ESM output ("type": "module") a
// named import (`import { autoUpdater }`) is not reliably supported by Node's
// ESM/CJS interop - it throws "Named export 'autoUpdater' not found" at boot.
// We therefore import the default export and destructure `autoUpdater` from it.
//
// Lazy-loaded: electron-updater only works in packaged builds and is never
// needed during startup (the first check is scheduled 10s after boot). Keeping
// the CJS module out of the startup path shaves load time in both dev (where
// it's a pure no-op) and prod. Mirrors the node-pty / SDK lazy-load pattern.
import type { AppUpdater } from "electron-updater";
let autoUpdaterRef: AppUpdater | null = null;
async function loadAutoUpdater(): Promise<AppUpdater> {
  if (!autoUpdaterRef) {
    const mod = await import("electron-updater");
    autoUpdaterRef = mod.autoUpdater;
  }
  return autoUpdaterRef;
}
import {
  IPC,
  UPDATE_STATE_SETTING_KEY,
  type CheckForUpdatesResult,
  type PersistedUpdateState,
} from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { is } from "@main/utils.js";
import { SettingRepo } from "@main/store/repositories.js";

/** Delay before the first automatic update check after boot (ms). */
const FIRST_CHECK_DELAY_MS = 10_000;
/** Interval between recurring update checks (ms) - every 4 hours. */
const RECURRING_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Whether the updater is active (packaged app only). */
let initialized = false;

/** Track the latest update info so the check RPC can report it synchronously. */
let pendingVersion: string | null = null;

/** Version currently being downloaded (set when download starts, cleared on
 *  completion/error). Used to tag download-progress events with a version. */
let downloadingVersion: string | null = null;

/** Wire autoUpdater event listeners and schedule periodic checks.
 *  Safe to call in dev - it short-circuits and does nothing.
 *  Async because electron-updater is lazy-loaded on first use. */
export async function initUpdater(): Promise<void> {
  if (!is.prod) {
    // electron-updater has no app-update.yml to read in dev; skip entirely.
    return;
  }

  try {
    const autoUpdater = await loadAutoUpdater();
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
      // A previously discovered update may have been superseded; clear any
      // stale "downloading"/"downloaded" snapshot so the About panel doesn't
      // show a ghost banner for a version that no longer exists.
      clearPersistedUpdateState();
      log.info(`updater: up-to-date (${info.version ?? app.getVersion()})`);
    });

    autoUpdater.on("update-downloaded", (info) => {
      const version = info.version ?? "";
      downloadingVersion = null;
      log.info(`updater: update downloaded ${version}`);
      persistUpdateState({ status: "downloaded", version });
      sendToRenderer(IPC.UPDATE_DOWNLOADED, {
        channel: IPC.UPDATE_DOWNLOADED,
        version,
        releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
      });
    });

    autoUpdater.on("error", (err) => {
      log.error(`updater: error ${err?.message ?? String(err)}`);
      // A download error leaves no usable snapshot; clear it so the About
      // panel doesn't get stuck on a stale "downloading" bar on next open.
      if (downloadingVersion !== null) {
        downloadingVersion = null;
        clearPersistedUpdateState();
      }
    });

    autoUpdater.on("download-progress", (progress) => {
      const version = downloadingVersion ?? pendingVersion ?? "";
      const percent = progress.percent ?? 0;
      log.info(
        `updater: downloading ${percent.toFixed(1)}% (${progress.transferred}/${progress.total})`,
      );
      persistUpdateState({
        status: "downloading",
        version,
        percent,
        transferred: progress.transferred,
        total: progress.total,
      });
      sendToRenderer(IPC.UPDATE_DOWNLOAD_PROGRESS, {
        channel: IPC.UPDATE_DOWNLOAD_PROGRESS,
        version,
        percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
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
    const autoUpdater = await loadAutoUpdater();
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
    const autoUpdater = await loadAutoUpdater();
    // Record the version being downloaded so download-progress events can tag
    // it, and seed the persisted state so an early remount shows "downloading"
    // even before the first progress chunk arrives.
    downloadingVersion = pendingVersion;
    if (downloadingVersion) {
      persistUpdateState({ status: "downloading", version: downloadingVersion });
    }
    await autoUpdater.downloadUpdate();
  } catch (err) {
    downloadingVersion = null;
    clearPersistedUpdateState();
    log.error(`updater: downloadUpdate failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Quit the app and install the downloaded update. No-op if nothing downloaded. */
export async function quitAndInstall(): Promise<void> {
  if (!is.prod || !initialized) return;
  try {
    const autoUpdater = await loadAutoUpdater();
    // The install will swap the binary and restart; clear the persisted state
    // so the next launch (running the new version) doesn't show a stale banner.
    clearPersistedUpdateState();
    autoUpdater.quitAndInstall();
  } catch (err) {
    log.error(`updater: quitAndInstall failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ── Persisted update-state helpers ──
 *  The download/downloaded states are written to the settings table so the
 *  About panel can restore its banner after remount or app restart. These are
 *  guarded so a DB write failure never breaks the update flow itself. */

/** Write a snapshot of the current update flow to the settings table. */
function persistUpdateState(
  state:
    | { status: "downloading"; version: string; percent?: number; transferred?: number; total?: number }
    | { status: "downloaded"; version: string },
): void {
  try {
    const snapshot: PersistedUpdateState = {
      status: state.status,
      version: state.version,
      percent: state.status === "downloading" ? (state.percent ?? 0) : 0,
      transferred: state.status === "downloading" ? (state.transferred ?? 0) : 0,
      total: state.status === "downloading" ? (state.total ?? 0) : 0,
      updatedAt: new Date().toISOString(),
    };
    SettingRepo.set(UPDATE_STATE_SETTING_KEY, JSON.stringify(snapshot));
  } catch (err) {
    // Persisting the snapshot is best-effort; never let it break the updater.
    log.error(`updater: persist state failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remove the persisted update state (after install, or when it goes stale). */
function clearPersistedUpdateState(): void {
  try {
    SettingRepo.set(UPDATE_STATE_SETTING_KEY, "");
  } catch (err) {
    log.error(`updater: clear state failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read the persisted update state, or null if none/cleared. Used by the About
 *  panel on mount to restore its banner without re-checking for updates. */
export function getPersistedUpdateState(): PersistedUpdateState | null {
  try {
    const raw = SettingRepo.get(UPDATE_STATE_SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedUpdateState;
    if (parsed.status !== "downloading" && parsed.status !== "downloaded") return null;
    return parsed;
  } catch {
    return null;
  }
}
