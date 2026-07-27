import { type ReactNode } from "react";

interface Props {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
}

/** Resizable three-pane shell: left (280px) | center (flex) | right (360px).
 * Each side pane is collapsible. P0 ships fixed widths + collapse toggles;
 * dragging to resize lands in P5.
 *
 * Both side panels' open/close state lives in the App (owner) so the toggle
 * buttons in the custom titlebar can control them. */
export function ThreePaneLayout({ left, center, right, leftOpen, rightOpen, onToggleLeft }: Props) {

  return (
    <>
      {leftOpen && (
        <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-edge bg-surface-muted">
          <div className="min-h-0 flex-1 overflow-y-auto">{left}</div>
        </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-surface">{center}</main>

      {rightOpen && (
        <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-edge bg-surface-muted">
          <div className="min-h-0 flex-1 overflow-y-auto">{right}</div>
        </aside>
      )}

      {/* Show-tab button when left panel is collapsed. */}
      {!leftOpen && (
        <button
          onClick={onToggleLeft}
          className="absolute left-1 top-12 z-10 rounded bg-surface-muted px-2 py-1 text-xs text-content-muted hover:bg-surface-hover"
        >
          ▸ 项目
        </button>
      )}
    </>
  );
}
