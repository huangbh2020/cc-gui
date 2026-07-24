import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Top bar: active project name + settings. The permission-mode toggle moved
 * to the composer toolbar (ComposerToolbar) since it's a per-session option
 * grouped with model/effort there. */
export function TopBar() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  const activeProject = projects.find((p) => p.id === activeProjectId);

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
        onClick={() => setSettingsOpen(true)}
        className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        title="Settings"
      >
        ⚙
      </button>
    </header>
  );
}
