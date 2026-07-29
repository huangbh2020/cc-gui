import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { dirname } from "@renderer/lib/path.js";
import type { FileTreeEntry } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { FILE_DRAG_MIME } from "@renderer/lib/contentTag.js";
import {
  IconChevronRight,
  IconChevronDown,
  IconFolder,
  IconFolderOpen,
  IconFile,
  IconLoader2,
} from "@renderer/lib/icons.js";

/** Stable empty array for the expanded-dirs selector (Zustand Object.is). */
const EMPTY_EXPANDED: string[] = [];

/**
 * Registry of mounted file-node DOM buttons, keyed by absolute file path.
 * The FileTree root owns the Map and exposes a ref callback via context so
 * every FileNodeRow can register/unregister itself. Used by the reveal
 * effect to scrollIntoView the active file's node once it mounts (which may
 * be delayed while ancestor directories lazily load their children).
 */
type FileNodeRegister = (path: string, el: HTMLButtonElement | null) => void;
const FileNodeRegistryContext = createContext<FileNodeRegister | null>(null);

/* ───────────────────────── FileTree root ───────────────────────── */

/**
 * File tree — a lazily-loaded, expandable directory tree scoped to a single
 * project root. Root-level entries are fetched on mount; deeper levels fetch
 * on first expand. Expanded-dir state is persisted in the session store so
 * it survives restarts.
 *
 * The tree also surfaces "agent-touched" files: any file in the active
 * session's `turnFilesBySession` gets a colored dot so the user can spot
 * what the agent just changed without scanning every node.
 */
export function FileTree({ projectPath }: { projectPath: string }) {
  const pid = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    pid ? s.ideActiveFileByProject[pid] ?? null : null,
  );
  const setDirExpanded = useSessionStore((s) => s.setDirExpanded);

  // Root-level listing. Refetched when the project root changes (different
  // active session -> different project).
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.file
      .listDir({ projectPath, dirPath: "" })
      .then(({ entries }) => {
        if (!cancelled) {
          setEntries(entries);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Registry of mounted file-node buttons, used by the reveal effect below.
  // useRef (not state) so register/unregister never triggers a re-render; the
  // reveal effect polls it via rAF. Cleared implicitly on remount
  // (key={projectPath} in FilesPanel).
  const nodeMap = useRef<Map<string, HTMLButtonElement>>(new Map());
  const registerNode = useCallback((path: string, el: HTMLButtonElement | null) => {
    if (el) nodeMap.current.set(path, el);
    else nodeMap.current.delete(path);
  }, []);

  // Reveal the active file in the tree: expand its ancestor dirs (so the node
  // mounts - DirNode only renders children when open) then scroll it into view.
  // Ancestor expansion is an async chain (setDirExpanded -> re-render ->
  // DirNode lazy-loads children -> child mounts), so we can't scroll
  // synchronously; we poll the node registry across rAF frames until the node
  // appears (or give up after ~500ms).
  useEffect(() => {
    if (!activeFile || !activeFile.startsWith(projectPath)) return;
    // Build the ancestor dir chain from the file's dir up to (excluding) the
    // project root. E.g. "D:/proj/src/sub/a.ts" + root "D:/proj" ->
    // ["D:/proj/src", "D:/proj/src/sub"] (shallow-to-deep). We expand
    // shallow-first so each level's lazy load can kick off in mount order.
    const ancestors: string[] = [];
    let dir = dirname(activeFile);
    while (dir && dir !== projectPath) {
      // Guard: if dirname stops making progress (filesystem root), stop.
      ancestors.unshift(dir); // prepend -> shallowest first
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const ancestor of ancestors) {
      setDirExpanded(ancestor, true);
    }

    let frames = 0;
    const MAX_FRAMES = 30; // ~500ms @60fps - enough for a few async dir loads
    let raf = 0;
    const tryScroll = () => {
      const node = nodeMap.current.get(activeFile);
      if (node) {
        node.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      if (++frames < MAX_FRAMES) {
        raf = requestAnimationFrame(tryScroll);
      }
      // else: ancestors still loading after the budget - give up silently.
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
  }, [activeFile, projectPath, setDirExpanded]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-content-subtle [font-size:var(--rp-fs-xs)]">
        <IconLoader2 size={12} className="animate-spin" />
        读取目录…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="px-3 py-2 text-content-subtle [font-size:var(--rp-fs-xs)]">
        空目录
      </div>
    );
  }

  return (
    <FileNodeRegistryContext.Provider value={registerNode}>
      <div className="py-1 [font-size:var(--right-panel-font-size)]">
        {entries.map((e) => (
          <TreeNode key={e.path} entry={e} depth={0} projectPath={projectPath} />
        ))}
      </div>
    </FileNodeRegistryContext.Provider>
  );
}

/* ───────────────────────── TreeNode ───────────────────────── */

/** One node in the tree — either a directory (expandable, lazy-loads children)
 *  or a file (clickable, opens in the editor). Indentation is driven by
 *  `depth` via inline padding-left so the tree needs no nested DOM for
 *  alignment. */
function TreeNode({
  entry,
  depth,
  projectPath,
}: {
  entry: FileTreeEntry;
  depth: number;
  projectPath: string;
}) {
  // Expanded dirs + active file are scoped to the active project.
  const pid = useSessionStore((s) => s.activeProjectId);
  const expandedDirs = useSessionStore((s) =>
    pid ? s.ideExpandedDirsByProject[pid] ?? EMPTY_EXPANDED : EMPTY_EXPANDED,
  );
  const toggleDirExpanded = useSessionStore((s) => s.toggleDirExpanded);
  const openFileInIde = useSessionStore((s) => s.openFileInIde);
  const activeFile = useSessionStore((s) =>
    pid ? s.ideActiveFileByProject[pid] ?? null : null,
  );

  const isOpen = expandedDirs.includes(entry.path);
  const isActiveFile = activeFile === entry.path;

  if (entry.isDir) {
    return (
      <DirNode
        entry={entry}
        depth={depth}
        projectPath={projectPath}
        isOpen={isOpen}
        onToggle={() => toggleDirExpanded(entry.path)}
      />
    );
  }

  return (
    <FileNodeRow
      name={entry.name}
      path={entry.path}
      depth={depth}
      active={isActiveFile}
      onClick={() => openFileInIde(entry.path)}
    />
  );
}

/** Directory node — toggles expansion; children load lazily on first open. */
function DirNode({
  entry,
  depth,
  projectPath,
  isOpen,
  onToggle,
}: {
  entry: FileTreeEntry;
  depth: number;
  projectPath: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const [children, setChildren] = useState<FileTreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Lazy-load children when first expanded. We cache the result so subsequent
  // collapses/re-expansions don't re-fetch (unless the user manually refreshes
  // — not wired in this phase).
  useEffect(() => {
    if (!isOpen || children !== null) return;
    let cancelled = false;
    setLoading(true);
    // dirPath is relative to projectPath; compute it from the absolute path.
    const dirPath = entry.path.slice(projectPath.length).replace(/^[\\/]/, "");
    api.file
      .listDir({ projectPath, dirPath })
      .then(({ entries }) => {
        if (!cancelled) {
          setChildren(entries);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChildren([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, children, entry.path, projectPath]);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-1 py-0.5 pr-2 text-left transition-colors hover:bg-surface-hover/50",
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <span className="shrink-0 text-content-subtle">
          {isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
        <span className="shrink-0 text-content-subtle">
          {isOpen ? <IconFolderOpen size={13} /> : <IconFolder size={13} />}
        </span>
        <span className="truncate text-content-muted">{entry.name}</span>
        {loading && <IconLoader2 size={10} className="ml-auto animate-spin text-content-subtle" />}
      </button>
      {isOpen && children && children.length > 0 && (
        <div>
          {children.map((c) => (
            <TreeNode key={c.path} entry={c} depth={depth + 1} projectPath={projectPath} />
          ))}
        </div>
      )}
    </div>
  );
}

/** File node row — shared by the top-level listing and nested children. Shows
 *  an agent-touched marker if this file is in the active session's turn-files. */
function FileNodeRow({
  name,
  path,
  depth,
  active,
  onClick,
}: {
  name: string;
  path: string;
  depth: number;
  active: boolean;
  onClick: () => void;
}) {
  // Agent-touched marker: look up this file in the active session's turn-files.
  const turnFile = useAgentTouchedFile(path);
  // Register this button with the FileTree's node registry so the reveal
  // effect can scrollIntoView it once mounted (may be delayed while ancestor
  // dirs lazily load). Null when rendered outside a FileTree (defensive).
  const registerNode = useContext(FileNodeRegistryContext);

  return (
    <button
      type="button"
      ref={registerNode ? (el) => registerNode(path, el) : undefined}
      draggable
      onDragStart={(e) => {
        // Stash the file path in a custom MIME type so the composer's drop
        // handler can read it. effectAllowed=copy signals "this creates a
        // new reference" (not a move).
        e.dataTransfer.setData(FILE_DRAG_MIME, path);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1 py-0.5 pr-2 text-left transition-colors",
        active ? "bg-accent/15 text-content" : "text-content-muted hover:bg-surface-hover/50",
      )}
      style={{ paddingLeft: depth * 12 + 4 }}
      title={path}
    >
      {/* Spacer to align with directory chevrons. */}
      <span className="w-3 shrink-0" />
      <span className="shrink-0 text-content-subtle">
        <IconFile size={13} />
      </span>
      <span className="truncate">{name}</span>
      {/* Agent-touched dot: accent for created, danger-ish for modified. */}
      {turnFile && (
        <span
          className={cn(
            "ml-auto h-1.5 w-1.5 shrink-0 rounded-full",
            turnFile.kind === "created" ? "bg-accent" : "bg-info",
          )}
          title={turnFile.kind === "created" ? "本轮新建" : "本轮修改"}
        />
      )}
    </button>
  );
}

/* ───────────────────────── agent-touched hook ───────────────────────── */

/** Returns the TurnFileEntry for `path` if it's among the active session's
 *  most-recent-turn files, else undefined. Used to mark tree nodes. */
function useAgentTouchedFile(path: string): TurnFileEntry | undefined {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const turnFiles = useSessionStore((s) =>
    activeSessionId ? s.turnFilesBySession[activeSessionId] : undefined,
  );
  if (!turnFiles) return undefined;
  return turnFiles.find((f) => f.filePath === path);
}
