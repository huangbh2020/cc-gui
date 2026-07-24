import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Left bar: project list, add-project, session list, start-session.
 * P1: real wiring to the session store. */
export function LeftBar() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const startSession = useSessionStore((s) => s.startSession);
  const selectSession = useSessionStore((s) => s.selectSession);

  const hasProject = activeProjectId !== null;

  return (
    <div className="flex flex-col gap-4 px-2 py-2 text-sm">
      <section>
        <div className="mb-1 flex items-center justify-between px-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Projects
          </h3>
          <button
            onClick={() => void addProject()}
            className="rounded px-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-emerald-400"
            title="Open a folder as a project"
          >
            + Add
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-600">
            No project yet.
            <br />
            <button
              onClick={() => void addProject()}
              className="mt-1 text-emerald-500 hover:underline"
            >
              Open a folder →
            </button>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {projects.map((p) => (
              <li
                key={p.id}
                className={`truncate rounded px-2 py-1 text-xs ${
                  p.id === activeProjectId
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800/50"
                }`}
                title={p.path}
              >
                📁 {p.name}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between px-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Sessions
          </h3>
          <button
            onClick={() => void startSession()}
            disabled={!hasProject}
            className="rounded px-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            title="Start a new chat session"
          >
            + New
          </button>
        </div>

        {!hasProject ? (
          <div className="px-1 text-xs text-zinc-600">Open a project first.</div>
        ) : sessions.length === 0 ? (
          <div className="px-1 text-xs text-zinc-600">No session yet.</div>
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li
                key={s.id}
                onClick={() => void selectSession(s.id)}
                className={`cursor-pointer truncate rounded px-2 py-1 text-xs ${
                  s.id === activeSessionId
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800/50"
                }`}
                title={s.title}
              >
                💬 {s.title}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Tasks
        </h3>
        <div className="px-1 text-xs text-zinc-600">
          Tasks from claude's TodoWrite will appear here.
        </div>
      </section>
    </div>
  );
}
