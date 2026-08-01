/**
 * Lightweight startup timing instrumentation.
 *
 * Records a single high-resolution timestamp at main-process module-evaluation
 * time (the very first thing that runs), then lets other startup stages report
 * elapsed milliseconds relative to it. Output goes through the existing logger
 * with a `startup: <stage> <ms>ms` prefix so it's easy to grep from main.log.
 *
 * Why a separate module? `index.ts` imports `window.ts`, not the other way
 * around, so sharing a timestamp via a direct import would create a cycle. A
 * tiny standalone module avoids that.
 *
 * `log` is imported statically (not lazily) because logger.ts only touches
 * `app.getPath` inside `getLogFile()`, which runs on first write - and all our
 * `logStartup` calls happen after `app.whenReady()`.
 */
import { log } from "@main/lib/logger.js";

/** Monotonic ms captured at first module eval (process boot). */
const bootMs = performance.now();

export function startupMs(): number {
  return Math.round(performance.now() - bootMs);
}

/** Log a startup stage's elapsed time. */
export function logStartup(stage: string): void {
  log.info(`startup: ${stage} ${startupMs()}ms`);
}
