/**
 * Shared Pi SDK lazy-loader with the worker_threads polyfill.
 *
 * Both the IPC handlers (piModels.listAvailable) and the provider
 * (PiAgentSdkProvider.startTurn) need to load @earendil-works/pi-coding-agent.
 * They must share a single loader so the polyfill runs exactly once and
 * before the first import — otherwise whichever caller imports first
 * triggers undici's module-init crash (see polyfillWorkerThreads).
 */
import { log } from "@main/lib/logger.js";

let sdkModule: typeof import("@earendil-works/pi-coding-agent") | null = null;

/**
 * Polyfill `markAsUncloneable` on `node:worker_threads` before the Pi SDK
 * loads. The SDK pulls in undici@8.x, whose webidl module destructures
 * `markAsUncloneable` from `node:worker_threads` at module-init time and
 * calls it in the CacheStorage constructor (undici/index.js:179). That API
 * only exists on Node >= 22.14, but Electron 33 ships Node 20 — so the
 * import resolves to `undefined` and crashes at load time. Polyfilling
 * with a no-op (the real API only matters when the object is sent across a
 * MessageChannel, which Mcode never does with CacheStorage) lets the SDK
 * boot. Must run BEFORE the first `import("@earendil-works/pi-coding-agent")`.
 */
let polyfillApplied = false;
export function polyfillWorkerThreads(): void {
  if (polyfillApplied) return;
  polyfillApplied = true;
  try {
    const wt = require("node:worker_threads") as { markAsUncloneable?: unknown };
    if (typeof wt.markAsUncloneable !== "function") {
      wt.markAsUncloneable = function markAsUncloneable() {
        /* no-op — see jsdoc above */
      };
      log.info("pi: polyfilled worker_threads.markAsUncloneable for Node < 22.14");
    }
  } catch {
    /* worker_threads always available in main; ignore */
  }
}

/** Lazy-load the Pi SDK. Applies the worker_threads polyfill on the first
 *  call. Returns the cached module on subsequent calls. */
export async function loadPiSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  if (!sdkModule) {
    polyfillWorkerThreads();
    sdkModule = await import("@earendil-works/pi-coding-agent");
  }
  return sdkModule;
}
