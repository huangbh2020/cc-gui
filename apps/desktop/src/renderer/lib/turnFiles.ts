/**
 * Renderer-side mirror of the main process's per-turn file list.
 *
 * Re-exported from @contracts so the renderer, the persisted Session row, and
 * the `turn.files` event payload all share one source of truth. The shape
 * matches `FrozenFile` from main/lib/fileSnapshot.ts one-for-one (computed by
 * `FileSnapshot.freeze`, which also fills in `adds`/`dels`/`before`).
 */
export type { TurnFileEntry, TurnFileKind } from "@contracts/runtime";
