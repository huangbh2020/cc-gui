import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { fmtTokens, warningColor } from "@renderer/lib/contextWindow.js";
import {
  IconHexagon,
  IconRobot,
  IconListDetails,
  IconChevronDown,
} from "@renderer/lib/icons.js";
import type { ContextSnapshot, SubagentSnapshot, ContextWarning } from "@contracts/runtime";
import type { TodoItem, PlanDraft } from "@renderer/stores/sessionStore.js";
import { ActivityPopover } from "./ActivityPopover.js";

/**
 * Unified status capsule for the sticky top-right of the chat stream.
 * Consolidates what used to be three separate chips (UsageChip +
 * SubagentsChip + TaskRing button) into ONE glassy pill, so the top-right
 * stays calm even when context + subagents + todos are all active.
 *
 * Layout: a single rounded container with up to three segments separated
 * by thin dividers. Each segment = icon + compact number. Segments are
 * omitted when their source is empty (no todos → no tasks segment), so
 * the capsule gracefully degrades.
 *
 * Hover any segment for a detail tooltip; click the capsule to open the
 * ActivityPopover (the existing unified detail panel — plan / subagents /
 * tasks). The context segment reuses ContextRing's tooltip text.
 */
export function StatusCapsule({
  snapshot,
  subagents,
  todos,
  plan,
}: {
  snapshot?: ContextSnapshot;
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  plan: PlanDraft;
}) {
  const [open, setOpen] = useState(false);
  const hasContext = !!snapshot;
  const runningAgents = subagents.filter((a) => a.status === "running").length;
  const hasSubagents = subagents.length > 0;
  const hasTodos = todos.length > 0;
  const todoDone = todos.filter((t) => t.status === "completed").length;

  // At least one segment must be present, else render nothing.
  if (!hasContext && !hasSubagents && !hasTodos) return null;

  return (
    <div className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium backdrop-blur transition-all",
          open
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-edge/50 bg-surface-muted/70 text-content-muted hover:border-edge hover:bg-surface-hover/80",
        )}
        title="查看活动详情（任务 / 子代理 / 上下文）"
      >
        {/* Context-window segment — icon tinted by warning level. */}
        {hasContext && snapshot && (
          <ContextSegment snapshot={snapshot} />
        )}
        {hasContext && (hasSubagents || hasTodos) && <Divider />}

        {/* Subagents segment — only when any exist. Pulsing dot while running. */}
        {hasSubagents && (
          <>
            <span className="flex items-center gap-1 tabular-nums">
              {runningAgents > 0 && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              )}
              <IconRobot size={13} className={runningAgents > 0 ? "text-warning" : "opacity-80"} />
              <span>{runningAgents > 0 ? runningAgents : subagents.length}</span>
            </span>
            {hasTodos && <Divider />}
          </>
        )}

        {/* Tasks segment — completed / total. */}
        {hasTodos && (
          <span className="flex items-center gap-1 tabular-nums">
            <IconListDetails size={13} className="opacity-80" />
            <span>{todoDone}/{todos.length}</span>
          </span>
        )}

        {/* Expand/collapse affordance — a chevron that flips when the
            popover is open. Separated from the segments by a thin divider
            so it reads as a control, not another metric. */}
        <span className="ml-0.5 h-3 w-px bg-edge/60" />
        <IconChevronDown
          size={12}
          className={cn(
            "shrink-0 opacity-60 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <ActivityPopover todos={todos} plan={plan} subagents={subagents} />}
    </div>
  );
}

/** Thin vertical divider between capsule segments. */
function Divider() {
  return <span className="h-3 w-px bg-edge/60" />;
}

/** Context-window segment: hexagon icon tinted by warning level + compact
 *  pct. Reuses the same tooltip text as ContextRing so the detailed
 *  breakdown (input / cache / output / cost) shows on hover. */
function ContextSegment({ snapshot }: { snapshot: ContextSnapshot }) {
  const { pct, warning, usedTokens, maxTokens } = snapshot;
  const color = warningColor(warning);
  const title = buildContextTooltip(snapshot);
  return (
    <span className={cn("flex items-center gap-1 tabular-nums", color)} title={title}>
      <IconHexagon size={13} className="shrink-0" />
      <span className="font-medium">{fmtTokens(usedTokens)}</span>
      <span className="text-content-subtle">/</span>
      <span className="text-content-muted">{fmtTokens(maxTokens)}</span>
      <span className="text-content-subtle">·</span>
      <span>{pct}%</span>
    </span>
  );
}

/** Build the multi-line hover tooltip showing the token breakdown.
 *  Mirrors ContextRing's tooltip so the two stay in sync. */
function buildContextTooltip(s: ContextSnapshot): string {
  const cacheRead = s.cacheReadTokens ?? 0;
  const cacheCreation = s.cacheCreationTokens ?? 0;
  const freshInput = Math.max(0, s.usedTokens - cacheRead - cacheCreation);
  const lines: string[] = [
    `上下文占用  ${fmtTokens(s.usedTokens)} / ${fmtTokens(s.maxTokens)}  (${s.pct}%)`,
    `──────────────`,
    `输入        ${fmtTokens(freshInput)}`,
  ];
  if (cacheRead > 0) lines.push(`缓存读取    ${fmtTokens(cacheRead)}`);
  if (cacheCreation > 0) lines.push(`缓存写入    ${fmtTokens(cacheCreation)}`);
  lines.push(`输出        ${fmtTokens(s.outputTokens)}`);
  lines.push(`本轮处理    ${fmtTokens(s.totalProcessedTokens)}`);
  if (s.costUsd != null) lines.push(`费用        $${s.costUsd.toFixed(4)}`);
  return lines.join("\n");
}

// Re-exported so the warning→color mapping is reusable if needed elsewhere.
export { warningColor };
export type { ContextWarning };
