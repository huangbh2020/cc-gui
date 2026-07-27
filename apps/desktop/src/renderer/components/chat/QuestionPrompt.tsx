import { useState, useEffect, useRef } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconChevronLeft,
  IconChevronRight,
  IconCheck,
  IconX,
  IconQuestionMark,
  IconSend2,
} from "@renderer/lib/icons.js";
import type { AskUserQuestionItem } from "@contracts/runtime";
import type { UserInputAnswers } from "@contracts/provider";

/**
 * Bottom-sheet prompt shown when claude invokes the AskUserQuestion tool.
 * Anchored to the bottom of the whole ChatPane (not the composer) so it can
 * grow upward beyond the input-box height — long option lists and many
 * questions no longer get clipped to the composer's ~90px.
 *
 * Positioning: `absolute inset-x-0 bottom-0` inside the ChatPane's
 * `relative` root. Width follows the pane; height sizes to content with a
 * `max-h` cap, and the body scrolls when options overflow. This visually
 * replaces the composer (sitting on top of it) and forces the user to
 * answer before they can type a competing prompt — mirroring how Claude
 * Code itself surfaces AskUserQuestion.
 *
 * Layout: fixed header (question count + dismiss) + scrollable body (stepper
 * tabs, active question, options, free-text input) + fixed footer (progress
 * + nav + submit). The body scrolls when the option list is long, so the
 * submit button is always reachable. A subtle backdrop dims the message
 * stream behind the sheet (click-through, not modal — Esc still dismisses).
 *
 * Single-select auto-advance: when a single-select question gets its first
 * pick, we automatically move to the next unanswered question (or, on the
 * last question, keep focus on it so the user can hit Submit). Multi-select
 * never auto-advances — the user toggles multiple options then navigates
 * manually. Free-text entry never auto-advances either.
 *
 * On submit the answers are returned as a `UserInputAnswers` map keyed by
 * question text (matches the SDK's convention). The caller forwards this to
 * `claude:respondQuestion`, which resolves the provider's pending
 * user-input Deferred — the SAME turn then continues.
 */
export function QuestionPrompt({
  questions,
  onSubmit,
  onDismiss,
}: {
  questions: AskUserQuestionItem[];
  onSubmit: (answers: UserInputAnswers) => void;
  onDismiss: () => void;
}) {
  const [active, setActive] = useState(0);
  // answers[i] holds: selected option labels + optional free text.
  const [answers, setAnswers] = useState<Array<{ selected: string[]; text: string }>>(
    questions.map(() => ({ selected: [], text: "" })),
  );

  const q = questions[active];
  const a = answers[active];

  /** Find the index of the next question that isn't answered yet, searching
   *  forward from `from` (wrapping around). Returns -1 if every question is
   *  answered. Used by single-select auto-advance. */
  const nextUnanswered = (from: number): number => {
    const n = questions.length;
    for (let step = 1; step <= n; step++) {
      const i = (from + step) % n;
      const aa = answers[i];
      if (aa.selected.length === 0 && !aa.text.trim()) return i;
    }
    return -1;
  };

  const toggle = (label: string) => {
    setAnswers((prev) =>
      prev.map((item, i) => {
        if (i !== active) return item;
        if (q.multiSelect) {
          const has = item.selected.includes(label);
          return {
            ...item,
            selected: has ? item.selected.filter((s) => s !== label) : [...item.selected, label],
          };
        }
        // single select: replace (toggle off if same). Auto-advance on a
        // fresh pick (selected was empty → now has one); a re-toggle to
        // clear doesn't advance.
        const wasEmpty = item.selected.length === 0;
        const nextSelected = item.selected[0] === label ? [] : [label];
        if (wasEmpty && nextSelected.length > 0 && questions.length > 1) {
          // Defer the auto-advance so this setAnswers commits first; pick
          // the next unanswered question (wraps around; stays on the last
          // question if it's the only one left).
          const target = nextUnanswered(active);
          if (target !== -1 && target !== active) {
            setTimeout(() => setActive(target), 0);
          }
        }
        return { ...item, selected: nextSelected };
      }),
    );
  };

  const answeredCount = answers.filter((x) => x.selected.length > 0 || x.text.trim()).length;
  const allAnswered = answeredCount === questions.length;

  const submit = () => {
    // Compose the SDK-shaped answers map: keyed by question text, value is
    // the joined labels (multi-select), the single label (single-select),
    // or the free text. Unanswered questions are omitted.
    const out: UserInputAnswers = {};
    questions.forEach((qq, i) => {
      const aa = answers[i];
      const bits = [...aa.selected];
      if (aa.text.trim()) bits.push(aa.text.trim());
      if (bits.length === 0) return;
      out[qq.question] = qq.multiSelect ? bits : bits.join(", ");
    });
    if (Object.keys(out).length === 0) return;
    onSubmit(out);
  };

  // Enter submits when all answered (Shift+Enter adds a newline in the
  // free-text input). Esc dismisses.
  const submittingRef = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      } else if (e.key === "Enter" && !e.shiftKey && allAnswered && !submittingRef.current) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") {
          e.preventDefault();
          submittingRef.current = true;
          submit();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAnswered, answers, onDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Claude 正在提问"
      className={cn(
        // Anchor to the bottom of the ChatPane root and grow upward.
        // Width spans the pane; height is content-driven with a cap; the
        // body scrolls when options overflow. `z-30` sits above the
        // composer (z-10) and message stream.
        "absolute inset-x-0 bottom-0 z-30 flex max-h-[70%] flex-col overflow-hidden",
        "border-t border-info/60 bg-surface/95 text-xs text-content shadow-2xl",
        "backdrop-blur supports-[backdrop-filter]:bg-surface/90",
        "animate-[qa-sheet-in_140ms_ease-out]",
      )}
    >
      {/* Header — fixed at top */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-info/30 bg-info/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <IconQuestionMark size={14} className="shrink-0 text-info" />
          <span className="font-semibold text-info">
            {questions.length === 1 ? "Claude 有一个问题需要回答" : `Claude 有 ${questions.length} 个问题需要回答`}
          </span>
          {questions.length > 1 && (
            <span className="rounded-full bg-info/20 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-info">
              {active + 1} / {questions.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          title="忽略这次提问"
          aria-label="忽略这次提问"
          className={cn(
            "rounded p-0.5 text-info/70 transition-colors hover:bg-info/30 hover:text-info",
          )}
        >
          <IconX size={14} />
        </button>
      </div>

      {/* Scrollable body — holds the stepper tabs, the active question,
          its options, and the free-text input. flex-1 so it fills the
          space between the fixed header and footer, scrolling when the
          option list is long. */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {/* Multi-question stepper tabs */}
        {questions.length > 1 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {questions.map((qq, i) => {
              const done = answers[i].selected.length > 0 || answers[i].text.trim();
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                    i === active
                      ? "bg-info/30 text-info"
                      : "bg-surface-muted/60 text-content-muted hover:bg-surface-hover/70 hover:text-content",
                  )}
                  title={qq.header}
                >
                  <span
                    className={cn(
                      "flex h-3 w-3 items-center justify-center rounded-full border text-[8px]",
                      done
                        ? "border-info bg-info text-surface"
                        : "border-edge text-content-subtle",
                    )}
                  >
                    {done ? <IconCheck size={8} /> : i + 1}
                  </span>
                  <span className="max-w-[110px] truncate">{qq.header}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Active question body */}
        <div className="space-y-2">
          <div className="leading-relaxed text-content">
            <span className="mr-1 font-semibold text-info">{q.header}:</span>
            {q.question}
            {q.multiSelect && (
              <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-content-muted">
                可多选
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            {q.options.map((opt, oi) => {
              const selected = a.selected.includes(opt.label);
              return (
                <button
                  key={oi}
                  type="button"
                  onClick={() => toggle(opt.label)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                    selected
                      ? "border-info bg-info/15"
                      : "border-edge bg-surface hover:border-info/60 hover:bg-info/5",
                  )}
                  title={opt.description}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors",
                      q.multiSelect ? "rounded-sm" : "rounded-full",
                      selected
                        ? "border-info bg-info text-surface"
                        : "border-edge text-transparent",
                    )}
                  >
                    <IconCheck size={10} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-content">
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span className="mt-0.5 block text-[10px] leading-snug text-content-subtle">
                        {opt.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Free-text input */}
          <Input
            type="text"
            value={a.text}
            onChange={(e) =>
              setAnswers((prev) =>
                prev.map((item, i) => (i === active ? { ...item, text: e.target.value } : item)),
              )
            }
            placeholder="或输入自定义回答…"
            className="font-sans"
          />
        </div>
      </div>

      {/* Footer — fixed at bottom, always visible */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-info/30 bg-info/5 px-3 py-2">
        <span className="text-[10px] tabular-nums text-content-subtle">
          {answeredCount} / {questions.length} 已回答
        </span>
        <div className="flex items-center gap-1">
          {questions.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActive((v) => Math.max(0, v - 1))}
              disabled={active === 0}
            >
              <IconChevronLeft size={12} />
              上一题
            </Button>
          )}
          {questions.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActive((v) => Math.min(questions.length - 1, v + 1))}
              disabled={active >= questions.length - 1}
            >
              下一题
              <IconChevronRight size={12} />
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={!allAnswered}
            title={allAnswered ? "提交回答 (Enter)" : "请先回答所有问题"}
          >
            <IconSend2 size={12} />
            提交回答
          </Button>
        </div>
      </div>
    </div>
  );
}
