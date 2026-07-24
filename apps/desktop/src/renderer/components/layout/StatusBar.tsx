import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Bottom status bar: claude status, active model/effort/mode, run state.
 * Mirrors the per-session settings chosen in the composer so they're always
 * visible at a glance. */
const MODEL_LABEL: Record<string, string> = {
  default: "Auto",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
};
const MODE_LABEL: Record<string, string> = { default: "Default", plan: "Plan", acceptEdits: "Edits" };

export function StatusBar() {
  const isRunning = useSessionStore((s) => s.isRunning);
  const installed = useSessionStore((s) => s.claudeInstalled);
  const model = useSessionStore((s) => s.model);
  const effort = useSessionStore((s) => s.effort);
  const permissionMode = useSessionStore((s) => s.permissionMode);

  const statusColor = installed === false ? "text-red-500" : installed === true ? "text-emerald-500" : "text-zinc-500";
  const statusText = installed === false ? "claude not found" : installed === true ? "claude ready" : "checking claude…";

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-pane-border bg-zinc-900 px-3 text-[11px] text-zinc-500">
      <span className={statusColor}>●</span>
      <span className={installed === false ? "text-red-400" : ""}>{statusText}</span>

      <span className="text-zinc-700">·</span>
      <span className="text-zinc-400">{MODEL_LABEL[model] ?? model}</span>
      {effort !== "default" && <span className="text-violet-400">{effort}</span>}
      <span className="text-zinc-700">·</span>
      <span className={permissionMode !== "default" ? "text-amber-400" : "text-zinc-400"}>
        {MODE_LABEL[permissionMode] ?? permissionMode}
      </span>

      <div className="flex-1" />

      {isRunning && (
        <span className="flex items-center gap-1 text-amber-400">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          working
        </span>
      )}
      {!isRunning && <span className="text-zinc-600">ready</span>}
    </footer>
  );
}
