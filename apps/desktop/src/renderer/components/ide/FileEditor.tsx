import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { extname } from "@renderer/lib/path.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { ideDirtyTracker } from "./OpenTabsBar.js";
import { IconEye, IconEdit, IconLoader2, IconAlertTriangle, IconSquare, IconColumns3 } from "@renderer/lib/icons.js";
import { Markdown } from "../chat/Markdown.js";
// Side-effect import: configures Monaco's worker environment + local instance
// (no CDN). Must run before any <Editor> mounts. See monacoSetup.ts.
import "@renderer/lib/monacoSetup.js";

/**
 * File editor — wraps Monaco for a single open file. Supports two modes:
 *
 *  - "edit": a normal editable Monaco instance. Ctrl+S saves via
 *    `file.writeFile`. Dirty state (content diverges from last save) is
 *    reported to OpenTabsBar via `ideDirtyTracker` so the tab shows a dot.
 *
 *  - "diff": a side-by-side Monaco DiffEditor comparing the file's
 *    pre-turn `before` snapshot (from turnFilesBySession) against its current
 *    on-disk content. Read-only. Used when the user clicks 审查 on a
 *    turn-files card, or when an agent-touched file is opened.
 *
 * Mode is per-file and lives in the store (ideFileViewMode); a toggle in the
 * toolbar lets the user flip between the two when a `before` snapshot exists.
 * Files without a snapshot can only be edited (no diff to show).
 *
 * Theme follows the app's `.dark` class on <html> via a MutationObserver —
 * Monaco doesn't react to CSS, so we explicitly call `setTheme` on change.
 */
export function FileEditor({
  filePath,
  projectPath,
}: {
  filePath: string;
  projectPath: string;
}) {
  // View mode is scoped to the active project's bucket.
  const pid = useSessionStore((s) => s.activeProjectId);
  const viewMode = useSessionStore((s) =>
    pid ? s.ideFileViewModeByProject[pid]?.[filePath] ?? "edit" : "edit",
  );
  const setViewMode = useSessionStore((s) => s.setIdeFileViewMode);
  const editorMode = useSessionStore((s) => s.ideEditorMode);
  const setEditorMode = useSessionStore((s) => s.setIdeEditorMode);

  // Resolve the before-snapshot for diff mode. Three sources, in priority:
  //  1. Turn-files card override - the card's frozen `before` (passed when
  //     the user clicks a file to review). Works for HISTORICAL turns whose
  //     snapshot is gone from turnFilesBySession.
  //  2. Git panel - the active project's gitDiffByProject bucket (working-tree
  //     or history click). History pairs also carry an explicit `after` blob.
  //  3. Turn-files - the active session's latest-turn snapshot (the agent
  //     edited the file, or the user clicked 审查 on the latest turn's card).
  const turnFile = useTurnFileFor(filePath);
  const gitPair = useGitDiffPair(filePath);
  const diffBeforeOverride = useSessionStore((s) =>
    pid ? s.ideDiffBeforeByProject[pid]?.[filePath] : undefined,
  );
  const diffBefore = diffBeforeOverride ?? gitPair?.before ?? turnFile?.before;
  const diffAfter = gitPair?.after;
  // History diffs are pure blobs — don't offer switching into the live editor,
  // which would show unrelated working-tree content.
  const historyOnly = diffAfter != null;

  // Effective mode:
  //  - diff: history pairs (forced) OR explicitly requested with a snapshot.
  //  - preview: explicitly requested (Markdown rendered read-only).
  //  - edit: the normal editable Monaco instance (default for non-md files).
  const effectiveMode: "edit" | "diff" | "preview" =
    historyOnly || (viewMode === "diff" && diffBefore != null)
      ? "diff"
      : viewMode === "preview"
        ? "preview"
        : "edit";

  const markdown = isMarkdown(filePath);

  return (
    <div className="flex h-full flex-col">
      <EditorToolbar
        filePath={filePath}
        projectPath={projectPath}
        mode={effectiveMode}
        canDiff={diffBefore != null && !historyOnly}
        onToggleMode={() => setViewMode(filePath, effectiveMode === "edit" ? "diff" : "edit")}
        isMarkdown={markdown}
        onTogglePreview={() =>
          setViewMode(filePath, effectiveMode === "preview" ? "edit" : "preview")
        }
        editorMode={editorMode}
        onToggleEditorMode={() => setEditorMode(editorMode === "tabs" ? "replace" : "tabs")}
      />
      <div className="min-h-0 flex-1">
        {effectiveMode === "diff" && diffBefore != null ? (
          <DiffPane filePath={filePath} before={diffBefore} after={diffAfter} />
        ) : effectiveMode === "preview" ? (
          <MarkdownPreviewPane filePath={filePath} />
        ) : (
          <EditPane filePath={filePath} />
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Toolbar ───────────────────────── */

function EditorToolbar({
  filePath,
  projectPath,
  mode,
  canDiff,
  onToggleMode,
  isMarkdown,
  onTogglePreview,
  editorMode,
  onToggleEditorMode,
}: {
  filePath: string;
  projectPath: string;
  mode: "edit" | "diff" | "preview";
  canDiff: boolean;
  onToggleMode: () => void;
  isMarkdown: boolean;
  onTogglePreview: () => void;
  editorMode: "tabs" | "replace";
  onToggleEditorMode: () => void;
}) {
  // Show the path relative to the project root when possible (cleaner in the
  // narrow toolbar); fall back to the full path.
  const rel =
    filePath.startsWith(projectPath) && filePath.length > projectPath.length
      ? filePath.slice(projectPath.length).replace(/^[/\\]/, "")
      : filePath;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-muted/40 px-2.5 py-1">
      <span className="truncate font-mono text-[11px] text-content-muted" title={filePath}>
        {rel}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {canDiff && mode !== "preview" && (
          <button
            type="button"
            onClick={onToggleMode}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
            title={mode === "edit" ? "切换到差异视图" : "切换到编辑视图"}
          >
            {mode === "edit" ? <IconEye size={12} /> : <IconEdit size={12} />}
            {mode === "edit" ? "Diff" : "Edit"}
          </button>
        )}
        {/* Markdown preview/edit toggle - only for .md files. In preview mode
            the button switches to the source editor; in edit/diff mode it
            switches to the rendered preview. */}
        {isMarkdown && (
          <button
            type="button"
            onClick={onTogglePreview}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
            title={mode === "preview" ? "切换到源码编辑" : "切换到预览"}
          >
            {mode === "preview" ? <IconEdit size={12} /> : <IconEye size={12} />}
            {mode === "preview" ? "Edit" : "Preview"}
          </button>
        )}
        {/* Editor open-mode toggle: tabs (multi-file) ↔ replace (single-file).
            Always visible so the user can switch back to tabs even when the
            OpenTabsBar is hidden (replace mode). */}
        <button
          type="button"
          onClick={onToggleEditorMode}
          className={cn(
            "flex items-center justify-center rounded px-1 py-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
          )}
          title={
            editorMode === "tabs"
              ? "当前:多标签页 — 点击切到替换模式(单文件)"
              : "当前:替换模式 — 点击切到多标签页"
          }
        >
          {editorMode === "tabs" ? <IconColumns3 size={13} /> : <IconSquare size={13} />}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Edit pane ───────────────────────── */

/** Editable Monaco instance for one file. Loads content on mount; tracks
 *  dirty state; Ctrl+S saves. */
function EditPane({ filePath }: { filePath: string }) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [content, setContent] = useState<string | null>(null); // null = loading
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the file content once per filePath.
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    api.file
      .readFile({ filePath })
      .then(({ content }) => {
        if (!cancelled) {
          setContent(content);
          ideDirtyTracker.set(filePath, false);
        }
      })
      .catch(() => {
        if (!cancelled) setContent(""); // degrade to empty
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Ctrl+S handler. We attach via Monaco's addCommand so it works regardless
  // of focus, and only when the editor is ready.
  const handleSave = useCallback(async () => {
    if (content === null) return;
    const editor = editorRef.current;
    if (!editor) return;
    const value = editor.getValue();
    setSaveState("saving");
    const ok = await useSessionStore.getState().saveFileContent(filePath, value);
    if (ok) {
      setContent(value); // new baseline
      ideDirtyTracker.set(filePath, false);
      setSaveState("saved");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveState("idle"), 1500);
    } else {
      setSaveState("error");
    }
  }, [content, filePath]);

  const language = languageForExt(extname(filePath));

  // Theme: follow the .dark class on <html>.
  const theme = useMonacoTheme();

  // Wire Ctrl+S / Cmd+S to save. Monaco passes its monaco namespace into
  // onMount, which is where we register the keybinding (we need the monaco
  // KeyMod/KeyCode constants to compose the chord).
  const handleEditorMount = (editor_: editor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
    editorRef.current = editor_;
    editor_.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSave();
    });
  };

  // Clear the saved-indicator timer on unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      // Report clean on unmount so a re-open doesn't show a stale dirty dot.
      ideDirtyTracker.set(filePath, false);
    };
  }, [filePath]);

  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        读取文件…
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <Editor
        height="100%"
        path={filePath} // unique model per file
        language={language}
        value={content}
        theme={theme}
        onChange={(value) => {
          // Dirty if content diverges from the saved baseline.
          const dirty = (value ?? "") !== content;
          ideDirtyTracker.set(filePath, dirty);
        }}
        onMount={handleEditorMount}
        loading={<div className="text-[11px] text-content-subtle">加载编辑器…</div>}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 2,
          automaticLayout: true,
          renderWhitespace: "selection",
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
      />
      {/* Save status toast — bottom-right, non-blocking. */}
      {saveState !== "idle" && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] shadow-sm",
            saveState === "saving" && "bg-surface text-content-muted",
            saveState === "saved" && "bg-accent/15 text-accent",
            saveState === "error" && "bg-danger/15 text-danger",
          )}
        >
          {saveState === "saving" && <IconLoader2 size={11} className="animate-spin" />}
          {saveState === "saved" && <span>已保存 ✓</span>}
          {saveState === "error" && (
            <>
              <IconAlertTriangle size={11} />
              保存失败
            </>
          )}
          {saveState === "saving" && "保存中…"}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Markdown preview ───────────────────────── */

/** Read-only rendered Markdown preview for `.md` files. Loads the file content
 *  via the same `file.readFile` API as EditPane, then renders it with the chat
 *  Markdown renderer (Shiki code highlighting, GFM, math). The outer container
 *  overrides `--chat-font-size` so the rendered text uses an editor-appropriate
 *  size instead of the chat bubble size. Read-only - no save / dirty tracking.
 *  Re-reads on filePath change. */
function MarkdownPreviewPane({ filePath }: { filePath: string }) {
  const [content, setContent] = useState<string | null>(null); // null = loading
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    api.file
      .readFile({ filePath })
      .then(({ content }) => {
        if (!cancelled) setContent(content);
      })
      .catch(() => {
        if (!cancelled) setContent(""); // degrade to empty
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        读取文件…
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto bg-surface px-6 py-4 [--chat-font-size:13px]">
      <Markdown>{content}</Markdown>
    </div>
  );
}

/* ───────────────────────── Diff pane ───────────────────────── */

/** Side-by-side diff: `before` vs `after` (or current on-disk content when
 *  `after` is omitted). Read-only — the diff is for review, not editing.
 *
 *  Uses `keepCurrentOriginalModel` / `keepCurrentModifiedModel` and a manual
 *  onMount cleanup to avoid the "TextModel got disposed before
 *  DiffEditorWidget model got reset" error. The @monaco-editor/react library's
 *  default unmount disposes the TextModels BEFORE the DiffEditorWidget, which
 *  triggers the widget's model-change listener on an already-disposed model.
 *  By keeping the models alive past the widget's disposal, we break that race.
 *  We then dispose the models ourselves in the correct order (widget first,
 *  then models) via the onMount ref. */
function DiffPane({
  filePath,
  before,
  after,
}: {
  filePath: string;
  before: string;
  /** Explicit modified-side content (history commits). When omitted the pane
   *  reads the working-tree file from disk. */
  after?: string;
}) {
  const [modified, setModified] = useState<string | null>(after ?? null);
  const theme = useMonacoTheme();
  const language = languageForExt(extname(filePath));
  // Stash the editor + monaco instances so we can dispose in the right order
  // on unmount (widget first, then models).
  const editorRef = useRef<import("monaco-editor").editor.IDiffEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);

  useEffect(() => {
    // History pair: both sides are already known — don't touch the disk.
    if (after != null) {
      setModified(after);
      return;
    }
    let cancelled = false;
    setModified(null);
    api.file
      .readFile({ filePath })
      .then(({ content }) => {
        if (!cancelled) setModified(content);
      })
      .catch(() => {
        if (!cancelled) setModified("");
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, after]);

  // On unmount: dispose the widget FIRST, then the models. This is the
  // reverse of what the library does by default, and avoids the listener race.
  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (editor && monaco) {
        // Dispose the diff editor widget before touching its models so no
        // model-change listener fires on a disposed model.
        try {
          editor.dispose();
        } catch {
          // already disposed — ignore
        }
      }
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  if (modified === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        读取改动…
      </div>
    );
  }

  return (
    <DiffEditor
      height="100%"
      language={language}
      original={before}
      modified={modified}
      theme={theme}
      // Prevent the library from disposing models on unmount — we handle it
      // ourselves (widget first) to avoid the dispose-order race.
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      loading={<div className="text-[11px] text-content-subtle">加载差异…</div>}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
      }}
      options={{
        readOnly: true,
        renderSideBySide: true,
        // Center column is often <900px (chat | editor split). Monaco's default
        // then collapses side-by-side into inline mode, which paints TWO line-
        // number gutters (original | modified) on a single pane — looks like a
        // duplicated 行号栏. Keep true side-by-side regardless of width.
        useInlineViewWhenSpaceIsLimited: false,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        // Slim gutters: no breakpoint glyph column, tighter line-number width.
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 8,
        lineNumbersMinChars: 3,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      }}
    />
  );
}

/* ───────────────────────── hooks & helpers ───────────────────────── */

/** Look up the active session's turn-files entry for `filePath`. Returns
 *  undefined if the file wasn't touched in the latest turn (no diff). */
function useTurnFileFor(filePath: string): TurnFileEntry | undefined {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const turnFiles = useSessionStore((s) =>
    activeSessionId ? s.turnFilesBySession[activeSessionId] : undefined,
  );
  if (!turnFiles) return undefined;
  return turnFiles.find((f) => f.filePath === filePath);
}

/** Look up the active project's git-diff pair for `filePath`.
 *  Returns undefined if the Git panel hasn't stashed a diff for this file. */
function useGitDiffPair(
  filePath: string,
): { before: string; after?: string } | undefined {
  const pid = useSessionStore((s) => s.activeProjectId);
  const projMap = useSessionStore((s) =>
    pid ? s.gitDiffByProject[pid] : undefined,
  );
  return projMap?.[filePath];
}

/** Tracks the effective Monaco theme by watching the `.dark` class on <html>.
 *  Monaco can't react to CSS, so we explicitly switch its theme when the app
 *  theme flips. Returns "vs-dark" or "light". */
function useMonacoTheme(): string {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.classList.contains("dark") : true,
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(el.classList.contains("dark"));
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark ? "vs-dark" : "light";
}

/** True for `.md` / `.markdown` files - gates the preview/edit toolbar toggle
 *  and the preview render branch. */
function isMarkdown(filePath: string): boolean {
  const ext = extname(filePath);
  return ext === ".md" || ext === ".markdown";
}

/** Map a file extension to a Monaco language id. Covers the common cases;
 *  unknown extensions fall back to plaintext (Monaco's default). */
function languageForExt(ext: string): string {
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".less":
      return "less";
    case ".html":
    case ".htm":
      return "html";
    case ".xml":
    case ".svg":
      return "xml";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".kt":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".php":
      return "php";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "ini";
    case ".ini":
    case ".cfg":
    case ".conf":
      return "ini";
    case ".sql":
      return "sql";
    case ".dockerfile":
      return "dockerfile";
    case ".vue":
      return "html";
    default:
      return "plaintext";
  }
}
