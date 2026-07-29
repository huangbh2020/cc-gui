/**
 * Divider — a draggable splitter handle between two layout panes.
 *
 * Used in ThreePaneLayout (left|center, center|right, center|bottom-terminal)
 * and CenterPane (chat|editor). Hand-rolled with mousedown → document
 * mousemove/mouseup listeners, matching the codebase's no-library style.
 *
 * Visuals: a 5px-wide hit area with a 1px visual line centered in it. The
 * line is subtle (`bg-edge`) at rest and lights up (`bg-accent/50`) on hover
 * or while dragging. During a drag, a global `select-none` + fixed cursor is
 * applied to <body> so text selection and cursor flicker don't interfere.
 *
 * The caller owns the sizing math: `onResize(deltaPx)` is called on every
 * mousemove with the signed pixel delta *since the last event* (an incremental
 * delta, not cumulative). The sign convention is screen-space (positive =
 * right / down); the caller decides whether that delta grows or shrinks the
 * pane it controls — e.g. the left-bar divider grows the bar with a positive
 * delta, while the right-bar divider shrinks it. The caller adds the delta
 * to the current store value inside its setter, so it never needs to track a
 * drag-start baseline.
 *
 * For the chat|editor split the delta is reported in px too; the caller
 * converts to a percentage using the container's measured width.
 */
import { useCallback, useRef } from "react";
import { cn } from "@renderer/lib/cn.js";

export interface DividerProps {
  /** `vertical` = a tall thin bar between side-by-side panes (cursor:
   *  col-resize). `horizontal` = a wide thin bar between stacked panes
   *  (cursor: row-resize). The naming follows the divider's own shape, not
   *  the drag axis. */
  orientation: "vertical" | "horizontal";
  /** Called on every mousemove during a drag with the signed *incremental*
   *  pixel delta since the last move event (positive = rightward / downward).
   *  The caller adds it to the current pane size and clamps. */
  onResize: (deltaPx: number) => void;
  /** Optional double-click handler (e.g. reset to default width). */
  onDoubleClick?: () => void;
  className?: string;
}

export function Divider({
  orientation,
  onResize,
  onDoubleClick,
  className,
}: DividerProps) {
  const dragging = useRef(false);

  const isVertical = orientation === "vertical";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only respond to primary button; let right-click through.
      if (e.button !== 0) return;
      e.preventDefault();
      let prev = isVertical ? e.clientX : e.clientY;
      dragging.current = true;

      // Lock the whole document while dragging: fixed cursor, no text
      // selection, no iframe pointer capture issues. Removed on mouseup.
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = isVertical ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const current = isVertical ? ev.clientX : ev.clientY;
        const delta = current - prev;
        prev = current;
        if (delta !== 0) onResize(delta);
      };
      const onUp = () => {
        dragging.current = false;
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [isVertical, onResize],
  );

  return (
    <div
      role="separator"
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        "group/divider relative z-10 shrink-0",
        // 5px hit area for easy grabbing; the 1px visual line is centered
        // via an absolutely-positioned child so it stays crisp at 1px.
        isVertical ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize",
        className,
      )}
    >
      <div
        className={cn(
          "absolute bg-edge transition-colors",
          isVertical
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
          "group-hover/divider:bg-accent/50",
        )}
      />
    </div>
  );
}
