import { useSyncExternalStore } from "react";
import { basename } from "@renderer/lib/path.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { IconX } from "@renderer/lib/icons.js";

/** Stable empty array so the selector never returns a fresh [] (Zustand
 *  Object.is rule — a new [] every render causes an infinite loop). */
const EMPTY_OPEN_FILES: string[] = [];

/**
 * Open-tabs bar — the horizontal strip of open files above the Monaco editor,
 * analogous to an editor's tab bar. Each tab shows the file's base name;
 * clicking activates it, the × closes it.
 *
 * Dirty state (unsaved edits) is tracked inside FileEditor and surfaced here
 * via a per-file dirty map kept in a module-level store subscription. To keep
 * this simple and avoid plumbing dirty state through the global store, the
 * FileEditor reports dirty changes through a lightweight event the bar
 * subscribes to — see `ideDirtyTracker`.
 */
export function OpenTabsBar() {
  // Open files are scoped to the active project — switching projects swaps
  // the tab bar to that project's open files.
  const pid = useSessionStore((s) => s.activeProjectId);
  const openFiles = useSessionStore((s) =>
    pid ? s.ideOpenFilesByProject[pid] ?? EMPTY_OPEN_FILES : EMPTY_OPEN_FILES,
  );
  const activeFile = useSessionStore((s) =>
    pid ? s.ideActiveFileByProject[pid] ?? null : null,
  );
  const setActive = useSessionStore((s) => s.setIdeActiveFile);
  const close = useSessionStore((s) => s.closeFileInIde);
  const dirtySet = useDirtyFiles();

  return (
    <div className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-edge bg-surface/40 px-2 pt-1.5">
      {openFiles.map((path) => {
        const active = path === activeFile;
        const dirty = dirtySet.has(path);
        return (
          <div
            key={path}
            className={cn(
              "group flex max-w-[200px] min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[11px] transition-colors",
              active
                ? "border-accent bg-surface text-content"
                : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content",
            )}
            onClick={() => setActive(path)}
            title={path}
          >
            <span className="max-w-[120px] truncate font-mono">{basename(path)}</span>
            {/* Dirty dot (unsaved) OR close button on hover. */}
            {dirty ? (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse"
                title="未保存"
              />
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  close(path);
                }}
                className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-content group-hover:opacity-100"
                title="关闭"
              >
                <IconX size={10} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── dirty tracking ─────────────────────────
 *
 * FileEditor instances report their dirty state (content diverges from the
 * last-saved content) through this tiny pub/sub. It avoids putting transient
 * per-file dirty flags into the global store (which would churn selectors on
 * every keystroke). The bar subscribes and re-renders only when the set of
 * dirty files changes.
 *
 * The tracker is module-scoped and resets on full app reload — acceptable
 * since dirty state is inherently ephemeral (unsaved edits don't survive a
 * restart anyway). */

const dirtyFiles = new Set<string>();
const listeners = new Set<() => void>();

export const ideDirtyTracker = {
  set(filePath: string, dirty: boolean) {
    const had = dirtyFiles.has(filePath);
    if (dirty && !had) dirtyFiles.add(filePath);
    else if (!dirty && had) dirtyFiles.delete(filePath);
    else return; // no change
    listeners.forEach((fn) => fn());
  },
  has(filePath: string) {
    return dirtyFiles.has(filePath);
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Hook returning the current set of dirty file paths. Re-renders the caller
 *  when the set changes. */
function useDirtyFiles(): Set<string> {
  // We use useSyncExternalStore for correctness (tears-free under concurrent
  // React). The snapshot is the Set itself; since we never mutate it in place
  // without notifying, identity is stable between notifications.
  return useSyncExternalStore(
    ideDirtyTracker.subscribe,
    () => dirtyFiles,
    () => dirtyFiles,
  );
}
