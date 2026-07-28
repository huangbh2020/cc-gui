import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

/**
 * One setting = one row. Left side carries a title (+ optional description),
 * right side carries the control(s). The parent container draws the row
 * separators (`divide-y divide-edge`) so this component stays a pure layout
 * shell — no borders of its own.
 *
 * `htmlFor` (optional) makes the title label click-through to the control,
 * useful for native inputs like range/color. `controlAlign` lets the caller
 * vertically align the right column to the title (default) or to the whole
 * block (for multi-line descriptions).
 */
export function SettingRow({
  title,
  desc,
  descExtra,
  htmlFor,
  controlAlign = "center",
  className,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  /** Optional secondary line below `desc` (e.g. a faint hint). */
  descExtra?: ReactNode;
  htmlFor?: string;
  /** Vertical alignment of the right control column. */
  controlAlign?: "center" | "start";
  className?: string;
  children: ReactNode;
}) {
  const isLabel = !!htmlFor;
  const TitleTag = isLabel ? "label" : "div";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <TitleTag
          {...(isLabel ? { htmlFor } : {})}
          className="text-xs font-medium text-content"
        >
          {title}
        </TitleTag>
        {desc && (
          <div className="mt-0.5 text-[11px] leading-relaxed text-content-subtle">
            {desc}
          </div>
        )}
        {descExtra && <div className="mt-0.5">{descExtra}</div>}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          controlAlign === "start" ? "self-start" : "self-center",
        )}
      >
        {children}
      </div>
    </div>
  );
}
