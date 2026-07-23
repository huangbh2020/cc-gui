/** Typed access to the preload-exposed API. Re-exported so components don't
 * touch window.api directly (keeps the boundary explicit). */
import type { StartSessionInput, SendTurnInput } from "@contracts/ipc";

export const api = window.api;

export type { StartSessionInput, SendTurnInput };
