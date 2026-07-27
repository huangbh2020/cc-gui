import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconMessage,
  IconChevronRight,
  IconPlus,
  IconArchive,
  IconTrash,
  IconLoader2,
  IconSettings,
  IconCheck,
  IconX,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Project, Session } from "@contracts/session";

/**
 * Left bar — a tree of projects → sessions, with archive (soft) / delete (hard)
 * icon buttons revealed on hover for every row, plus a collapsible "archived"
 * section at the bottom grouped by project.
 *
 * Sessions are paginated: only the first SESSION_PAGE_SIZE (5) threads load
 * per project, and a "加载更多" button under the list appends the next page.
 *
 * Replaces the old two flat lists (Projects / Sessions) which had no project
 * switching and no lifecycle actions. Sessions are cached per-project in the
 * store (sessionsByProject = active page slice, archivedSessionsByProject =
 * unpaginated archived rows), so expanding a project is instant.
 *
 * Layout sketch:
 *   EXPLORER                       [+ 添加项目]
 *   ▾ 📁 my-claude-gui         + 🗑
 *       💬 P2会话持久化         📦 🗑
 *       💬 自定义模型     ✓    📦 🗑
 *       加载更多（还有 3 条）
 *   ▸ 📁 blog-site             + 🗑
 *   ─────────────────────────────
 *   ▾ 已归档 (4)
 *       📁 old-project     [恢复] [删]
 *       📁 side-project
 *         💬 old-thread       [恢复] [删]
 *   ─────────────────────────────
 *   ⚙ 设置
 */
export function LeftBar() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const sessionsHasMoreByProject = useSessionStore((s) => s.sessionsHasMoreByProject);
  const sessionsTotalByProject = useSessionStore((s) => s.sessionsTotalByProject);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const expandedProjects = useSessionStore((s) => s.expandedProjects);
  const archivedViewOpen = useSessionStore((s) => s.archivedViewOpen);

  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const toggleProjectExpanded = useSessionStore((s) => s.toggleProjectExpanded);
  const setArchivedViewOpen = useSessionStore((s) => s.setArchivedViewOpen);
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions);
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
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const runningBySession = useSessionStore((s) => s.runningBySession);

  // Split into active vs archived. Active projects show in the tree;
  // archived projects (whole-project archive) show as their own rows in
  // the archived bin, while archived SESSIONS under still-active projects
  // are grouped by their parent project in the bin.
  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  // Archived sessions grouped by their (still-active) parent project, in
  // the same project order as the tree above. Empty groups are skipped.
  const archivedGroups = activeProjects
    .map((p) => ({ project: p, sessions: archivedSessionsByProject[p.id] ?? [] }))
    .filter((g) => g.sessions.length > 0);
  const archivedCount = archivedProjects.length + archivedGroups.reduce((n, g) => n + g.sessions.length, 0);

  return (
    <div className="flex h-full flex-col px-2 py-2 text-sm">
      {/* Header */}
      <div className="group mb-1 flex items-center justify-between px-1">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-content-subtle">
          项目
        </h3>
        <button
          onClick={() => void addProject()}
          className={cn(
            "flex items-center rounded px-1 py-0.5 text-content-muted transition-all",
            // Always visible when there are no projects so the user has a
            // clear entry point to add one (no empty placeholder row anymore).
            projects.length === 0
              ? "opacity-100 hover:text-accent"
              : "opacity-0 hover:text-accent group-hover:opacity-100",
          )}
          title="打开一个文件夹作为项目"
        >
          <IconPlus size={12} />
        </button>
      </div>

      {/* Project → session tree */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects.length === 0 ? null : (
          <ul className="space-y-0.5">
            {activeProjects.map((p) => (
              <ProjectNode
                key={p.id}
                project={p}
                sessions={sessionsByProject[p.id] ?? []}
                hasMore={!!sessionsHasMoreByProject[p.id]}
                total={sessionsTotalByProject[p.id] ?? 0}
                expanded={!!expandedProjects[p.id]}
                isActiveProject={p.id === activeProjectId}
                activeSessionId={activeSessionId}
                runningBySession={runningBySession}
                onToggleExpand={() => toggleProjectExpanded(p.id)}
                onNewSession={() => void startSession(p.id)}
                onLoadMore={() => void loadMoreSessions(p.id)}
                onSelectSession={(sid) => void openTab(sid)}
                onDelete={() => {
                  if (confirm(`删除项目「${p.name}」及其所有线程?此操作不可恢复。`)) {
                    void deleteProject(p.id);
                  }
                }}
                onArchiveSession={(sid) => void archiveSession(sid, true)}
                onDeleteSession={(s) => void deleteSession(s.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Archived bin — archived projects first, then archived sessions
          grouped by their parent project. */}
      {archivedCount > 0 && (
        <div className="mt-2 border-t border-edge pt-2">
          <button
            onClick={() => setArchivedViewOpen(!archivedViewOpen)}
            className={cn(
              "flex w-full items-center gap-1 rounded px-1 py-0.5 text-[13px] font-medium uppercase tracking-wide",
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
              {archivedGroups.map(({ project, sessions }) => (
                <li key={project.id} className="mt-0.5">
                  {/* Group header: parent project name (non-interactive). */}
                  <div className="flex items-center gap-1 px-1 py-0.5 text-[13px] text-content-subtle">
                    <IconFolder size={12} className="opacity-50" />
                    <span className="truncate">{project.name}</span>
                  </div>
                  <ul className="ml-3 space-y-0.5 border-l border-edge/50 pl-2">
                    {sessions.map((s) => (
                      <ArchivedRow
                        key={s.id}
                        icon={<IconMessage size={14} className="opacity-60" />}
                        title={s.title}
                        onRestore={() => void archiveSession(s.id, false)}
                        onDelete={() => {
                          if (confirm(`彻底删除线程「${s.title}」?`)) {
                            void deleteSession(s.id);
                          }
                        }}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Settings — entry moved here from the (removed) TopBar header.
          Docked to the bottom of the left rail so it's always reachable
          regardless of how far the project list scrolls. */}
      <div className="mt-2 shrink-0 border-t border-edge pt-1.5">
        <button
          onClick={() => setSettingsOpen(true)}
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-content-muted transition-colors",
            "hover:bg-surface-muted hover:text-content",
          )}
          title="设置"
        >
          <IconSettings size={14} className="shrink-0" />
          设置
        </button>
      </div>
    </div>
  );
}

/* ── Project node (expandable, with its sessions nested) ── */

interface ProjectNodeProps {
  project: Project;
  sessions: Session[];
  hasMore: boolean;
  total: number;
  expanded: boolean;
  isActiveProject: boolean;
  activeSessionId: string | null;
  runningBySession: Record<string, boolean>;
  onToggleExpand: () => void;
  onNewSession: () => void;
  onLoadMore: () => void;
  onSelectSession: (sessionId: string) => void;
  onDelete: () => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (session: Session) => void;
}

function ProjectNode(props: ProjectNodeProps) {
  const {
    project, sessions, hasMore, total, expanded, isActiveProject, activeSessionId,
    runningBySession,
    onToggleExpand, onNewSession, onLoadMore, onSelectSession,
    onDelete, onArchiveSession, onDeleteSession,
  } = props;
  const loaded = sessions.length;

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-1 text-sm",
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

        {/* Project name → click toggles expand/collapse (matches chevron) */}
        <button
          onClick={onToggleExpand}
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

        {/* Delete — inline on hover (projects cannot be archived, only removed). */}
        <HoverIconButton onClick={onDelete} title="删除" danger>
          <IconTrash size={13} />
        </HoverIconButton>
      </div>

      {expanded && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-edge/50 pl-2">
          {loaded === 0 ? (
            <li className="px-2 py-1 text-[13px] text-content-subtle">暂无线程</li>
          ) : (
            sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                isRunning={!!runningBySession[s.id]}
                onSelect={() => onSelectSession(s.id)}
                onArchive={() => onArchiveSession(s.id)}
                onDelete={() => onDeleteSession(s)}
              />
            ))
          )}
          {hasMore && (
            <li>
              <button
                onClick={onLoadMore}
                className={cn(
                  "w-full rounded px-2 py-1 text-left text-[13px] text-content-subtle transition-colors",
                  "hover:bg-surface-muted/50 hover:text-accent",
                )}
              >
                加载更多{total > 0 ? `（还有 ${Math.max(total - loaded, 0)} 条）` : ""}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/* ── Session row (leaf) ── */

function SessionRow({
  session, active, isRunning, onSelect, onArchive, onDelete,
}: {
  session: Session;
  active: boolean;
  isRunning: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [pendingConfirm, setPendingConfirm] = useState<null | "archive" | "delete">(null);

  const handleRowClick = () => {
    setPendingConfirm(null);
    onSelect();
  };

  return (
    <li
      onClick={handleRowClick}
      className={cn(
        "group flex cursor-pointer items-center gap-1 rounded-md px-1 py-1 text-sm",
        active
          ? "bg-surface-hover text-content shadow-sm ring-1 ring-accent/35"
          : "text-content-muted hover:bg-surface-muted/50",
      )}
      title={session.title}
    >
      <IconMessage size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>

      {/* Inline confirm — shown after the first click on archive or delete.
          Two icons replace the normal single-action button: a confirm check
          and a cancel X. The actual action only fires on the second click
          (confirm). Clicking anywhere else dismisses the pending state. */}
      {pendingConfirm === "archive" && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); onArchive(); }}
            className="flex shrink-0 items-center rounded px-1 text-accent hover:bg-surface-hover"
            title="确认归档"
          >
            <IconCheck size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); }}
            className="flex shrink-0 items-center rounded px-1 text-content-subtle hover:bg-surface-hover hover:text-content"
            title="取消"
          >
            <IconX size={13} />
          </button>
        </>
      )}
      {pendingConfirm === "delete" && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); onDelete(); }}
            className="flex shrink-0 items-center rounded px-1 text-danger hover:bg-surface-hover"
            title="确认删除"
          >
            <IconCheck size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); }}
            className="flex shrink-0 items-center rounded px-1 text-content-subtle hover:bg-surface-hover hover:text-content"
            title="取消"
          >
            <IconX size={13} />
          </button>
        </>
      )}

      {/* Normal action buttons — hidden on running threads (no hover actions
          while the turn is in flight, keeping the row clean). */}
      {!isRunning && pendingConfirm === null && (
        <>
          <HoverIconButton
            onClick={() => { setPendingConfirm("archive"); }}
            title="归档"
          >
            <IconArchive size={13} />
          </HoverIconButton>
          <HoverIconButton
            onClick={() => { setPendingConfirm("delete"); }}
            title="删除"
            danger
          >
            <IconTrash size={13} />
          </HoverIconButton>
        </>
      )}

      {/* Running spinner — always visible at the far right when a turn is live. */}
      {isRunning && (
        <IconLoader2
          size={12}
          className="shrink-0 animate-spin text-accent"
        />
      )}
    </li>
  );
}

/* ── Hover-revealed inline icon button (archive / delete) ── */

function HoverIconButton({
  onClick, title, danger, children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
        "hover:bg-surface-hover group-hover:opacity-100",
        danger ? "hover:text-danger" : "hover:text-content",
      )}
      title={title}
    >
      {children}
    </button>
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
        "flex items-center gap-1 rounded px-1 py-1 text-sm text-content-subtle",
        "hover:bg-surface-muted/50",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">
        {title}
        {subtitle && (
          <span className="ml-1 text-[12px] text-content-subtle/70">
            · {subtitle}
          </span>
        )}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onRestore(); }}
        className={cn(
          "shrink-0 rounded px-1 text-[12px] text-content-subtle transition-colors",
          "hover:text-accent",
        )}
        title="恢复到列表"
      >
        恢复
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className={cn(
          "shrink-0 rounded px-1 text-[12px] text-content-subtle transition-colors",
          "hover:text-danger",
        )}
        title="彻底删除"
      >
        删
      </button>
    </li>
  );
}
