import { type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

interface Props {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Bottom-bar terminal node (keep-alive: always mounted). */
  bottomTerminal?: ReactNode;
  /** Whether the bottom terminal bar is expanded. When false the bar collapses
   *  to height 0 but stays mounted so PTYs survive — see App.tsx. */
  bottomTerminalOpen?: boolean;
}

/** Resizable three-pane shell: left (280px) | center (flex) | right (360px).
 * Each side pane is collapsible. P0 ships fixed widths + collapse toggles;
 * dragging to resize lands in P5.
 *
 * Both side panels' open/close state lives in the App (owner) so the toggle
 * buttons in the custom titlebar can control them.
 *
 * The center pane stacks its content above an optional bottom terminal bar.
 * The terminal bar is scoped to the center pane's width (not full window) and
 * collapses to height 0 when closed while staying mounted (keep-alive). */
export function ThreePaneLayout({
  left,
  center,
  right,
  leftOpen,
  rightOpen,
  bottomTerminal,
  bottomTerminalOpen = false,
}: Props) {
  return (
    <>
      {/* Left sidebar — plain rectangle (no corner rounding). The right
         divider lives on the inner scroll container so it spans the panel. */}
      {leftOpen && (
        <aside className="flex h-full w-[280px] shrink-0 flex-col rounded-r-lg bg-surface-muted">
          <div className="min-h-0 flex-1 overflow-y-auto">{left}</div>
        </aside>
      )}

      {/* Center pane — rounded bottom-left corner creates a soft arc where it
         meets the left sidebar at the bottom edge, echoing the titlebar's
         top-left radius. Visible because the sidebar (bg-surface-muted) shows
         through the notch against the pane's bg-surface.
         Stacks the center content above an optional bottom terminal bar. */}
      <main className="flex min-w-0 flex-1 flex-col rounded-bl-lg bg-surface">
        <div className="min-h-0 flex-1 overflow-hidden">{center}</div>
        {/* Bottom terminal bar — keep-alive: always rendered, height collapses
            to 0 when closed so PTYs/scrollback survive. overflow-hidden clips
            the xterm host at height 0 (xterm FitAddon breaks under a scrolling
            ancestor, but a fixed-height non-scrolling box is fine). */}
        {bottomTerminal && (
          <div
            className={cn(
              "shrink-0 overflow-hidden border-t border-edge transition-[height] duration-150 ease-out",
              bottomTerminalOpen ? "h-[280px]" : "h-0 border-t-0",
            )}
          >
            {bottomTerminal}
          </div>
        )}
      </main>

      {/* Right sidebar — plain rectangle (no corner rounding).
         overflow-hidden (not overflow-y-auto): Files/Git scroll internally,
         and xterm FitAddon breaks under a scrolling ancestor. */}
      {rightOpen && (
        <aside className="flex h-full w-[360px] shrink-0 flex-col bg-surface-muted">
          <div className="min-h-0 flex-1 overflow-hidden border-l border-edge">{right}</div>
        </aside>
      )}
    </>
  );
}
