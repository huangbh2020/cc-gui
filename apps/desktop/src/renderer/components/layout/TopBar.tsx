import { useState } from "react";
import type { PermissionMode } from "@contracts/runtime";

/** Top bar: project switcher, model selector, plan-mode toggle, settings.
 * P0 renders static placeholders; P2 wires these to the session store. */
export function TopBar() {
  const [project, setProject] = useState("No project");
  const [model] = useState("default");
  const [planMode, setPlanMode] = useState(false);

  const mode: PermissionMode = planMode ? "plan" : "default";

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-pane-border bg-zinc-900 px-3 text-sm">
      {/* Project switcher (P2: dropdown of projects) */}
      <select
        value={project}
        onChange={(e) => setProject(e.target.value)}
        className="rounded bg-zinc-800 px-2 py-1 text-zinc-200 outline-none hover:bg-zinc-700"
      >
        <option>No project</option>
      </select>

      <div className="text-zinc-600">/</div>

      {/* Model indicator (P2: real model list) */}
      <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400">
        Claude: {model}
      </span>

      <div className="flex-1" />

      {/* Plan-mode toggle — maps to claude's --permission-mode plan */}
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
