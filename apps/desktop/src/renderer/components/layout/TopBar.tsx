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
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-surface px-3 text-sm">
      <span className="rounded bg-surface-muted px-2 py-1 text-xs text-content-muted">
        {activeProject ? `📁 ${activeProject.name}` : "No project"}
      </span>

      <div className="text-content-subtle">/</div>

      <span className="rounded bg-surface-muted px-2 py-1 text-xs text-content-muted">
        Claude
      </span>

      <div className="flex-1" />

      <button
        onClick={() => setSettingsOpen(true)}
        className="rounded px-2 py-1 text-content-subtle hover:bg-surface-muted hover:text-content-muted"
        title="Settings"
      >
        ⚙
      </button>
    </header>
  );
}
