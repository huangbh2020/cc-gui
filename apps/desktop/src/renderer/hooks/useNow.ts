import { useSyncExternalStore } from "react";

/**
 * Global shared 1-second ticker for live-duration displays.
 *
 * The per-turn stat row (`TurnStatRow` in ChatPane) renders inside a
 * LegendList virtualized item. During streaming, delta flushes rebuild the
 * `renderItems` array on every frame, which can cause the list to recycle its
 * containers and remount `TurnStatRow` before a component-local `setInterval`
 * ever fires its first 1000ms tick - leaving the duration stuck at "<1s".
 *
 * Moving the clock to a single module-level interval that survives remounts
 * (via `useSyncExternalStore`) breaks that coupling: the timer runs once for
 * the whole app regardless of how the virtual list shuffles components, and it
 * auto-starts/stops with the first/last subscriber so it costs nothing when no
 * live turn is on screen.
 */

let currentTick = Date.now();
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function startClock(): void {
  if (intervalId !== null) return;
  intervalId = setInterval(() => {
    currentTick = Date.now();
    for (const cb of listeners) cb();
  }, 1000);
}

function stopClock(): void {
  if (intervalId === null) return;
  clearInterval(intervalId);
  intervalId = null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) startClock();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stopClock();
  };
}

function getSnapshot(): number {
  return currentTick;
}

/** Re-render roughly once per second. Returns the current wall-clock ms.
 *  Only subscribe when a live (ongoing) turn is visible, so finished turns
 *  don't pay for an unnecessary tick. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
