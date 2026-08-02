import { useMemo } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { FileTree } from "./FileTree.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolderPlus,
  IconSearch,
} from "@renderer/lib/icons.js";

/**
 * Files panel - the right-panel "Files" tab body.
 *
 * A pure file-tree navigator with a single search affordance: a header button
 * that opens the project-wide search dialog ({@link SearchDialog}), which
 * supports both file-name and file-content search. The search UI itself lives
 * in the modal (VS Code global-search style) so the tree gets the full panel
 * height when not searching.
 *
 * Clicking any file in the tree opens it in the CENTER pane's editor column
 * (via openFileInIde -> App.tsx), NOT here. This keeps the right panel as a
 * navigation surface and the center pane as the working surface, matching VS
 * Code's explorer/editor split.
 *
 * The tree is scoped to the active project's root path; if no project is
 * active, an empty state is shown.
 */
export function FilesPanel() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const setSearchDialogOpen = useSessionStore((s) => s.setSearchDialogOpen);

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    const proj = projects.find((p) => p.id === activeProjectId);
    return proj?.path ?? null;
  }, [activeProjectId, projects]);

  if (!projectPath) {
    return <EmptyState />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Compact header: "文件" label on the left, a search button on the right
          that opens the project-wide search dialog. Replaces the old inline
          search row so the tree gets the full panel height. */}
      <div className="flex shrink-0 items-center justify-between border-b border-edge px-2 py-1.5">
        <span className="px-1 text-[12px] font-medium text-content-muted">文件</span>
        <button
          type="button"
          onClick={() => setSearchDialogOpen(true)}
          title="搜索文件（⌘⇧F）"
          aria-label="搜索文件"
          className={cn(
            "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
          )}
        >
          <IconSearch size={14} />
        </button>
      </div>

      {/* Body: the lazily-loaded directory tree, scoped to the active project.
          Keyed on projectPath so switching projects fully remounts (clears
          stale expanded state / cached children). */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <FileTree key={projectPath} projectPath={projectPath} />
      </div>
    </div>
  );
}

/** Empty state shown when no project is active. Points the user at the
 *  left-bar's add-project affordance. */
function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-content-subtle">
        <IconFolderPlus size={20} />
      </div>
      <p className="text-xs font-medium text-content-muted">还没有项目</p>
      <p className="text-[11px] leading-relaxed text-content-subtle">
        在左侧栏添加一个项目文件夹后,即可在此浏览文件
      </p>
    </div>
  );
}
