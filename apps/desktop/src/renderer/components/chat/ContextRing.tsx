import { cn } from "@renderer/lib/cn.js";
import {
  fmtTokens,
  getContextBreakdown,
  warningColor,
} from "@renderer/lib/contextWindow.js";
import type { ContextSnapshot } from "@contracts/runtime";
import { Tooltip } from "@renderer/components/ui/index.js";
import {
  IconArrowBarToDown,
  IconArrowBarToUp,
  IconCoins,
  IconDatabase,
  IconStack2,
} from "@renderer/lib/icons.js";

/**
 * Compact circular context-occupancy indicator for the composer row.
 *
 * Renders as a small SVG ring (ZCode-style) whose filled arc length
 * represents `snapshot.pct` and whose color escalates with the warning
 * level (ok → accent, near-window → warning amber, critical → danger red).
 * The percentage sits beside the ring. Hover shows a rich tooltip breaking
 * the usage down by token kind (input / cache / output / cost).
 */
export function ContextRing({ snapshot }: { snapshot: ContextSnapshot }) {
  const { pct, warning } = snapshot;
  // Geometry: 14px box, ring stroke 2.5 (so inner hole ~9px).
  const size = 14;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * (Math.min(100, Math.max(0, pct)) / 100);
  const colorClass = warningColor(warning);
  const breakdown = getContextBreakdown(snapshot);

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={200}
        // Render as span so we don't nest buttons inside the toolbar.
        render={<span />}
        className={cn(
          "inline-flex cursor-default items-center gap-1 tabular-nums",
          colorClass,
        )}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            className="opacity-20"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        <span className="text-[10px] font-medium leading-none">{pct}%</span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={8}>
          <Tooltip.Popup className="min-w-[200px] max-w-[260px] p-0">
            <ContextTooltipBody snapshot={snapshot} breakdown={breakdown} />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function rowIcon(key: string) {
  switch (key) {
    case "input":
      return IconArrowBarToDown;
    case "cache-read":
    case "cache-write":
      return IconDatabase;
    case "output":
      return IconArrowBarToUp;
    case "processed":
      return IconStack2;
    case "cost":
      return IconCoins;
    default:
      return IconStack2;
  }
}

/** Shared rich body used by ContextRing and StatusCapsule. */
export function ContextTooltipBody({
  snapshot,
  breakdown,
}: {
  snapshot: ContextSnapshot;
  breakdown: ReturnType<typeof getContextBreakdown>;
}) {
  const colorClass = warningColor(snapshot.warning);
  return (
    <div className="px-2.5 py-2">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 border-b border-edge/70 pb-1.5">
        <div>
          <div className="text-[11px] font-semibold text-content">{breakdown.title}</div>
          <div className={cn("mt-0.5 text-[10px] tabular-nums", colorClass)}>
            {breakdown.subtitle}
          </div>
        </div>
        <div
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
            snapshot.warning === "critical" && "bg-danger/15 text-danger",
            snapshot.warning === "near-window" && "bg-warning/15 text-warning",
            snapshot.warning === "ok" && "bg-surface-muted text-content-muted",
          )}
        >
          {snapshot.pct}%
        </div>
      </div>
      <ul className="space-y-1">
        {breakdown.rows.map((row) => {
          const Icon = rowIcon(row.key);
          return (
            <li
              key={row.key}
              className="flex items-center gap-1.5 text-[11px] text-content-muted"
            >
              <Icon size={12} className="shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <span className="tabular-nums font-medium text-content">{row.value}</span>
            </li>
          );
        })}
      </ul>
      {snapshot.model && (
        <div className="mt-1.5 border-t border-edge/70 pt-1.5 text-[10px] text-content-subtle">
          模型 · {snapshot.model}
        </div>
      )}
      {/* Keep fmtTokens referenced for potential future rows */}
      <span className="hidden">{fmtTokens(snapshot.usedTokens)}</span>
    </div>
  );
}
