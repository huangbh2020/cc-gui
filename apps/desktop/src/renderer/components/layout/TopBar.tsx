import { useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { PermissionMode } from "@contracts/runtime";

/** Top bar: active project name, model, plan-mode toggle.
 * P1: shows the active project; plan-mode toggle is display-only for now
 * (P3 wires it into startSession's permissionMode). */
export function TopBar() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const [planMode, setPlanMode] = useState(false);

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const mode: PermissionMode = planMode ? "plan" : "default";

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-pane-border bg-zinc-900 px-3 text-sm">
      <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
        {activeProject ? `📁 ${activeProject.name}` : "No project"}
      </span>

      <div className="text-zinc-600">/</div>

      <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400">
        Claude
      </span>

      <div className="flex-1" />

      <button
        onClick={() => setPlanMode((v) => !v)}
        className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
          planMode
            ? "bg-amber-600 text-amber-50"
            : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
        }`}
        title={`Permission mode: ${mode}`}
      >
        {planMode ? "⚡ Plan mode" : "Plan"}
      </button>

      <button
        className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        title="Settings (P6)"
      >
        ⚙
      </button>
    </header>
  );
}
