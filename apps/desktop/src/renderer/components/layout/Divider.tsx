/**
 * Divider - a draggable splitter handle between two layout panes.
 *
 * Used in ThreePaneLayout (left|center, center|right, center|bottom-terminal)
 * and CenterPane (chat|editor). Hand-rolled with mousedown -> document
 * mousemove/mouseup listeners, matching the codebase's no-library style.
 *
 * Visuals: the hit area IS the 1px visual line - no surrounding "column", so
 * the divider reads as a thin hairline (like a border) while still being
 * draggable. The line is subtle (`bg-edge`) at rest and lights up
 * (`bg-accent/50`) on hover or while dragging. During a drag, a global
 * `select-none` + fixed cursor is applied to <body> so text selection and
 * cursor flicker don't interfere.
 *
 * The caller owns the sizing math: `onResize(deltaPx)` is called on every
 * mousemove with the signed pixel delta *since the last event* (an incremental
 * delta, not cumulative). The sign convention is screen-space (positive =
 * right / down); the caller decides whether that delta grows or shrinks the
 * pane it controls - e.g. the left-bar divider grows the bar with a positive
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
   *  pixel delta since the last move (positive = rightward / downward).
   *  The caller adds it to the current pane size and clamps. */
  onResize: (deltaPx: number) => void;
  /** Optional double-click handler (e.g. reset to default width). */
  onDoubleClick?: () => void;
  /** Kept for API compatibility but a no-op now that the hit area is 1px (the
   *  line fills the whole element, so there is nowhere to align within). */
  lineAlign?: "start" | "center" | "end";
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

  // The hit area is the line itself: 1px wide/tall, filled with `bg-edge`.
  // No separate absolutely-positioned child, no 5px "column" - the divider
  // looks like a border while still being draggable.
  return (
    <div
      role="separator"
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        "group/divider z-10 shrink-0 bg-edge transition-colors group-hover/divider:bg-accent/50",
        isVertical
          ? "w-px cursor-col-resize"
          : "h-px cursor-row-resize",
        className,
      )}
    />
  );
}
