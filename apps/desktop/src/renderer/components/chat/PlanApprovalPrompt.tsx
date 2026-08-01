import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconRocket,
  IconPencil,
  IconCheck,
  IconX,
} from "@renderer/lib/icons.js";

/**
 * Compact plan-approval sheet shown above the composer when the model calls
 * ExitPlanMode in plan mode.
 *
 * The full plan text is shown inline in the message stream via PlanStreamBlock
 * - this sheet is intentionally minimal so it doesn't obstruct the user's view
 * of the plan or the conversation. It carries only the action row: edit (the
 * one part that needs the plan text), reject (with optional reason), and
 * approve.
 *
 * - Default (idle): a single compact row - "计划已就绪 · 请审阅" + [编辑] [拒绝]
 *   [批准并执行]. Takes one line, doesn't block reading the plan card.
 * - Editing: expands a textarea for direct plan editing. "完成编辑" collapses
 *   back to the compact row.
 * - Rejecting: expands a reason input + confirm/cancel.
 *
 * Positioning: rendered inside the composer's width-constrained column (see
 * ChatPane), so it inherits the same `px-[var(--chat-gutter)]` +
 * `mx-auto max-w-5xl` sizing as the input box and sits directly above the
 * textarea - mirroring ApprovalPrompt. `mb-2` lifts it off the input box.
 *
 * Styling: accent (emerald) token for the header label and approve button -
 * this is the one actionable approval surface, so the accent signals "press
 * this to proceed". Matches the composer's accent usage (send button etc.).
 */
export function PlanApprovalPrompt({
  plan,
  onApprove,
  onReject,
}: {
  plan: string;
  /** Approve, optionally with an edited plan text. */
  onApprove: (editedPlan?: string) => void;
  /** Reject with an optional feedback reason shown to the model. */
  onReject: (reason?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const edited = draft.trim() !== plan.trim();

  const handleApprove = () => {
    // Only pass the edited text if it actually changed AND editing is open,
    // so an untouched approve doesn't accidentally rewrite the plan.
    onApprove(editing && edited ? draft : undefined);
  };

  const handleReject = () => {
    onReject(reason.trim() || undefined);
  };

  return (
    <div
      className={cn(
        "mb-2 rounded-2xl border border-edge-input bg-surface px-4 py-2.5 text-xs text-content shadow-2xl",
        "animate-[qa-sheet-in_140ms_ease-out]",
      )}
    >
      {/* Compact header - always visible */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <IconRocket size={14} className="shrink-0 text-accent" />
          <span className="font-semibold text-accent">计划已就绪 · 请审阅</span>
        </div>
        <span className="shrink-0 text-[10px] text-content-subtle">
          {edited ? "已编辑" : "批准后将退出计划模式并开始执行"}
        </span>
      </div>

      {/* Editing textarea - only shown when actively editing */}
      {editing && (
        <div className="mb-2.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            className="max-h-64 min-h-32 w-full resize-y overflow-auto rounded-lg border border-edge bg-surface-muted/40 p-3 font-mono text-[11px] leading-relaxed text-content outline-none"
            placeholder="编辑计划内容…"
          />
        </div>
      )}

      {/* Reject reason input (collapsible) */}
      {rejecting && (
        <Input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
          placeholder="拒绝理由（可选，会反馈给 Claude）…"
          className="mb-2.5 font-sans"
        />
      )}

      {/* Action footer */}
      <div className="flex items-center justify-between gap-2 border-t border-edge pt-2">
        <Button
          variant={editing ? "primary" : "ghost"}
          size="sm"
          onClick={() => setEditing((v) => !v)}
          title={editing ? "返回查看渲染后的计划" : "直接编辑计划文本"}
        >
          {editing ? (
            <>
              <IconCheck size={12} />
              完成编辑
            </>
          ) : (
            <>
              <IconPencil size={12} />
              编辑计划
            </>
          )}
        </Button>
        <div className="flex items-center gap-1.5">
          {rejecting ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRejecting(false);
                  setReason("");
                }}
              >
                <IconX size={12} />
                取消
              </Button>
              <Button variant="danger" size="sm" onClick={handleReject}>
                <IconCheck size={12} />
                确认拒绝
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRejecting(true)}
              >
                <IconX size={12} />
                拒绝
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleApprove}
                title={edited ? "批准并使用你编辑后的计划" : "批准该计划"}
              >
                <IconRocket size={12} />
                {edited ? "批准(已编辑)" : "批准并执行"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
