/**
 * Renderer-side mirror of the main process's per-turn file list. Kept
 * here (not in @contracts) because the file is renderer-only and small.
 * The shape matches `FrozenFile` from main/lib/fileSnapshot.ts one-for-one.
 */
export type TurnFileKind = "modified" | "created";

export interface TurnFileEntry {
  /** Absolute path (cwd-resolved by main). */
  filePath: string;
  kind: TurnFileKind;
}
