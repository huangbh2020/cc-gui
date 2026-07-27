/**
 * Per-session file snapshot map — owned at module scope so the runtime
 * (writer) and the provider (reader) can both reach it without a
 * circular import. Mirrors the same pattern as `providerRegistry`.
 *
 * Why a module-scope singleton: the provider ctor needs to know which
 * session's snapshot to hand to its adapter, but the runtime creates
 * snapshots lazily as sessions bind. A shared Map both can reach solves
 * it without restructuring the AgentProvider interface.
 */
import { FileSnapshot } from "./fileSnapshot.js";

const snapshots = new Map<string, FileSnapshot>();

/** Get (or create) the snapshot for a session. The runtime calls this
 *  on first sendTurn; the provider calls it on every startTurn to look
 *  up the latest instance. */
export function getFileSnapshot(sessionId: string): FileSnapshot {
  let snap = snapshots.get(sessionId);
  if (!snap) {
    snap = new FileSnapshot();
    snapshots.set(sessionId, snap);
  }
  return snap;
}

/** Drop the snapshot for a session entirely (e.g. session deleted). */
export function dropFileSnapshot(sessionId: string): void {
  snapshots.delete(sessionId);
}
