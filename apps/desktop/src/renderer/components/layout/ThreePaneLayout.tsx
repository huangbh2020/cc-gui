import { useState, type ReactNode } from "react";

interface Props {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

/** Resizable three-pane shell: left (280px) | center (flex) | right (360px).
 * Each side pane is collapsible. P0 ships fixed widths + collapse toggles;
 * dragging to resize lands in P5. */
export function ThreePaneLayout({ left, center, right }: Props) {
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  return (
    <>
      {leftOpen && (
        <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-edge bg-surface">
          <div className="flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-content-subtle">
            <span>Explorer</span>
            <button
              onClick={() => setLeftOpen(false)}
              className="rounded px-1 text-content-subtle hover:bg-surface-muted hover:text-content-muted"
              title="Hide sidebar"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{left}</div>
        </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-surface-muted">{center}</main>

      {rightOpen && (
        <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-edge bg-surface">
          <div className="flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-content-subtle">
            <span>Inspector</span>
            <button
              onClick={() => setRightOpen(false)}
              className="rounded px-1 text-content-subtle hover:bg-surface-muted hover:text-content-muted"
              title="Hide panel"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{right}</div>
        </aside>
      )}

      {/* Show-tab buttons when a pane is collapsed. */}
      {!leftOpen && (
        <button
          onClick={() => setLeftOpen(true)}
          className="absolute left-1 top-12 z-10 rounded bg-surface-muted px-2 py-1 text-xs text-content-muted hover:bg-surface-hover"
        >
          ▸ Explorer
        </button>
      )}
      {!rightOpen && (
        <button
          onClick={() => setRightOpen(true)}
          className="absolute right-1 top-12 z-10 rounded bg-surface-muted px-2 py-1 text-xs text-content-muted hover:bg-surface-hover"
        >
          Inspector ◂
        </button>
      )}
    </>
  );
}
