import { useEffect, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { GitRepo } from "@contracts/ipc";
import { GitRepoCard } from "./GitRepoCard.js";
import { IconGitBranch, IconLoader2, IconRefresh } from "@renderer/lib/icons.js";

/**
 * Git panel — the right-panel "Git" tab body.
 *
 * Discovers all git repositories under the active project's root (a project
 * folder may contain multiple repos: monorepo, submodules, nested projects).
 * Each repo gets its own independent {@link GitRepoCard} for status / stage /
 * commit / push / pull.
 *
 * The scan runs on mount and whenever the active project changes. A manual
 * refresh button re-scans (useful after cloning a new repo into the folder).
 */
export function GitPanel() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId)?.path ?? null;
  }, [activeProjectId, projects]);

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [loading, setLoading] = useState(true);

  const scan = async (path: string) => {
    setLoading(true);
    try {
      const { repos } = await api.git.discoverRepos({ projectPath: path });
      setRepos(repos);
    } catch {
      setRepos([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!projectPath) {
      setRepos([]);
      setLoading(false);
      return;
    }
    void scan(projectPath);
  }, [projectPath]);

  if (!projectPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconGitBranch size={20} className="text-content-subtle" />
        <p className="text-xs text-content-muted">还没有项目</p>
        <p className="text-[11px] text-content-subtle">添加项目后即可查看 Git 状态</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        扫描 Git 仓库…
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconGitBranch size={20} className="text-content-subtle" />
        <p className="text-xs text-content-muted">未找到 Git 仓库</p>
        <p className="text-[11px] text-content-subtle">
          在「{projectPath}」及其子目录(3 层内)未发现 .git 目录
        </p>
        <button
          type="button"
          onClick={() => void scan(projectPath)}
          className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-content-muted hover:bg-surface-hover"
        >
          <IconRefresh size={11} /> 重新扫描
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: repo count + refresh. */}
      <div className="flex shrink-0 items-center justify-between border-b border-edge px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">
          {repos.length} 个仓库
        </span>
        <button
          type="button"
          onClick={() => void scan(projectPath)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          title="重新扫描仓库"
        >
          <IconRefresh size={12} />
        </button>
      </div>
      {/* Scrollable list of repo cards. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="space-y-2">
          {repos.map((repo) => (
            <GitRepoCard key={repo.path} repo={repo} />
          ))}
        </div>
      </div>
    </div>
  );
}
