import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { basename } from "@renderer/lib/path.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { IconX } from "@renderer/lib/icons.js";
import { TabBarChevronButton, TabBarOverflowMenu } from "../layout/TabBarChrome.js";

/** Stable empty array so the selector never returns a fresh [] (Zustand
 *  Object.is rule — a new [] every render causes an infinite loop). */
const EMPTY_OPEN_FILES: string[] = [];

/**
 * Open-tabs bar — the horizontal strip of open files above the Monaco editor,
 * analogous to an editor's tab bar. Each tab shows the file's base name;
 * clicking activates it, the × closes it.
 *
 * Interaction model mirrors the session tabs (SessionTabs) — VS Code /
 * browser-style tab bar:
 *   - Drag a tab to reorder it (via @dnd-kit; a 6px activation distance
 *     distinguishes a drag from a click).
 *   - When tabs overflow, left/right chevron buttons scroll the strip; the
 *     mouse wheel is also translated to horizontal scroll. The native
 *     scrollbar is hidden (`no-scrollbar`); edge fades hint at more content.
 *   - A `⋯` menu on the right lists every tab for quick jumping when the
 *     strip overflows.
 *   - Middle-click on a tab closes it (except unsaved files — same rule as
 *     the × button, which is hidden while dirty).
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
  const reorderFile = useSessionStore((s) => s.reorderIdeFile);
  const dirtySet = useDirtyFiles();

  const scrollRef = useRef<HTMLDivElement>(null);
  // Maps a tab path → its DOM node, used to scrollIntoView the active tab.
  const tabNodes = useRef<Map<string, HTMLDivElement>>(new Map());
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const recomputeScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 1px tolerance to avoid float-rounding flakiness at the right edge.
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  // Keep scroll-boundary state fresh on mount, on tab add/remove, and on
  // container resize. (Scroll position itself is tracked by onScroll.)
  useEffect(() => {
    recomputeScrollState();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recomputeScrollState());
    ro.observe(el);
    return () => ro.disconnect();
  }, [openFiles.length, recomputeScrollState]);

  // Scroll the active tab into view whenever it changes — so selecting a
  // background tab or opening a new one never leaves it hidden off-screen.
  useEffect(() => {
    if (!activeFile) return;
    const node = tabNodes.current.get(activeFile);
    node?.scrollIntoView({ inline: "nearest", behavior: "smooth", block: "nearest" });
    // Recompute after the smooth scroll settles.
    const t = setTimeout(recomputeScrollState, 260);
    return () => clearTimeout(t);
  }, [activeFile, openFiles.length, recomputeScrollState]);

  const scrollByPage = useCallback((dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    // Translate vertical wheel into horizontal scroll so a plain mouse
    // wheel can navigate the strip. Trackpad horizontal is already deltaX.
    const el = scrollRef.current;
    if (!el) return;
    if (e.deltaY !== 0 && e.deltaX === 0) {
      el.scrollLeft += e.deltaY;
    }
  }, []);

  // ── Drag-and-drop (reorder) ──────────────────────────────────────────
  // A 6px movement activates a drag; anything less is treated as a click
  // (so tapping a tab to select it still works). Touch gets a slightly
  // longer delay so a scroll gesture isn't hijacked.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 120, tolerance: 8 },
    }),
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const from = openFiles.indexOf(String(active.id));
      const to = openFiles.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      reorderFile(from, to);
    },
    [openFiles, reorderFile],
  );

  if (openFiles.length === 0) return null;
  const overflowing = canScrollLeft || canScrollRight;

  return (
    <div className="flex shrink-0 items-end gap-0.5 border-b border-edge bg-surface/40 px-2 pt-1.5">
      {/* Left chevron — only when there's content scrolled off the left edge. */}
      {canScrollLeft && (
        <TabBarChevronButton
          dir="left"
          onClick={() => scrollByPage(-1)}
          title="Scroll tabs left"
        />
      )}

      {/* Scrollable tab track. The native scrollbar is hidden; navigation
          is via chevrons + wheel + drag. Edge fades on either side hint at
          overflow. */}
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={recomputeScrollState}
          onWheel={onWheel}
          className="no-scrollbar flex items-end gap-0.5 overflow-x-auto"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={openFiles}
              strategy={horizontalListSortingStrategy}
            >
              {openFiles.map((path) => (
                <SortableFileTab
                  key={path}
                  path={path}
                  isActive={path === activeFile}
                  dirty={dirtySet.has(path)}
                  registerNode={(node) => {
                    if (node) tabNodes.current.set(path, node);
                    else tabNodes.current.delete(path);
                  }}
                  onActivate={() => setActive(path)}
                  onClose={() => close(path)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        {/* Edge fades — overlay only, pointer-events disabled so they never
            intercept tab clicks. Shown per-direction based on scroll state. */}
        {canScrollLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface to-transparent" />
        )}
        {canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface to-transparent" />
        )}
      </div>

      {/* Right chevron — only when there's content scrolled off the right edge. */}
      {canScrollRight && (
        <TabBarChevronButton
          dir="right"
          onClick={() => scrollByPage(1)}
          title="Scroll tabs right"
        />
      )}

      {/* Overflow menu — lists every open file for quick jumping. Only shown
          when the strip actually overflows (otherwise it's pure noise). */}
      {overflowing && (
        <TabBarOverflowMenu
          heading="Open files"
          items={openFiles.map((path) => ({
            key: path,
            label: basename(path),
            title: path,
            active: path === activeFile,
            dotClass: dirtySet.has(path) ? "bg-accent animate-pulse" : undefined,
          }))}
          onSelect={(path) => setActive(path)}
        />
      )}
    </div>
  );
}

interface SortableFileTabProps {
  path: string;
  isActive: boolean;
  dirty: boolean;
  registerNode: (node: HTMLDivElement | null) => void;
  onActivate: () => void;
  onClose: () => void;
}

function SortableFileTab({
  path,
  isActive,
  dirty,
  registerNode,
  onActivate,
  onClose,
}: SortableFileTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: path });

  // Merge the dnd-kit node ref with our registry ref.
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      registerNode(node);
    },
    [setNodeRef, registerNode],
  );

  // The sortable transform reorders visually during a drag; while dragging
  // the source tab is dimmed and lifted slightly.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 10, opacity: 0.6 } : undefined),
  };

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );

  // Middle-click closes (browser tab-bar convention) — except unsaved files,
  // mirroring the × button which is hidden while dirty.
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 && !dirty) {
        e.preventDefault();
        onClose();
      }
    },
    [dirty, onClose],
  );

  return (
    <div
      ref={setRefs}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => {
        // A real drag is captured away by dnd-kit and never lands here; this
        // fires only for an actual tap, which we treat as tab activation.
        onActivate();
      }}
      onMouseDown={onMouseDown}
      role="tab"
      aria-selected={isActive}
      title={path}
      className={cn(
        "group flex max-w-[200px] min-w-0 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[11px] transition-colors",
        isActive
          ? "border-accent bg-surface text-content"
          : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content",
        isDragging && "shadow-lg",
      )}
    >
      <span className="max-w-[120px] truncate font-mono">{basename(path)}</span>
      {/* Dirty dot (unsaved) OR close button on hover — same rule as before:
          an unsaved file can't be closed from the bar (would lose edits). */}
      {dirty ? (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse"
          title="未保存"
        />
      ) : (
        <button
          type="button"
          aria-label="Close tab"
          onClick={handleClose}
          onPointerDown={(e) => e.stopPropagation()}
          className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-content group-hover:opacity-100 data-[active=true]:opacity-100"
          data-active={isActive}
          title="关闭"
        >
          <IconX size={10} />
        </button>
      )}
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
