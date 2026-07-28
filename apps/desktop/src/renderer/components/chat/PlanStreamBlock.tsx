import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconClipboard,
  IconChevronDown,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import { Markdown } from "./Markdown.js";
import type { PlanUpdateEvent } from "@contracts/runtime";

/**
 * Read-only inline plan card rendered in the message stream (at the turn's
 * output tail, before the TurnFilesCard). Keeps the plan visible as a
 * collapsible card the user can expand/collapse to review the full drafted /
 * approved plan text without blocking the composer.
 *
 * Drafting phase: the model is still working on the plan (EnterPlanMode was
 *   called, ExitPlanMode hasn't been approved yet). Shows a "草拟中" badge.
 * Ready phase: the model called ExitPlanMode and (if applicable) the user
 *   approved it. Shows "已就绪" and stays rendered after the turn ends so the
 *   the user can revisit the plan they approved.
 *
 * Editing / approve / reject actions live in the PlanApprovalPrompt sheet above
 * the composer — this component is purely for reading the plan content in-line
 * in the conversation flow.
 *
 * Theme: neutral surface/edge tokens only (no accent) so it reads as a passive
 * snapshot of the plan, not an actionable approval surface.
 */
export function PlanStreamBlock({
  plan,
  phase,
  hasApproval,
}: {
  plan: string;
  phase: PlanUpdateEvent["phase"];
  /** True when an ExitPlanMode approval is pending (the compact
   *  PlanApprovalPrompt sheet is shown above the composer). Drives the badge
   *  label on this card so the user knows an action is awaiting them. */
  hasApproval?: boolean;
}) {
  const isDrafting = phase === "drafting";
  // Default expand state by lifecycle:
  //   drafting / 待审阅 → expanded (user is actively watching the plan form /
  //     reviewing it for approval, so show the content up front).
  //   ready → collapsed (the plan is frozen history; the header + char count
  //     is enough at a glance, expand on demand to avoid flooding the stream).
  const [expanded, setExpanded] = useState(isDrafting || !!hasApproval);

  const label = hasApproval ? "待审阅" : isDrafting ? "草拟中" : "已就绪";

  return (
    <div className="rounded-xl border border-edge bg-surface-muted/40 px-3 py-2 text-xs text-content-muted backdrop-blur">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <IconClipboard size={14} className="shrink-0 text-content-subtle" />
        <span className="font-semibold text-content-muted">计划</span>
        {/* Status badge */}
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium",
            hasApproval
              ? "bg-accent/15 text-accent"
              : isDrafting
                ? "bg-surface-hover text-content-subtle"
                : "bg-surface-hover text-content-subtle",
          )}
        >
          {label}
        </span>
        {/* Char-count summary */}
        <span className="text-content-subtle">{plan.length} 字</span>
        <span className="ml-auto text-content-subtle">
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-edge bg-surface/60 p-3">
          <div className="prose-plan text-[11px] leading-relaxed text-content">
            <Markdown>{plan || "_(计划为空)_"}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}
