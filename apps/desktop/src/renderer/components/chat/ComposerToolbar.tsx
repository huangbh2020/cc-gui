import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ModelDropdown } from "./ModelDropdown.js";
import { EffortDropdown } from "./EffortDropdown.js";
import { PermissionModeDropdown } from "./PermissionModeDropdown.js";
import { ContextRing } from "./ContextRing.js";

/**
 * In-composer option chips (Codex-style). Renders as a row meant to sit at the
 * *bottom* of the composer box, left-aligned, sharing a line with the send
 * button. Compact + muted so the textarea stays the focal point.
 *
 * - Model: dropdown (built-in + custom configs).
 * - Effort: dropdown (Auto → Max), same base-ui Menu style as Permission.
 * - Permission mode: dropdown showing the 4 user-facing modes.
 * - Context ring: occupancy indicator for the active session, pinned at the
 *   right end of the chip row (after Permission). Sits inline rather than
 *   overlapping the textarea, so it never covers typed text.
 */
export function ComposerToolbar() {
  // Context-window snapshot for the active session. Drives the ring at the
  // end of the chip row. Undefined until the first token-usage.updated event
  // arrives (or a persisted snapshot is hydrated from the session row).
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const contextSnapshot = useSessionStore((s) =>
    activeSessionId ? s.contextSnapshotBySession[activeSessionId] : undefined,
  );

  return (
    <div className="flex items-center gap-0.5">
      <ModelDropdown />
      <EffortDropdown />
      <PermissionModeDropdown />
      {contextSnapshot && (
        <span className="ml-1 inline-flex items-center border-l border-edge/60 pl-1.5">
          <ContextRing snapshot={contextSnapshot} />
        </span>
      )}
    </div>
  );
}
