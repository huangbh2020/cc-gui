import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

/** Shared single-select card used by the Settings appearance panels (theme
 *  picker, display-mode picker). Clicking selects the option; the caller
 *  drives the actual state change via `onSelect`. Keeps theme + display-mode
 *  radio groups visually consistent. */
export function RadioCard({
  checked,
  title,
  desc,
  icon,
  onSelect,
}: {
  checked: boolean;
  title: string;
  desc?: string;
  /** Optional leading icon (e.g. a sun/moon glyph). */
  icon?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
        checked
          ? "border-accent/60 bg-accent/5"
          : "border-edge bg-surface/40 hover:border-edge/80 hover:bg-surface-muted/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 transition-colors",
          checked ? "border-accent bg-accent" : "border-content-subtle/60",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {icon && <span className="text-content-muted">{icon}</span>}
          <div className="text-xs font-medium text-content">{title}</div>
        </div>
        {desc && <div className="mt-0.5 text-[11px] leading-relaxed text-content-subtle">{desc}</div>}
      </div>
    </button>
  );
}
