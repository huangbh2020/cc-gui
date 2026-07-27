import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Session } from "@contracts/session";

/** Tab strip rendered along the top of the center pane in `tabs` display
 *  mode. Each open tab shows the session's title, a tiny running indicator
 *  (dot that pulses when the session has a turn in flight), and a close
 *  button. Clicking the tab body activates it; the × button removes it
 *  from the strip (the session's in-flight turn is NOT cancelled — see
 *  `closeTab` in the store).
 *
 *  Only renders anything when the store's `openTabs` list is non-empty.
 *  In `single` displayMode this component is never mounted (the
 *  CenterPane router in App.tsx gates it). */
export function SessionTabs() {
  const tabs = useSessionStore((s) => s.openTabs);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const closeTab = useSessionStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-edge bg-surface/40 px-2 pt-1.5">
      {tabs.map((id) => {
        const sess = findSession(sessionsByProject, id);
        const isActive = id === activeId;
        const running = !!runningBySession[id];
        return (
          <Tab
            key={id}
            session={sess}
            sessionId={id}
            isActive={isActive}
            running={running}
            onActivate={() => void selectSession(id)}
            onClose={(e) => {
              // Prevent the tab body click from also firing.
              e.stopPropagation();
              closeTab(id);
            }}
          />
        );
      })}
    </div>
  );
}

interface TabProps {
  session: Session | undefined;
  sessionId: string;
  isActive: boolean;
  running: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
}

function Tab({ session, isActive, running, onActivate, onClose }: TabProps) {
  const title = session?.title ?? "(unknown)";
  return (
    <button
      onClick={onActivate}
      className={`group flex max-w-[200px] min-w-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[11px] transition-colors ${
        isActive
          ? "border-accent bg-surface text-content"
          : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content"
      }`}
      title={title}
    >
      {/* Running indicator: solid dot when active+idle, pulsing when turn
          in flight. Uses Tailwind's animate-pulse so the user can see at a
          glance which background tabs are still working. */}
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
          running
            ? "bg-accent animate-pulse"
            : isActive
              ? "bg-accent/70"
              : "bg-content-subtle/50"
        }`}
      />
      <span className="truncate">{title}</span>
      <span
        role="button"
        aria-label="Close tab"
        onClick={onClose}
        className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-0 hover:bg-surface-hover hover:text-content group-hover:opacity-100"
      >
        ×
      </span>
    </button>
  );
}

/** Find a session across the per-project cache by id. Returns undefined
 *  if the cache hasn't been populated yet (init race) or the id is
 *  unknown. */
function findSession(
  sessionsByProject: Record<string, Session[]>,
  id: string,
): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    if (!list) continue;
    const hit = list.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}
