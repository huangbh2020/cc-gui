import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import type { GitRepo, GitStatusResult, GitFileStatus } from "@contracts/ipc";
import {
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
  IconGitCommit,
  IconArrowUp,
  IconArrowDown,
  IconRefresh,
  IconLoader2,
  IconAlertTriangle,
  IconCheck,
} from "@renderer/lib/icons.js";
import { DiffView } from "../chat/DiffView.js";
import { lineDiff } from "@renderer/lib/lineDiff.js";

/**
 * One git repository's card in the Git panel. Shows:
 *  - Header: repo name + branch + ahead/behind badges + Push/Pull/Refresh.
 *  - File list: staged and unstaged files with checkboxes for selection.
 *  - Commit box: message input + commit button (commits selected files).
 *  - Per-file diff: click a file to expand its inline diff.
 *
 * All state is local to this card — multiple cards operate independently.
 * Operations (stage/unstage/commit/push/pull) call the git IPC, then refresh
 * the status.
 */
export function GitRepoCard({ repo }: { repo: GitRepo }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Selected file paths (relative to repo) for staging/committing.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<"push" | "pull" | "commit" | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { status } = await api.git.status({ repoPath: repo.path });
      setStatus(status);
      // Prune selection: drop files that are no longer in the status.
      setSelected((prev) => {
        const current = new Set(status.files.map((f) => f.path));
        const next = new Set<string>();
        for (const p of prev) if (current.has(p)) next.add(p);
        return next;
      });
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [repo.path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleStage = async () => {
    const files = [...selected];
    if (files.length === 0) return;
    setBusy("commit");
    try {
      const res = await api.git.stage({ repoPath: repo.path, filePaths: files });
      if (!res.ok) setError(res.error ?? "暂存失败");
      else setSelected(new Set());
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const handleCommit = async () => {
    const msg = commitMsg.trim();
    if (!msg) return;
    setBusy("commit");
    try {
      const res = await api.git.commit({ repoPath: repo.path, message: msg });
      if (!res.ok) {
        setError(res.error ?? "提交失败");
      } else {
        setCommitMsg("");
        setError(null);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const handlePush = async () => {
    setBusy("push");
    setError(null);
    try {
      const res = await api.git.push({ repoPath: repo.path });
      if (!res.ok) setError(res.error ?? "推送失败");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const handlePull = async () => {
    setBusy("pull");
    setError(null);
    try {
      const res = await api.git.pull({ repoPath: repo.path });
      if (!res.ok) setError(res.error ?? "拉取失败");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  // Split files into staged (index changed) and unstaged (working tree changed).
  const staged = status?.files.filter((f) => f.index !== "unmodified" && f.index !== "untracked") ?? [];
  const unstaged = status?.files.filter(
    (f) => f.workingTree !== "unmodified" || f.index === "untracked",
  ) ?? [];
  const hasStaged = staged.length > 0;
  const hasUnstaged = unstaged.length > 0;

  return (
    <div className="rounded-lg border border-edge bg-surface">
      {/* Header: repo name + branch + actions. */}
      <div className="flex items-center gap-2 border-b border-edge px-2.5 py-1.5">
        <IconGitBranch size={13} className="shrink-0 text-content-subtle" />
        <span className="truncate text-[11px] font-medium text-content" title={repo.path}>
          {repo.name}
        </span>
        {status?.branch && (
          <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
            {status.branch}
          </span>
        )}
        {/* Ahead/behind badges. */}
        {status && status.ahead > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-accent" title="领先上游">
            <IconArrowUp size={10} />
            {status.ahead}
          </span>
        )}
        {status && status.behind > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-info" title="落后上游">
            <IconArrowDown size={10} />
            {status.behind}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <ActionButton
            onClick={handlePull}
            disabled={busy !== null || loading}
            busy={busy === "pull"}
            title="拉取 (Pull)"
          >
            <IconArrowDown size={12} />
          </ActionButton>
          <ActionButton
            onClick={handlePush}
            disabled={busy !== null || loading}
            busy={busy === "push"}
            title="推送 (Push)"
          >
            <IconArrowUp size={12} />
          </ActionButton>
          <ActionButton onClick={refresh} disabled={busy !== null} title="刷新状态">
            <IconRefresh size={12} />
          </ActionButton>
        </div>
      </div>

      {/* Error banner. */}
      {error && (
        <div className="flex items-start gap-1.5 border-b border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* Body: file lists + commit box. */}
      <div className="p-2">
        {loading && !status ? (
          <div className="flex items-center gap-1.5 py-2 text-[11px] text-content-subtle">
            <IconLoader2 size={12} className="animate-spin" />
            读取状态…
          </div>
        ) : !status || (status.files.length === 0 && !hasStaged) ? (
          <div className="flex items-center gap-1.5 py-2 text-[11px] text-content-subtle">
            <IconCheck size={12} className="text-accent" />
            工作区干净
          </div>
        ) : (
          <>
            {/* Unstaged changes — selectable for staging. */}
            {hasUnstaged && (
              <FileGroup
                label="更改"
                files={unstaged}
                selected={selected}
                onToggle={toggleSelect}
                repoPath={repo.path}
              />
            )}
            {/* Stage button — stages all selected unstaged files. */}
            {hasUnstaged && selected.size > 0 && (
              <button
                type="button"
                onClick={handleStage}
                disabled={busy !== null}
                className="mb-2 mt-1 flex w-full items-center justify-center gap-1 rounded-md bg-surface-hover py-1 text-[11px] text-content transition-colors hover:bg-edge disabled:opacity-50"
              >
                {busy === "commit" ? <IconLoader2 size={11} className="animate-spin" /> : <IconCheck size={11} />}
                暂存 {selected.size} 个文件
              </button>
            )}
            {/* Staged changes — display only (will be committed). */}
            {hasStaged && (
              <FileGroup label="已暂存" files={staged} selected={new Set()} onToggle={() => {}} repoPath={repo.path} staged />
            )}
            {/* Commit box — only when there are staged changes. */}
            {hasStaged && (
              <div className="mt-2 flex gap-1.5">
                <input
                  type="text"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && commitMsg.trim() && busy === null) {
                      void handleCommit();
                    }
                  }}
                  placeholder="提交信息…"
                  disabled={busy !== null}
                  className="min-w-0 flex-1 rounded-md border border-edge-input bg-surface px-2 py-1 text-[11px] text-content outline-none focus:border-accent disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={!commitMsg.trim() || busy !== null}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] text-surface transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle"
                >
                  {busy === "commit" ? <IconLoader2 size={11} className="animate-spin" /> : <IconGitCommit size={11} />}
                  提交
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── action button ───────────────────────── */

function ActionButton({
  children,
  onClick,
  disabled,
  busy,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded text-content-muted transition-colors",
        "hover:bg-surface-hover hover:text-content disabled:opacity-40",
      )}
    >
      {busy ? <IconLoader2 size={12} className="animate-spin" /> : children}
    </button>
  );
}

/* ───────────────────────── file group ───────────────────────── */

function FileGroup({
  label,
  files,
  selected,
  onToggle,
  repoPath,
  staged,
}: {
  label: string;
  files: GitFileStatus[];
  selected: Set<string>;
  onToggle: (path: string) => void;
  repoPath: string;
  staged?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={cn("mb-2", staged && "mb-2")}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-content-subtle"
      >
        {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
        {label} ({files.length})
      </button>
      {!collapsed && (
        <div className="space-y-0.5">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              selected={selected.has(f.path)}
              onToggle={() => onToggle(f.path)}
              repoPath={repoPath}
              staged={staged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── file row + diff ───────────────────────── */

function FileRow({
  file,
  selected,
  onToggle,
  repoPath,
  staged,
}: {
  file: GitFileStatus;
  selected: boolean;
  onToggle: () => void;
  repoPath: string;
  staged?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  // The "effective" status for display: prefer the working-tree status for
  // unstaged files, the index status for staged files.
  const code = staged ? file.index : file.workingTree;

  return (
    <div>
      <div className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-hover/40">
        {/* Checkbox (only for unstaged/selectable files). */}
        {!staged && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="h-3 w-3 shrink-0 accent-[var(--accent)]"
          />
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={expanded ? "收起 diff" : "展开 diff"}
        >
          <StatusCodeIcon code={code} />
          <span className="truncate font-mono text-[11px] text-content-muted">{file.path}</span>
        </button>
        {expanded && (
          <IconChevronDown size={10} className="shrink-0 text-content-subtle" />
        )}
        {!expanded && (
          <IconChevronRight size={10} className="shrink-0 text-content-subtle" />
        )}
      </div>
      {expanded && <FileDiff repoPath={repoPath} filePath={file.path} />}
    </div>
  );
}

/** Colored status code badge: M=modified, A=added, D=deleted, ?=untracked. */
function StatusCodeIcon({ code }: { code: GitFileStatus["index"] }) {
  const label =
    code === "modified" ? "M" :
    code === "added" ? "A" :
    code === "deleted" ? "D" :
    code === "untracked" ? "?" :
    code === "renamed" ? "R" :
    code === "copied" ? "C" : "·";
  const color =
    code === "added" || code === "untracked" ? "text-accent" :
    code === "modified" || code === "renamed" || code === "copied" ? "text-warning" :
    code === "deleted" ? "text-danger" : "text-content-subtle";
  return (
    <span className={cn("w-3 shrink-0 text-center font-mono text-[10px] font-bold", color)} title={code}>
      {label}
    </span>
  );
}

/** Lazy-loaded diff for a single file. Fetches the unstaged patch via IPC,
 *  parses it into line-level hunks for DiffView. */
function FileDiff({ repoPath, filePath }: { repoPath: string; filePath: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [patch, setPatch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    api.git
      .diff({ repoPath, filePath })
      .then(({ patch }) => {
        if (cancelled) return;
        setPatch(patch);
        setState(patch ? "ready" : "error");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, filePath]);

  if (state === "loading") {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={11} className="animate-spin" />
        读取 diff…
      </div>
    );
  }

  if (state === "error" || !patch) {
    return (
      <div className="px-3 py-1.5 text-[11px] text-content-subtle">
        无可用 diff(文件可能已全部暂存)
      </div>
    );
  }

  // Parse the unified diff patch into a before/after pair for DiffView.
  // This is a simplified parser: extract +/- lines from hunks.
  const { before, after } = parsePatchToBeforeAfter(patch);
  const diff = lineDiff(before, after);
  return (
    <div className="px-1 pb-1 pt-0.5">
      <DiffView diff={diff} />
    </div>
  );
}

/* ───────────────────────── patch parser ───────────────────────── */

/** Parse a unified diff patch into before/after text for line-based diffing.
 *  Extracts removed (-) lines as "before" and added (+) lines as "after",
 *  preserving context lines in both. Lines outside hunks (file headers etc.)
 *  are ignored. */
function parsePatchToBeforeAfter(patch: string): { before: string; after: string } {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const lines = patch.split("\n");
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      afterLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      beforeLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      // Context line — appears in both.
      beforeLines.push(line.slice(1));
      afterLines.push(line.slice(1));
    } else if (line === "") {
      // Empty line in diff can be a context blank line.
      beforeLines.push("");
      afterLines.push("");
    }
  }
  return { before: beforeLines.join("\n"), after: afterLines.join("\n") };
}
