import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconMessage,
  IconChevronRight,
  IconPlus,
  IconCheck,
  IconDotsVertical,
  IconArrowRight,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Project, Session } from "@contracts/session";

/**
 * Left bar — a tree of projects → sessions, with archive (soft) / delete (hard)
 * on each node, plus a collapsible "archived" section at the bottom.
 *
 * Replaces the old two flat lists (Projects / Sessions) which had no project
 * switching and no lifecycle actions. Sessions are cached per-project in the
 * store (sessionsByProject), so expanding a project is instant.
 *
 * Layout sketch:
 *   EXPLORER                       [+ 添加项目]
 *   ▾ 📁 my-claude-gui          ⋯
 *       💬 P2会话持久化
 *       💬 自定义模型        ✓
 *   ▸ 📁 blog-site             ⋯
 *   ─────────────────────────────
 *   ▾ 已归档 (3)
 *       📁 old-project  [恢复] [删]
 *       💬 old-thread   [恢复] [删]
 */
export function LeftBar() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const expandedProjects = useSessionStore((s) => s.expandedProjects);
  const archivedViewOpen = useSessionStore((s) => s.archivedViewOpen);

  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const selectProject = useSessionStore((s) => s.selectProject);
  const toggleProjectExpanded = useSessionStore((s) => s.toggleProjectExpanded);
  const setArchivedViewOpen = useSessionStore((s) => s.setArchivedViewOpen);
  const startSession = useSessionStore((s) => s.startSession);
  // Use `openTab` rather than `selectSession` so the clicked thread is
  // added to the tab strip (in `tabs` mode) or simply activated (in
  // `single` mode). Both display modes share the same entry point; the
  // difference is whether SessionTabs is mounted above the center pane.
  const openTab = useSessionStore((s) => s.openTab);
  const deleteProject = useSessionStore((s) => s.deleteProject);
  const archiveProject = useSessionStore((s) => s.archiveProject);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const archiveSession = useSessionStore((s) => s.archiveSession);

  // Split into active vs archived. Active projects show in the tree; archived
  // ones (and archived sessions under active projects) show in the archived bin.
  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  // Archived sessions that live under NON-archived projects (an archived
  // project's sessions are already covered by showing the project itself).
  const archivedSessions: { session: Session; project: Project }[] = [];
  for (const p of activeProjects) {
    for (const s of sessionsByProject[p.id] ?? []) {
      if (s.archived) archivedSessions.push({ session: s, project: p });
    }
  }
  const archivedCount = archivedProjects.length + archivedSessions.length;

  return (
    <div className="flex h-full flex-col px-2 py-2 text-sm">
      {/* Header */}
      <div className="mb-1 flex items-center justify-between px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-content-subtle">
          Explorer
        </h3>
        <button
          onClick={() => void addProject()}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-content-muted transition-colors",
            "hover:bg-surface-muted hover:text-accent",
          )}
          title="打开一个文件夹作为项目"
        >
          <IconPlus size={12} />
          添加项目
        </button>
      </div>

      {/* Project → session tree */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="mt-6 rounded-md border border-dashed border-edge px-3 py-6 text-center text-xs text-content-subtle">
            还没有项目
            <br />
            <button
              onClick={() => void addProject()}
              className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
            >
              打开一个文件夹
              <IconArrowRight size={12} />
            </button>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {activeProjects.map((p) => (
              <ProjectNode
                key={p.id}
                project={p}
                sessions={sessionsByProject[p.id] ?? []}
                expanded={!!expandedProjects[p.id]}
                isActiveProject={p.id === activeProjectId}
                activeSessionId={activeSessionId}
                onToggleExpand={() => toggleProjectExpanded(p.id)}
                onClickProject={() => void selectProject(p.id)}
                onNewSession={() => void startSession(p.id)}
                onSelectSession={(sid) => void openTab(sid)}
                onArchive={() => void archiveProject(p.id, true)}
                onDelete={() => {
                  if (confirm(`删除项目「${p.name}」及其所有线程?此操作不可恢复。`)) {
                    void deleteProject(p.id);
                  }
                }}
                onArchiveSession={(sid) => void archiveSession(sid, true)}
                onDeleteSession={(s) => {
                  if (confirm(`删除线程「${s.title}」?此操作不可恢复。`)) {
                    void deleteSession(s.id);
                  }
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Archived bin */}
      {archivedCount > 0 && (
        <div className="mt-2 border-t border-edge pt-2">
          <button
            onClick={() => setArchivedViewOpen(!archivedViewOpen)}
            className={cn(
              "flex w-full items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide",
              "text-content-subtle transition-colors hover:bg-surface-muted/50",
            )}
          >
            <IconChevronRight
              size={12}
              className={cn(
                "shrink-0 transition-transform",
                archivedViewOpen && "rotate-90",
              )}
            />
            已归档 ({archivedCount})
          </button>
          {archivedViewOpen && (
            <ul className="mt-1 space-y-0.5">
              {archivedProjects.map((p) => (
                <ArchivedRow
                  key={p.id}
                  icon={<IconFolder size={14} className="opacity-60" />}
                  title={p.name}
                  onRestore={() => void archiveProject(p.id, false)}
                  onDelete={() => {
                    if (confirm(`彻底删除项目「${p.name}」及其所有线程?`)) {
                      void deleteProject(p.id);
                    }
                  }}
                />
              ))}
              {archivedSessions.map(({ session, project }) => (
                <ArchivedRow
                  key={session.id}
                  icon={<IconMessage size={14} className="opacity-60" />}
                  title={session.title}
                  subtitle={project.name}
                  onRestore={() => void archiveSession(session.id, false)}
                  onDelete={() => {
                    if (confirm(`彻底删除线程「${session.title}」?`)) {
                      void deleteSession(session.id);
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Project node (expandable, with its sessions nested) ── */

interface ProjectNodeProps {
  project: Project;
  sessions: Session[];
  expanded: boolean;
  isActiveProject: boolean;
  activeSessionId: string | null;
  onToggleExpand: () => void;
  onClickProject: () => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (session: Session) => void;
}

function ProjectNode(props: ProjectNodeProps) {
  const {
    project, sessions, expanded, isActiveProject, activeSessionId,
    onToggleExpand, onClickProject, onNewSession, onSelectSession,
    onArchive, onDelete, onArchiveSession, onDeleteSession,
  } = props;
  const activeSessions = sessions.filter((s) => !s.archived);

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-1 text-xs",
          isActiveProject
            ? "bg-surface-muted text-content"
            : "text-content-muted hover:bg-surface-muted/50",
        )}
      >
        {/* Expand / collapse toggle */}
        <button
          onClick={onToggleExpand}
          className="flex w-3 shrink-0 items-center justify-center text-content-subtle"
          title={expanded ? "折叠" : "展开"}
        >
          <IconChevronRight
            size={10}
            className={cn(
              "transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>

        {/* Project name → click to select */}
        <button
          onClick={onClickProject}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={project.path}
        >
          <IconFolder size={14} className="shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>

        {/* New session in this project */}
        <button
          onClick={onNewSession}
          className={cn(
            "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
            "hover:text-accent group-hover:opacity-100",
          )}
          title="在此项目下新建会话"
        >
          <IconPlus size={12} />
        </button>

        {/* Context menu (archive / delete) */}
        <NodeMenu
          items={[
            { label: "归档", onClick: onArchive },
            { label: "删除", danger: true, onClick: onDelete },
          ]}
        />
      </div>

      {expanded && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-edge/50 pl-2">
          {activeSessions.length === 0 ? (
            <li className="px-2 py-1 text-[11px] text-content-subtle">暂无线程</li>
          ) : (
            activeSessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onSelect={() => onSelectSession(s.id)}
                onArchive={() => onArchiveSession(s.id)}
                onDelete={() => onDeleteSession(s)}
              />
            ))
          )}
        </ul>
      )}
    </li>
  );
}

/* ── Session row (leaf) ── */

function SessionRow({
  session, active, onSelect, onArchive, onDelete,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      onClick={onSelect}
      className={cn(
        "group flex cursor-pointer items-center gap-1 rounded px-1 py-1 text-xs",
        active
          ? "bg-surface-muted text-content"
          : "text-content-muted hover:bg-surface-muted/50",
      )}
      title={session.title}
    >
      <IconMessage size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {active && <IconCheck size={12} className="shrink-0 text-accent" />}
      <NodeMenu
        items={[
          { label: "归档", onClick: onArchive },
          { label: "删除", danger: true, onClick: onDelete },
        ]}
      />
    </li>
  );
}

/* ── Archived row (restore + hard-delete actions inline) ── */

function ArchivedRow({
  icon, title, subtitle, onRestore, onDelete,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-1 rounded px-1 py-1 text-xs text-content-subtle",
        "hover:bg-surface-muted/50",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">
        {title}
        {subtitle && (
          <span className="ml-1 text-[10px] text-content-subtle/70">
            · {subtitle}
          </span>
        )}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onRestore(); }}
        className={cn(
          "shrink-0 rounded px-1 text-[10px] text-content-subtle transition-colors",
          "hover:text-accent",
        )}
        title="恢复到列表"
      >
        恢复
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className={cn(
          "shrink-0 rounded px-1 text-[10px] text-content-subtle transition-colors",
          "hover:text-danger",
        )}
        title="彻底删除"
      >
        删
      </button>
    </li>
  );
}

/* ── Hover context menu (base-ui Menu) ── */

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function NodeMenu({ items }: { items: MenuItem[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
          "hover:bg-surface-hover hover:text-content group-hover:opacity-100",
        )}
        title="更多操作"
      >
        <IconDotsVertical size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[80px] origin-top-right rounded-md border border-edge bg-surface-muted py-0.5 shadow-xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            {items.map((it) => (
              <Menu.Item
                key={it.label}
                className={cn(
                  "flex w-full cursor-pointer items-center px-2 py-1 text-left text-[11px] outline-none select-none",
                  "data-[highlighted]:bg-surface-hover",
                  it.danger ? "text-danger" : "text-content-muted",
                )}
                onClick={it.onClick}
              >
                {it.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
