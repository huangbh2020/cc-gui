import { useCallback, useEffect, useMemo, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { ContextMenu } from "@base-ui/react/context-menu";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { joinPath } from "@renderer/lib/path.js";
import type { GitRepo, GitStatusResult, GitFileStatus } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";
import { Dialog } from "@renderer/components/ui/index.js";
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
  IconDotsVertical,
  IconTrash,
  IconEye,
} from "@renderer/lib/icons.js";

/**
 * One git repository's card in the Git panel. Layout (top to bottom):
 *
 *   Header: repo name + branch + ahead/behind + Pull/Push/Refresh
 *   已暂存 (staged) group  — [全部取消]
 *   Commit message input   — [提交 ▾] (commit / commit+push / commit+sync)
 *   更改 (unstaged) group   — [全部暂存]
 *
 * Clicking a file opens it in the CENTER editor's diff view (not inline).
 * Right-clicking a file shows a context menu (view source / discard changes).
 * Each file row shows a +/- diff tally badge (loaded async).
 *
 * All state is local to this card — multiple cards operate independently.
 */
export function GitRepoCard({ repo }: { repo: GitRepo }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<"push" | "pull" | "commit" | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { status } = await api.git.status({ repoPath: repo.path });
      setStatus(status);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [repo.path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Split files into staged and unstaged groups.
  const staged = useMemo(
    () => status?.files.filter((f) => f.index !== "unmodified" && f.index !== "untracked") ?? [],
    [status],
  );
  const unstaged = useMemo(
    () => status?.files.filter((f) => f.workingTree !== "unmodified" || f.index === "untracked") ?? [],
    [status],
  );
  const hasStaged = staged.length > 0;
  const hasUnstaged = unstaged.length > 0;

  /* ── operations ── */

  const handleStageAll = async () => {
    if (unstaged.length === 0) return;
    setBusy("commit");
    try {
      const res = await api.git.stage({
        repoPath: repo.path,
        filePaths: unstaged.map((f) => f.path),
      });
      if (!res.ok) setError(res.error ?? "暂存失败");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const handleUnstageAll = async () => {
    if (staged.length === 0) return;
    setBusy("commit");
    try {
      const res = await api.git.unstage({
        repoPath: repo.path,
        filePaths: staged.map((f) => f.path),
      });
      if (!res.ok) setError(res.error ?? "取消暂存失败");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const handleCommit = async (mode: "commit" | "push" | "sync") => {
    const msg = commitMsg.trim();
    if (!msg) return;
    setBusy("commit");
    setError(null);
    try {
      const res = await api.git.commit({ repoPath: repo.path, message: msg });
      if (!res.ok) {
        setError(res.error ?? "提交失败");
        return;
      }
      setCommitMsg("");
      if (mode === "push") {
        const pushRes = await api.git.push({ repoPath: repo.path });
        if (!pushRes.ok) setError(pushRes.error ?? "推送失败");
      } else if (mode === "sync") {
        const pullRes = await api.git.pull({ repoPath: repo.path });
        if (!pullRes.ok) {
          setError(pullRes.error ?? "拉取失败");
          return; // don't push if pull failed
        }
        const pushRes = await api.git.push({ repoPath: repo.path });
        if (!pushRes.ok) setError(pushRes.error ?? "推送失败");
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

  const handleDiscard = async () => {
    if (!pendingDiscard) return;
    setBusy("commit");
    try {
      const res = await api.git.discard({
        repoPath: repo.path,
        filePaths: pendingDiscard,
      });
      if (!res.ok) setError(res.error ?? "放弃更改失败");
      setPendingDiscard(null);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-edge bg-surface">
      {/* ── Header ── */}
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
          <ActionButton onClick={handlePull} disabled={busy !== null || loading} busy={busy === "pull"} title="拉取 (Pull)">
            <IconArrowDown size={12} />
          </ActionButton>
          <ActionButton onClick={handlePush} disabled={busy !== null || loading} busy={busy === "push"} title="推送 (Push)">
            <IconArrowUp size={12} />
          </ActionButton>
          <ActionButton onClick={refresh} disabled={busy !== null} title="刷新状态">
            <IconRefresh size={12} />
          </ActionButton>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="flex items-start gap-1.5 border-b border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* ── Body ── */}
      <div className="p-2">
        {loading && !status ? (
          <div className="flex items-center gap-1.5 py-2 text-[11px] text-content-subtle">
            <IconLoader2 size={12} className="animate-spin" />
            读取状态…
          </div>
        ) : !status || (status.files.length === 0) ? (
          <div className="flex items-center gap-1.5 py-2 text-[11px] text-content-subtle">
            <IconCheck size={12} className="text-accent" />
            工作区干净
          </div>
        ) : (
          <>
            {/* 已暂存 group (top) */}
            {hasStaged && (
              <FileGroup
                label="已暂存"
                files={staged}
                repoPath={repo.path}
                staged
                onBulkAction={handleUnstageAll}
                bulkActionLabel="全部取消"
                busy={busy !== null}
              />
            )}

            {/* Commit box (below staged) */}
            {hasStaged && (
              <CommitBox
                value={commitMsg}
                onChange={setCommitMsg}
                disabled={busy !== null}
                busy={busy === "commit"}
                onCommit={handleCommit}
              />
            )}

            {/* 更改 group (bottom) */}
            {hasUnstaged && (
              <div className={hasStaged ? "mt-2" : ""}>
                <FileGroup
                  label="更改"
                  files={unstaged}
                  repoPath={repo.path}
                  onBulkAction={handleStageAll}
                  bulkActionLabel="全部暂存"
                  busy={busy !== null}
                  onDiscard={(paths) => setPendingDiscard(paths)}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Discard confirmation dialog ── */}
      <Dialog.Root open={pendingDiscard !== null} onOpenChange={(open) => { if (!open) setPendingDiscard(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup>
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <IconAlertTriangle size={18} />
              </div>
              <div className="flex-1">
                <Dialog.Title className="text-sm font-semibold text-content">
                  放弃更改?
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-xs text-content-muted">
                  将放弃 {pendingDiscard?.length ?? 0} 个文件的本地更改,此操作不可撤销。
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDiscard(null)}
                className="rounded-md px-3 py-1.5 text-xs text-content-muted transition-colors hover:bg-surface-hover"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleDiscard}
                disabled={busy !== null}
                className="flex items-center gap-1 rounded-md bg-danger px-3 py-1.5 text-xs text-surface transition-colors hover:brightness-110 disabled:opacity-50"
              >
                {busy === "commit" ? <IconLoader2 size={12} className="animate-spin" /> : <IconTrash size={12} />}
                放弃更改
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/* ───────────────────────── commit box with dropdown ───────────────────────── */

function CommitBox({
  value,
  onChange,
  disabled,
  busy,
  onCommit,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  busy: boolean;
  onCommit: (mode: "commit" | "push" | "sync") => void;
}) {
  return (
    <div className="my-2 flex gap-1.5">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim() && !disabled) {
            void onCommit("commit");
          }
        }}
        placeholder="提交信息…"
        disabled={disabled}
        className="min-w-0 flex-1 rounded-md border border-edge-input bg-surface px-2 py-1 text-[11px] text-content outline-none focus:border-accent disabled:opacity-50"
      />
      {/* Split button: main "提交" + dropdown for commit+push / commit+sync. */}
      <div className="flex shrink-0 overflow-hidden rounded-md">
        <button
          type="button"
          onClick={() => onCommit("commit")}
          disabled={!value.trim() || disabled}
          className="flex items-center gap-1 bg-accent px-2 py-1 text-[11px] text-surface transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle"
        >
          {busy ? <IconLoader2 size={11} className="animate-spin" /> : <IconGitCommit size={11} />}
          提交
        </button>
        <Menu.Root>
          <Menu.Trigger
            disabled={!value.trim() || disabled}
            className="flex items-center bg-accent px-1 text-surface transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle"
          >
            <IconChevronDown size={12} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="top" align="end" sideOffset={4}>
              <Menu.Popup
                className={cn(
                  "z-50 min-w-[160px] rounded-md border border-edge bg-surface py-1 shadow-2xl",
                  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                  "transition-[transform,opacity] duration-100",
                )}
              >
                <Menu.Item
                  onClick={() => onCommit("commit")}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                >
                  提交
                </Menu.Item>
                <Menu.Item
                  onClick={() => onCommit("push")}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                >
                  提交并推送
                </Menu.Item>
                <Menu.Item
                  onClick={() => onCommit("sync")}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                >
                  提交并同步
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
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
  repoPath,
  staged,
  onBulkAction,
  bulkActionLabel,
  busy,
  onDiscard,
}: {
  label: string;
  files: GitFileStatus[];
  repoPath: string;
  staged?: boolean;
  onBulkAction: () => void;
  bulkActionLabel: string;
  busy: boolean;
  onDiscard?: (paths: string[]) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-content-subtle"
        >
          {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
          {label} ({files.length})
        </button>
        <button
          type="button"
          onClick={onBulkAction}
          disabled={busy}
          className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-40"
        >
          {bulkActionLabel}
        </button>
      </div>
      {!collapsed && (
        <div className="space-y-0.5">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              repoPath={repoPath}
              staged={staged}
              onDiscard={onDiscard}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── file row ───────────────────────── */

function FileRow({
  file,
  repoPath,
  staged,
  onDiscard,
}: {
  file: GitFileStatus;
  repoPath: string;
  staged?: boolean;
  onDiscard?: (paths: string[]) => void;
}) {
  const openFileInIde = useSessionStore((s) => s.openFileInIde);
  const setGitDiffBefore = useSessionStore((s) => s.setGitDiffBefore);
  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);
  const [diffTally, setDiffTally] = useState<{ adds: number; dels: number } | null>(null);

  const absPath = joinPath(repoPath, file.path);
  const code = staged ? file.index : file.workingTree;

  // Async-load the +/- tally for this file (only for modified/added/deleted,
  // not untracked — untracked has no diff to show).
  useEffect(() => {
    if (code === "untracked" || code === "unmodified") {
      setDiffTally(null);
      return;
    }
    let cancelled = false;
    api.git
      .diff({ repoPath, filePath: file.path })
      .then(({ patch }) => {
        if (cancelled || !patch) return;
        const { before, after } = parsePatchToBeforeAfter(patch);
        const diff = lineDiff(before, after);
        setDiffTally(diffSummary(diff));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, file.path, code]);

  // Click → open in center editor with diff.
  const handleClick = async () => {
    // For staged files there's no unstaged diff; just open in edit mode.
    if (staged) {
      openFileInIde(absPath);
      return;
    }
    // Unstaged: fetch diff, stash the before content, open in diff mode.
    try {
      const { patch } = await api.git.diff({ repoPath, filePath: file.path });
      if (patch) {
        const { before } = parsePatchToBeforeAfter(patch);
        setGitDiffBefore(absPath, before);
      }
    } catch {
      // fall through — open in edit mode
    }
    openFileInIde(absPath, { diff: true });
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <div className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-hover/40" />
        }
      >
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={absPath}
        >
          <StatusCodeIcon code={code} />
          <span className="truncate font-mono text-[11px] text-content-muted">{file.path}</span>
        </button>
        {/* +/- tally badge */}
        {diffTally && (diffTally.adds > 0 || diffTally.dels > 0) && (
          <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums">
            {diffTally.adds > 0 && <span className="text-accent">+{diffTally.adds}</span>}
            {diffTally.dels > 0 && <span className="text-danger">−{diffTally.dels}</span>}
          </span>
        )}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup
            className={cn(
              "z-50 min-w-[140px] rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <ContextMenu.Item
              onClick={handleClick}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
            >
              <IconEye size={12} />
              查看 Diff
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={() => openFileInIde(absPath)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
            >
              <IconGitCommit size={12} />
              查看源文件
            </ContextMenu.Item>
            {!staged && onDiscard && (
              <ContextMenu.Item
                onClick={() => onDiscard([file.path])}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-danger outline-none select-none data-[highlighted]:bg-danger/10"
              >
                <IconTrash size={12} />
                放弃更改…
              </ContextMenu.Item>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/* ───────────────────────── status code icon ───────────────────────── */

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

/* ───────────────────────── patch parser ───────────────────────── */

/** Parse a unified diff patch into before/after text for line-based diffing. */
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
      beforeLines.push(line.slice(1));
      afterLines.push(line.slice(1));
    } else if (line === "") {
      beforeLines.push("");
      afterLines.push("");
    }
  }
  return { before: beforeLines.join("\n"), after: afterLines.join("\n") };
}
