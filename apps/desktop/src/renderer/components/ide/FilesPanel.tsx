import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { FileTree } from "./FileTree.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import type { FileSearchEntry, FileGrepEntry } from "@contracts/ipc";
import {
  IconFolderPlus,
  IconSearch,
  IconX,
  IconFile,
  IconFileSearch,
  IconTextScan2,
  IconLoader2,
  IconChevronDown,
} from "@renderer/lib/icons.js";

/** Search debounce + result caps. Name/content share the debounce; caps differ
 *  (name search returns files, content returns line-level matches). */
const SEARCH_DEBOUNCE_MS = 120;
const NAME_SEARCH_LIMIT = 80;
const GREP_LIMIT = 200;
const GREP_MAX_PER_FILE = 10;

/** Which field the search box targets. Toggled by an icon button in the row. */
type SearchMode = "name" | "content";

/**
 * Files panel - the right-panel "Files" tab body.
 *
 * A **pure file tree** navigator with a project-wide search box on top. The
 * search has two modes, toggled by an icon button in the row:
 *  - `name`    - match file names / paths (api.file.search), flat file list.
 *  - `content` - match text inside files (api.file.grep), grouped by file with
 *                matched lines + line numbers.
 *
 * When the search query is empty, the lazily-loaded directory tree is shown.
 * Clicking any file - in the tree, the name results, or a content hit - opens
 * it in the CENTER pane's editor column (via openFileInIde -> App.tsx), NOT
 * here. This keeps the right panel as a navigation surface and the center pane
 * as the working surface, matching VS Code's explorer/editor split.
 *
 * The tree is scoped to the active project's root path; if no project is
 * active, an empty state is shown.
 */
export function FilesPanel() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const openFileInIde = useSessionStore((s) => s.openFileInIde);

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    const proj = projects.find((p) => p.id === activeProjectId);
    return proj?.path ?? null;
  }, [activeProjectId, projects]);

  // Search state. Kept here (not in the session store): search is a transient
  // view affordance, not per-project persisted navigation state like expanded
  // dirs / active file.
  const [mode, setMode] = useState<SearchMode>("name");
  const [query, setQuery] = useState("");
  // Name-search results (flat file list). Only populated in `name` mode.
  const [nameResults, setNameResults] = useState<FileSearchEntry[]>([]);
  // Content-search results (flat line-level matches, later grouped for render).
  // Only populated in `content` mode.
  const [grepResults, setGrepResults] = useState<FileGrepEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Request-id guard: when a newer search fires, stale in-flight responses are
  // dropped so a slow earlier query can't overwrite a newer one's results.
  const reqIdRef = useRef(0);

  const isSearching = query.trim().length > 0;
  // The "flat" result count activeIdx navigates over: one per file in name
  // mode, one per matched line in content mode.
  const flatCount = mode === "name" ? nameResults.length : grepResults.length;

  // Debounced search driven by the query + mode. Mirrors the @-mention picker's
  // debounce + reqIdRef cancel pattern. Each mode hits its own IPC channel;
  // switching mode clears the other mode's results so stale hits never show.
  useEffect(() => {
    if (!isSearching || !projectPath) {
      setNameResults([]);
      setGrepResults([]);
      setLoading(false);
      setActiveIdx(0);
      return;
    }
    setLoading(true);
    const myId = ++reqIdRef.current;
    const t = window.setTimeout(() => {
      const promise =
        mode === "name"
          ? api.file
              .search({ projectPath, query: query.trim(), limit: NAME_SEARCH_LIMIT })
              .then((res) => {
                if (reqIdRef.current !== myId) return;
                setNameResults(res.files ?? []);
                setGrepResults([]);
              })
          : api.file
              .grep({
                projectPath,
                query: query.trim(),
                limit: GREP_LIMIT,
                maxResultsPerFile: GREP_MAX_PER_FILE,
              })
              .then((res) => {
                if (reqIdRef.current !== myId) return;
                setGrepResults(res.matches ?? []);
                setNameResults([]);
              });
      void promise
        .then(() => {
          if (reqIdRef.current !== myId) return;
          setActiveIdx(0);
          setLoading(false);
        })
        .catch(() => {
          if (reqIdRef.current !== myId) return;
          setNameResults([]);
          setGrepResults([]);
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, mode, projectPath, isSearching]);

  // Switching projects invalidates search results (paths belong to the old
  // project). Also reset the query so the tree shows for the new project.
  useEffect(() => {
    setQuery("");
    setNameResults([]);
    setGrepResults([]);
    setActiveIdx(0);
  }, [projectPath]);

  // Keep the keyboard-active row scrolled into view while navigating.
  useEffect(() => {
    if (!isSearching) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, isSearching, flatCount]);

  if (!projectPath) {
    return <EmptyState />;
  }

  // Open the flat-active item: a file in name mode, or the file of the
  // active matched line in content mode.
  const openActive = () => {
    if (mode === "name") {
      const f = nameResults[activeIdx];
      if (f) openFileInIde(f.path);
    } else {
      const m = grepResults[activeIdx];
      if (m) openFileInIde(m.path);
    }
  };

  // Keyboard nav lives on the input: while searching, focus stays in the
  // search box, so arrow/enter/esc are simplest handled here (no global
  // listener needed, unlike the @-mention picker which shares focus with the
  // composer textarea).
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (flatCount === 0) return;
      e.preventDefault();
      setActiveIdx((i) => Math.min(flatCount - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      if (flatCount === 0) return;
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      if (flatCount === 0) return;
      e.preventDefault();
      openActive();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      inputRef.current?.focus();
    }
  };

  const toggleMode = () => {
    setMode((m) => (m === "name" ? "content" : "name"));
    // Different modes target different result sets; clear both so no stale
    // hits linger while the new mode's (debounced) search runs.
    setQuery("");
    setNameResults([]);
    setGrepResults([]);
    setActiveIdx(0);
    inputRef.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search row. Sticky at top so it stays visible while result/tree list
          scrolls underneath. Mirrors the @-mention picker's inline search style
          (IconSearch prefix + bare input + text-[12px]) for visual consistency.
          The leading icon button toggles name/content mode. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1.5">
        <button
          type="button"
          onClick={toggleMode}
          title={mode === "name" ? "当前:文件名搜索 - 点击切到内容搜索" : "当前:内容搜索 - 点击切到文件名搜索"}
          aria-label={mode === "name" ? "切换为内容搜索" : "切换为文件名搜索"}
          className={cn(
            "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
          )}
        >
          {mode === "name" ? <IconFileSearch size={14} /> : <IconTextScan2 size={14} />}
        </button>
        <IconSearch size={12} className="shrink-0 text-content-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={mode === "name" ? "搜索文件名…" : "搜索文件内容…"}
          spellCheck={false}
          className="h-5 min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content-subtle"
        />
        {loading ? (
          <IconLoader2 size={12} className="shrink-0 animate-spin text-content-subtle" />
        ) : query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="shrink-0 rounded text-content-subtle transition-colors hover:text-content"
            title="清除搜索"
          >
            <IconX size={13} />
          </button>
        ) : null}
      </div>

      {/* Body: tree when idle, search results while a query is active. */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {isSearching ? (
          mode === "name" ? (
            <NameSearchResults
              loading={loading}
              results={nameResults}
              activeIdx={activeIdx}
              onHover={setActiveIdx}
              onOpen={(path) => openFileInIde(path)}
            />
          ) : (
            <ContentSearchResults
              loading={loading}
              results={grepResults}
              activeIdx={activeIdx}
              onHover={setActiveIdx}
              onOpen={(path) => openFileInIde(path)}
            />
          )
        ) : (
          /* Keyed on projectPath so switching projects fully remounts the tree
             (clears stale expanded state / cached children). */
          <FileTree key={projectPath} projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}

/** Flat list of file-name matches shown in place of the tree while a query is
 *  active in `name` mode. Each row shows the file name (primary) and its
 *  project-relative path (secondary) so same-named files stay distinguishable. */
function NameSearchResults({
  loading,
  results,
  activeIdx,
  onHover,
  onOpen,
}: {
  loading: boolean;
  results: FileSearchEntry[];
  activeIdx: number;
  onHover: (idx: number) => void;
  onOpen: (path: string) => void;
}) {
  if (loading && results.length === 0) {
    return (
      <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-[12px] text-content-subtle">
        <IconLoader2 size={14} className="animate-spin" />
        搜索中…
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-content-subtle">
        无匹配文件
      </div>
    );
  }
  return (
    <div className="py-1 [font-size:var(--right-panel-font-size)]">
      {results.map((f, idx) => {
        const isActive = idx === activeIdx;
        return (
          <button
            key={f.path}
            type="button"
            data-idx={idx}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onOpen(f.path)}
            className={cn(
              "flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors",
              isActive ? "bg-accent/15 text-content" : "text-content-muted hover:bg-surface-hover/50",
            )}
            title={f.path}
          >
            <span className="shrink-0 text-content-subtle">
              <IconFile size={13} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{f.name}</span>
              <span className="block truncate text-[10px] text-content-subtle">
                {f.relativePath}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── content search ───────────────────────── */

/** Flatten the per-file match lists into a single array of rows, each carrying
 *  its flat index (for keyboard nav) and the file group it belongs to. Returns
 *  groups preserving backend order, which is already files-first BFS. */
interface GrepGroup {
  path: string;
  relativePath: string;
  fileName: string;
  lines: FileGrepEntry[];
}

/** Group line-level grep matches by file (paths repeat across matches). */
function groupByFile(matches: FileGrepEntry[]): GrepGroup[] {
  const groups: GrepGroup[] = [];
  const byPath = new Map<string, GrepGroup>();
  for (const m of matches) {
    let g = byPath.get(m.path);
    if (!g) {
      const fileName = m.relativePath.split("/").pop() ?? m.relativePath;
      g = { path: m.path, relativePath: m.relativePath, fileName, lines: [] };
      byPath.set(m.path, g);
      groups.push(g);
    }
    g.lines.push(m);
  }
  return groups;
}

/** Content-search results: matches grouped by file, each file a collapsible-
 *  looking header (clickable to open) with its matched lines underneath. Line
 *  rows carry the flat `data-idx` (position in the ungrouped match array) so
 *  keyboard navigation and scrollIntoView work against the same flat index. */
function ContentSearchResults({
  loading,
  results,
  activeIdx,
  onHover,
  onOpen,
}: {
  loading: boolean;
  results: FileGrepEntry[];
  activeIdx: number;
  onHover: (idx: number) => void;
  onOpen: (path: string) => void;
}) {
  const groups = useMemo(() => groupByFile(results), [results]);

  if (loading && results.length === 0) {
    return (
      <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-[12px] text-content-subtle">
        <IconLoader2 size={14} className="animate-spin" />
        搜索中…
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-content-subtle">
        无匹配内容
      </div>
    );
  }

  // Walk groups to compute each line's flat index for data-idx / active state.
  let flatIdx = -1;

  return (
    <div className="py-1 [font-size:var(--right-panel-font-size)]">
      {groups.map((g) => (
        <div key={g.path} className="mb-0.5">
          {/* File header: clickable to open the file in the editor. */}
          <button
            type="button"
            onClick={() => onOpen(g.path)}
            className={cn(
              "flex w-full items-center gap-1 px-2 py-1 text-left transition-colors",
              "text-content hover:bg-surface-hover/50",
            )}
            title={g.path}
          >
            <span className="shrink-0 text-content-subtle">
              <IconChevronDown size={12} />
            </span>
            <span className="shrink-0 text-content-subtle">
              <IconFile size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
              {g.fileName}
            </span>
            <span className="shrink-0 rounded bg-surface-muted px-1 text-[10px] text-content-subtle">
              {g.lines.length}
            </span>
          </button>
          {/* Matched lines under this file. */}
          {g.lines.map((m) => {
            flatIdx += 1;
            const isActive = flatIdx === activeIdx;
            return (
              <button
                key={`${m.path}:${m.lineNumber}`}
                type="button"
                data-idx={flatIdx}
                onMouseEnter={() => onHover(flatIdx)}
                onClick={() => onOpen(m.path)}
                className={cn(
                  "flex w-full items-start gap-1.5 py-0.5 pr-2 pl-7 text-left transition-colors",
                  isActive
                    ? "bg-accent/15 text-content"
                    : "text-content-muted hover:bg-surface-hover/50",
                )}
                title={m.path}
              >
                <span className="shrink-0 select-none text-[10px] leading-5 text-content-subtle">
                  {m.lineNumber}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-5">
                  <HighlightedLine line={m.lineText} matches={m.matches} />
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Renders a matched line with each query occurrence highlighted. Splits the
 *  line around the match ranges and wraps the matched spans in an accent style. */
function HighlightedLine({
  line,
  matches,
}: {
  line: string;
  matches: Array<{ start: number; end: number }>;
}) {
  if (matches.length === 0) {
    return <>{line}</>;
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((m, i) => {
    if (m.start > cursor) {
      parts.push(<span key={`t${i}`}>{line.slice(cursor, m.start)}</span>);
    }
    parts.push(
      <mark key={`m${i}`} className="rounded-sm bg-accent/30 px-0.5 text-content">
        {line.slice(m.start, m.end)}
      </mark>,
    );
    cursor = m.end;
  });
  if (cursor < line.length) {
    parts.push(<span key="tail">{line.slice(cursor)}</span>);
  }
  return <>{parts}</>;
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
