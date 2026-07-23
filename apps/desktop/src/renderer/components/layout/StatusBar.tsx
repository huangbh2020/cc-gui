import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Bottom status bar: claude install status, run state. */
export function StatusBar() {
  const isRunning = useSessionStore((s) => s.isRunning);
  const installed = useSessionStore((s) => s.claudeInstalled);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-pane-border bg-zinc-900 px-3 text-[11px] text-zinc-500">
      <span className={installed === false ? "text-red-500" : "text-emerald-500"}>
        {installed === false ? "●" : "●"}
      </span>
      <span>
        claude: {installed === false ? "not found" : installed === true ? "ready" : "checking…"}
      </span>
      <div className="flex-1" />
      <span className={isRunning ? "text-amber-400" : "text-zinc-500"}>
        {isRunning ? "working…" : "ready"}
      </span>
    </footer>
  );
}
