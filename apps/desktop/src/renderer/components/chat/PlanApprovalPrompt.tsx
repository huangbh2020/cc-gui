import { useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
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
 * of the plan or the conversation. It carries only the action row: edit (opens
 * the plan in the editor column for Monaco editing), reject (with optional
 * reason), and approve.
 *
 * Editing flow: "编辑计划" opens the plan tab in the editor column (handled by
 * the parent via `onEditPlan`). Edits made there are staged into
 * `planApprovalDraftBySession` by PlanViewer's save action, and this sheet
 * reads that draft back so the "已编辑" indicator + "批准(已编辑)" reflect the
 * editor's content. The user still has to press 批准 to submit - editing in
 * the editor never auto-approves.
 *
 * - Default (idle): a single compact row - "计划已就绪 · 请审阅" + [编辑] [拒绝]
 *   [批准并执行]. Takes one line, doesn't block reading the plan card.
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
  sessionId,
  plan,
  onEditPlan,
  onApprove,
  onReject,
}: {
  sessionId: string;
  plan: string;
  /** Open the plan in the editor column (Monaco) for editing. The parent
   *  activates the plan tab; PlanViewer stages edits back into the store. */
  onEditPlan: () => void;
  /** Approve, optionally with an edited plan text. */
  onApprove: (editedPlan?: string) => void;
  /** Reject with an optional feedback reason shown to the model. */
  onReject: (reason?: string) => void;
}) {
  // The edited draft is staged by PlanViewer's save action. Falls back to the
  // original plan when nothing has been edited yet.
  const draft = useSessionStore(
    (s) => s.planApprovalDraftBySession[sessionId] ?? plan,
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const edited = draft.trim() !== plan.trim();

  const handleApprove = () => {
    // Only pass the edited text if it actually changed, so an untouched
    // approve doesn't accidentally rewrite the plan.
    onApprove(edited ? draft : undefined);
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
          variant="ghost"
          size="sm"
          onClick={onEditPlan}
          title="在编辑器中编辑计划"
        >
          <IconPencil size={12} />
          {edited ? "编辑计划（已编辑）" : "编辑计划"}
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
