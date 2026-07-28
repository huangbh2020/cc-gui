import { useMemo } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { FileTree } from "./FileTree.js";
import { IconFolderPlus } from "@renderer/lib/icons.js";

/**
 * Files panel — the right-panel "Files" tab body.
 *
 * This is a **pure file tree** navigator. Clicking a file opens it in the
 * CENTER pane's editor column (via openFileInIde → App.tsx renders the
 * editor beside the chat), NOT here. This keeps the right panel as a
 * navigation surface and the center pane as the working surface, matching
 * VS Code's explorer/editor split.
 *
 * The tree is scoped to the active project's root path; if no project is
 * active, an empty state is shown.
 */
export function FilesPanel() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

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
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* Keyed on projectPath so switching projects fully remounts the tree
            (clears stale expanded state / cached children). */}
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
