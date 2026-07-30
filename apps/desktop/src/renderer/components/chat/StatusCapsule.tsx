import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconRobot,
  IconListDetails,
  IconChevronDown,
} from "@renderer/lib/icons.js";
import type { ContextSnapshot, SubagentSnapshot } from "@contracts/runtime";
import type { TodoItem, PlanDraft, TurnUsageRecord } from "@renderer/stores/sessionStore.js";
import { ActivityPopover } from "./ActivityPopover.js";

/**
 * Unified status capsule for the sticky top-right of the chat stream.
 * Consolidates what used to be three separate chips (UsageChip +
 * SubagentsChip + TaskRing button) into ONE glassy pill, so the top-right
 * stays calm even when subagents + todos are all active.
 *
 * Layout: a single rounded container with up to two segments separated by a
 * thin divider. Each segment = icon + compact number. Segments are omitted
 * when their source is empty (no todos -> no tasks segment), so the capsule
 * gracefully degrades, and renders nothing at all when every segment is empty.
 *
 * Click the capsule to open the ActivityPopover (the unified detail panel -
 * plan / subagents / tasks / usage). The context-window breakdown lives only
 * in that popover now, keeping the pill itself lean.
 */
export function StatusCapsule({
  snapshot,
  usageHistory,
  subagents,
  todos,
  plan,
}: {
  snapshot?: ContextSnapshot;
  usageHistory?: TurnUsageRecord[];
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  plan: PlanDraft;
}) {
  const [open, setOpen] = useState(false);
  const runningAgents = subagents.filter((a) => a.status === "running").length;
  const hasSubagents = subagents.length > 0;
  const hasTodos = todos.length > 0;
  const todoDone = todos.filter((t) => t.status === "completed").length;

  // At least one segment must be present, else render nothing.
  if (!hasSubagents && !hasTodos) return null;

  return (
    <div className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium shadow-md transition-all",
          open
            ? "border-accent/50 bg-accent/15 text-accent"
            : "border-content-subtle/40 bg-surface-hover text-content hover:brightness-95 dark:hover:brightness-110",
        )}
        title="查看活动详情（任务 / 子代理 / 上下文）"
      >
        {/* Subagents segment - only when any exist. Pulsing dot while running. */}
        {hasSubagents && (
          <>
            <span className="flex items-center gap-1 tabular-nums">
              {runningAgents > 0 && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              )}
              <IconRobot size={13} className={runningAgents > 0 ? "text-warning" : "opacity-90"} />
              <span>{runningAgents > 0 ? runningAgents : subagents.length}</span>
            </span>
            {hasTodos && <Divider />}
          </>
        )}

        {/* Tasks segment - completed / total. */}
        {hasTodos && (
          <span className="flex items-center gap-1 tabular-nums">
            <IconListDetails size={13} className="opacity-90" />
            <span>{todoDone}/{todos.length}</span>
          </span>
        )}

        {/* Expand/collapse affordance - a chevron that flips when the
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
      {open && (
        <ActivityPopover
          todos={todos}
          plan={plan}
          subagents={subagents}
          snapshot={snapshot}
          usageHistory={usageHistory ?? []}
        />
      )}
    </div>
  );
}

/** Thin vertical divider between capsule segments. */
function Divider() {
  return <span className="h-3 w-px bg-edge/60" />;
}
