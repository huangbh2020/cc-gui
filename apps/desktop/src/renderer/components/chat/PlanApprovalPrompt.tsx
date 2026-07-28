import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconRocket,
  IconPencil,
  IconCheck,
  IconX,
} from "@renderer/lib/icons.js";
import { Markdown } from "./Markdown.js";

/**
 * Floating plan-approval card shown above the composer when the model calls
 * ExitPlanMode in plan mode (per the Snowflake/SDK plan-mode flow).
 *
 * The model has drafted a plan and is waiting for the user to approve it
 * before executing. Approve → SDK exits plan mode and starts executing;
 * Reject → SDK stays in plan mode and the model can revise and re-request.
 *
 * The user may edit the plan text before approving — the edited version is
 * passed back through `updatedInput.plan` so the SDK records what was actually
 * approved.
 *
 * Styling mirrors QuestionPrompt: a single rounded, bordered, elevated card
 * using the `accent` (emerald) token for emphasis — the header label, the
 * "批准" primary button — and neutral surface/edge tokens for the frame. The
 * card is wrapped in the same `px-8 + mx-auto max-w-5xl` column as the
 * composer so it matches the input-box width. No violet/purple is used.
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
    // Outer wrapper mirrors the composer's horizontal sizing so the card is
    // exactly as wide as the input box: `px-8` side gutters + `mx-auto
    // max-w-5xl` centered inner column. `pb-2` lifts the card off whatever
    // sits below it (the composer / QuestionPrompt sheet).
    <div className="px-8 pb-2">
      <div
        className={cn(
          "mx-auto max-w-5xl rounded-2xl border border-edge-input bg-surface px-4 py-3 text-xs text-content shadow-2xl",
          "animate-[qa-sheet-in_140ms_ease-out]",
        )}
      >
        {/* Header */}
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <IconRocket size={14} className="shrink-0 text-accent" />
            <span className="font-semibold text-accent">计划已就绪 · 请审阅</span>
          </div>
          <span className="shrink-0 text-[10px] text-content-subtle">批准后将退出计划模式并开始执行</span>
        </div>

        {/* Plan body: rendered Markdown by default, textarea when editing */}
        <div className="mb-2.5 max-h-64 overflow-auto rounded-lg border border-edge bg-surface-muted/40 p-3">
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              className="min-h-32 w-full resize-y bg-transparent font-mono text-[11px] leading-relaxed text-content outline-none"
              placeholder="编辑计划内容…"
            />
          ) : (
            <div className="prose-plan text-[11px] leading-relaxed text-content">
              <Markdown>{plan || "_(计划为空)_"}</Markdown>
            </div>
          )}
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
        <div className="flex items-center justify-between gap-2 border-t border-edge pt-2.5">
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
    </div>
  );
}
