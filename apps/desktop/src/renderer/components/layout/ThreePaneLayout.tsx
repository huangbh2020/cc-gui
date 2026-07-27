import { type ReactNode } from "react";

interface Props {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  leftOpen: boolean;
  rightOpen: boolean;
}

/** Resizable three-pane shell: left (280px) | center (flex) | right (360px).
 * Each side pane is collapsible. P0 ships fixed widths + collapse toggles;
 * dragging to resize lands in P5.
 *
 * Both side panels' open/close state lives in the App (owner) so the toggle
 * buttons in the custom titlebar can control them. */
export function ThreePaneLayout({ left, center, right, leftOpen, rightOpen }: Props) {

  return (
    <>
      {/* Left sidebar — plain rectangle (no corner rounding). The right
         divider lives on the inner scroll container so it spans the panel. */}
      {leftOpen && (
        <aside className="flex h-full w-[280px] shrink-0 flex-col bg-surface-muted">
          <div className="min-h-0 flex-1 overflow-y-auto border-r border-edge">{left}</div>
        </aside>
      )}

      {/* Center pane — rounded bottom-left corner creates a soft arc where it
         meets the left sidebar at the bottom edge, echoing the titlebar's
         top-left radius. Visible because the sidebar (bg-surface-muted) shows
         through the notch against the pane's bg-surface. */}
      <main className="flex min-w-0 flex-1 flex-col rounded-bl-lg bg-surface">{center}</main>

      {/* Right sidebar — plain rectangle (no corner rounding). */}
      {rightOpen && (
        <aside className="flex h-full w-[360px] shrink-0 flex-col bg-surface-muted">
          <div className="min-h-0 flex-1 overflow-y-auto border-l border-edge">{right}</div>
        </aside>
      )}
    </>
  );
}
