import { useEffect } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Subscribe to the main→renderer claude event stream for the app's lifetime.
 * Mount once, at the root. Routes each event into the session store. */
export function useClaudeEvents(): void {
  const ingest = useSessionStore((s) => s.ingestEvent);

  useEffect(() => {
    const off = api.on.claudeEvent((msg) => {
      ingest(msg.event);
    });
    return off;
  }, [ingest]);
}
