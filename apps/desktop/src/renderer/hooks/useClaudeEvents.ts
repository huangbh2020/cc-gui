import { useEffect } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Subscribe to the main->renderer push channels for the app's lifetime.
 * Mount once, at the root. Routes each event into the session store.
 *
 * Two channels:
 *  - `claude:event` - the agent stream (assistant text, tool calls, turn
 *    boundaries, etc.) -> `ingestEvent`.
 *  - `session:titleUpdated` - the background auto title-gen routine overwrote
 *    a session's title in the DB; patch the in-memory lists -> `applySessionTitleUpdate`. */
export function useClaudeEvents(): void {
  const ingest = useSessionStore((s) => s.ingestEvent);
  const applySessionTitleUpdate = useSessionStore((s) => s.applySessionTitleUpdate);

  useEffect(() => {
    const off = api.on.claudeEvent((msg) => {
      ingest(msg.event);
    });
    return off;
  }, [ingest]);

  useEffect(() => {
    const off = api.on.sessionTitleUpdated((msg) => {
      applySessionTitleUpdate(msg.sessionId, msg.title);
    });
    return off;
  }, [applySessionTitleUpdate]);
}
