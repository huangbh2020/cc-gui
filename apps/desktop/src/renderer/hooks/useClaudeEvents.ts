import { useEffect } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Subscribe to the main->renderer push channels for the app's lifetime.
 * Mount once, at the root. Routes each event into the session store.
 *
 * Three channel groups:
 *  - `claude:event` - the agent stream (assistant text, tool calls, turn
 *    boundaries, etc.) -> `ingestEvent`.
 *  - `session:titleUpdated` - the background auto title-gen routine overwrote
 *    a session's title in the DB; patch the in-memory lists -> `applySessionTitleUpdate`.
 *  - `window:focusChanged` + `visibilitychange` - the app gained/lost focus or
 *    the tab was hidden/shown. Fed into `setWindowFocused` so the notification
 *    layer knows whether a background event warrants an OS notification. */
export function useClaudeEvents(): void {
  const ingest = useSessionStore((s) => s.ingestEvent);
  const applySessionTitleUpdate = useSessionStore((s) => s.applySessionTitleUpdate);
  const setWindowFocused = useSessionStore((s) => s.setWindowFocused);
  const openTab = useSessionStore((s) => s.openTab);

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

  // Window focus (Electron-level: app switch / minimize / restore).
  useEffect(() => {
    const off = api.on.windowFocusChanged((msg) => {
      // When the window is focused, the visible tab is by definition "seen".
      // document.hidden is the complementary signal for tab-hide in browsers,
      // but in Electron the focus event already covers the common cases.
      setWindowFocused(msg.focused);
    });
    return off;
  }, [setWindowFocused]);

  // Document visibility (renderer-level: the webContents is the active tab
  // in its OS window). On macOS this fires when the window is fully occluded
  // by another window even without an app switch. Combined with the Electron
  // focus signal above, this gives us a reliable "is the user looking?" read.
  useEffect(() => {
    const onVis = () => setWindowFocused(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    // Seed the initial state.
    setWindowFocused(!document.hidden);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [setWindowFocused]);

  // OS notification click - main has already focused the window; navigate to
  // the session that generated the notification.
  useEffect(() => {
    const off = api.on.notificationFocusSession((msg) => {
      void openTab(msg.sessionId);
    });
    return off;
  }, [openTab]);
}
