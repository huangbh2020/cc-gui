import { useState } from "react";
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
 * Styling mirrors QuestionPrompt (violet theme) since both are "the agent is
 * blocked waiting for the user" prompts.
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
    <div className="mb-2 rounded-xl border border-info/60 bg-info/30 px-3 py-2.5 text-xs backdrop-blur">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-info">⚡ 计划已就绪 · 请审阅</span>
        <span className="text-[10px] text-content-subtle">批准后将退出计划模式并开始执行</span>
      </div>

      {/* Plan body: rendered Markdown by default, textarea when editing */}
      <div className="mb-2 max-h-64 overflow-auto rounded-md border border-info/60 bg-surface/40 p-2">
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
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
          placeholder="拒绝理由（可选，会反馈给 Claude）…"
          className="mb-2 w-full rounded-md border border-edge bg-surface/70 px-2.5 py-1.5 text-content placeholder:text-content-subtle focus:border-danger focus:outline-none"
        />
      )}

      {/* Action footer */}
      <div className="flex items-center justify-between border-t border-info/60 pt-2">
        <button
          onClick={() => setEditing((v) => !v)}
          className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
            editing
              ? "bg-info text-surface hover:bg-info"
              : "text-content-muted hover:bg-surface-muted hover:text-content"
          }`}
          title={editing ? "返回查看渲染后的计划" : "直接编辑计划文本"}
        >
          {editing ? "✓ 完成编辑" : "✎ 编辑计划"}
        </button>
        <div className="flex items-center gap-1.5">
          {rejecting ? (
            <>
              <button
                onClick={() => {
                  setRejecting(false);
                  setReason("");
                }}
                className="rounded-md bg-surface-muted px-2.5 py-1 text-content-muted hover:bg-surface-hover"
              >
                取消
              </button>
              <button
                onClick={handleReject}
                className="rounded-md bg-danger px-3 py-1 font-medium text-surface transition-colors hover:bg-danger"
              >
                确认拒绝
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setRejecting(true)}
                className="rounded-md bg-surface-muted px-2.5 py-1 text-content-muted transition-colors hover:bg-surface-hover"
              >
                拒绝
              </button>
              <button
                onClick={handleApprove}
                className="rounded-md bg-info px-3 py-1 font-medium text-surface transition-colors hover:bg-info"
                title={edited ? "批准并使用你编辑后的计划" : "批准该计划"}
              >
                {edited ? "批准(已编辑)" : "批准并执行"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
