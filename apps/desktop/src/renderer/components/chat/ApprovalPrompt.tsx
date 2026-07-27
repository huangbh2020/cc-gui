import { useEffect, useRef, useState } from "react";

/**
 * Composer-area tool-approval overlay.
 *
 * Replaces the small amber chip above the composer. The version here is sized
 * to fully cover the textarea + toolbar underneath, with the textarea itself
 * disabled and pointer-blocked, so the user can't type a competing prompt
 * while a permission decision is pending. This matches Claude Code's own UI,
 * which also gates the input box on outstanding approvals.
 *
 * Queuing: when several approval.request events arrive in quick succession
 * (e.g. the model wants to run three Bash commands in one turn), the store
 * keeps them in a queue and the head — index 0 — is what this card renders.
 * The header shows "n / total" only when total > 1 so a single approval
 * stays visually quiet.
 *
 * Keyboard: Enter allows the head, Esc denies. The "允许" button auto-focuses
 * on mount so Enter works without an extra click. This is one-shot — when
 * the queue shifts, this card unmounts and the next one auto-focuses its
 * own button via the same effect.
 *
 * Amber theme distinguishes it from QuestionPrompt (info/blue) and
 * PlanApprovalPrompt (violet).
 */
export function ApprovalPrompt({
  toolName,
  input,
  description,
  queuePosition,
  queueTotal,
  onDecide,
}: {
  toolName: string;
  input: unknown;
  description?: string;
  /** 1-based index of this card in the queue. */
  queuePosition: number;
  /** Total cards in the queue; 1 means "no queue" (chip stays quiet). */
  queueTotal: number;
  /** granted=true → allow (with `always` if checked); granted=false → deny. */
  onDecide: (granted: boolean, always?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [always, setAlways] = useState(false);
  const allowRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // One-line hint mirroring MessageBlocks.toolSummary so the user sees what
  // the tool is about without expanding.
  const summary = summarizeTool(toolName, input);

  // Auto-focus the "允许" button on mount (and on every queue head shift),
  // so Enter confirms without an extra click. Also bring the whole card
  // into view in case the queue scrolled it out.
  useEffect(() => {
    allowRef.current?.focus();
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [toolName, queuePosition]);

  // Local keyboard: Esc denies, Enter allows (the focused button already
  // handles Enter natively, so this is just the Esc shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDecide(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDecide]);

  const decide = (granted: boolean) => {
    onDecide(granted, granted ? always : undefined);
  };

  return (
    <div
      ref={cardRef}
      role="alertdialog"
      aria-label="Claude 正在请求执行工具"
      className="relative min-h-[120px] rounded-xl border border-warning/60 bg-warning/20 px-4 py-3 text-xs text-content shadow-lg backdrop-blur"
    >
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden>⚠️</span>
          <span className="font-semibold text-warning">Claude 请求执行工具</span>
          {queueTotal > 1 && (
            <span
              className="rounded-full border border-warning/60 bg-warning/30 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-warning"
              title={`队列中还有 ${queueTotal - queuePosition} 个待审批`}
            >
              {queuePosition} / {queueTotal}
            </span>
          )}
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded px-1.5 py-0.5 text-[10px] text-warning hover:bg-warning/30"
          title={open ? "收起详情" : "查看工具输入"}
        >
          {open ? "▾ 收起" : "▸ 详情"}
        </button>
      </div>

      {/* Tool name + summary */}
      <div className="mb-2 rounded-md border border-warning/60 bg-surface/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <code className="font-mono text-[12px] font-semibold text-warning">{toolName}</code>
          {summary && (
            <span className="line-clamp-2 break-all text-content-muted">{summary}</span>
          )}
        </div>
        {description && <div className="mt-1 text-[11px] text-content-muted">{description}</div>}
      </div>

      {/* Expandable input */}
      {open && (
        <div className="mb-2">
          <div className="mb-0.5 text-[10px] uppercase text-content-subtle">Input</div>
          <pre className="max-h-40 overflow-auto rounded bg-surface/70 p-2 text-[11px] text-content-muted">
            {safeStringify(input)}
          </pre>
        </div>
      )}

      {/* Footer: always-allow checkbox + buttons. Stays on a single row at
          the bottom of the overlay so the rest of the card area is taken up
          by the tool-summary block (visually replaces the textarea space). */}
      <div className="flex items-center justify-between gap-2 border-t border-warning/60 pt-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-content-muted">
          <input
            type="checkbox"
            checked={always}
            onChange={(e) => setAlways(e.target.checked)}
            className="h-3 w-3 cursor-pointer accent-warning"
          />
          本会话内始终允许 {toolName}
        </label>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => decide(false)}
            className="rounded-md bg-surface-muted px-3 py-1 text-content-muted transition-colors hover:bg-surface-hover"
            title="拒绝 (Esc)"
          >
            拒绝
          </button>
          <button
            ref={allowRef}
            onClick={() => decide(true)}
            className="rounded-md bg-warning px-3 py-1 font-medium text-surface transition-colors hover:bg-warning focus:outline-none focus:ring-2 focus:ring-warning/60"
            title="允许 (Enter)"
          >
            允许
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── helpers ──────────────────────────── */

/** One-line hint for common tools. Mirrors MessageBlocks.toolSummary but kept
 * local to avoid a cross-module import for a pure display helper. */
function summarizeTool(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(obj.file_path ?? "");
    case "Bash":
    case "PowerShell":
      return String(obj.command ?? obj.description ?? "");
    case "Glob":
      return String(obj.pattern ?? "");
    case "Grep":
      return String(obj.pattern ?? "");
    case "TodoWrite":
      return "todos";
    default:
      return Object.values(obj).slice(0, 1).map(String).join("").slice(0, 60);
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
