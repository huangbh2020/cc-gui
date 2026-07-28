import { useState, useEffect, useRef } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconCheck,
  IconX,
  IconQuestionMark,
  IconSend2,
} from "@renderer/lib/icons.js";
import type { AskUserQuestionItem } from "@contracts/runtime";
import type { UserInputAnswers } from "@contracts/provider";

/**
 * Prompt card shown when claude invokes the AskUserQuestion tool.
 *
 * Anchored to the bottom of the ChatPane root (`relative`), positioned so
 * it visually replaces the composer: the outer wrapper mirrors the
 * composer's horizontal sizing — `px-8` side gutters + `mx-auto max-w-5xl`
 * inner column — so the card is exactly as wide as the input box and left/
 * right-aligned with the message stream. It sits slightly above the pane's
 * bottom edge (`pb-3`, matching the composer wrapper) so its rounded
 * corners and drop shadow read as a floating card rather than a flush bar.
 *
 * Layout: a single rounded, bordered, elevated card with three stacked
 * regions — a fixed header (question count + dismiss), a scrollable body,
 * and a fixed footer (progress + submit). Every question renders as its
 * own block in the body (header + question text + options + free-text
 * input), stacked vertically with dividers — there is no stepper/tab
 * navigation; all questions are answered in one pass. The body scrolls
 * when content overflows the `max-h` cap, keeping the submit button always
 * reachable.
 *
 * Styling uses the `accent` (emerald) token for all interactive/emphasis
 * states — selected options, the header accent, focus — plus neutral
 * surface/edge tokens for the card frame. This matches the composer's own
 * `focus-within:border-accent` treatment and works in both light and dark
 * themes. No violet/purple is used.
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
  // answers[i] holds: selected option labels + optional free text.
  const [answers, setAnswers] = useState<Array<{ selected: string[]; text: string }>>(
    questions.map(() => ({ selected: [], text: "" })),
  );

  /** Toggle an option on question `qi`. Single-select replaces the pick
   *  (toggling the active option clears it); multi-select adds/removes. */
  const toggle = (qi: number, label: string) => {
    setAnswers((prev) =>
      prev.map((item, i) => {
        if (i !== qi) return item;
        const q = questions[i];
        if (q.multiSelect) {
          const has = item.selected.includes(label);
          return {
            ...item,
            selected: has ? item.selected.filter((s) => s !== label) : [...item.selected, label],
          };
        }
        return { ...item, selected: item.selected[0] === label ? [] : [label] };
      }),
    );
  };

  const setFreeText = (qi: number, text: string) => {
    setAnswers((prev) => prev.map((item, i) => (i === qi ? { ...item, text } : item)));
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
    // Outer wrapper mirrors the composer's horizontal sizing so the card is
    // exactly as wide as the input box: `px-8` side gutters (32px) +
    // `mx-auto max-w-5xl` centered inner column. `pb-3` lifts the card off
    // the pane's bottom edge so the rounded corners + shadow read as a
    // floating card (matches the composer wrapper's own bottom padding).
    <div className="absolute inset-x-0 bottom-0 z-30 px-8 pb-3">
      <div
        role="dialog"
        aria-modal="false"
        aria-label="Claude 正在提问"
        className={cn(
          "mx-auto flex max-h-[70%] max-w-5xl flex-col overflow-hidden rounded-2xl",
          "border border-edge-input bg-surface text-xs text-content shadow-2xl",
          "animate-[qa-sheet-in_140ms_ease-out]",
        )}
      >
        {/* Header — fixed at top */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <IconQuestionMark size={14} className="shrink-0 text-accent" />
            <span className="font-semibold text-accent">
              {questions.length === 1 ? "Claude 有一个问题需要回答" : `Claude 有 ${questions.length} 个问题需要回答`}
            </span>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            title="忽略这次提问"
            aria-label="忽略这次提问"
            className="rounded p-0.5 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            <IconX size={14} />
          </button>
        </div>

        {/* Scrollable body — every question renders as its own block,
            stacked vertically with dividers. No stepper/tab navigation;
            all questions are answered in one pass. The body scrolls when
            content overflows the max-h cap, keeping the footer reachable. */}
        <div className="flex-1 overflow-y-auto">
          {questions.map((q, qi) => {
            const a = answers[qi];
            return (
              <div
                key={qi}
                className={cn("px-4 py-3", qi > 0 && "border-t border-edge")}
              >
                {/* Question header + text */}
                <div className="mb-2 leading-relaxed text-content">
                  <span className="mr-1 font-semibold text-accent">{q.header}:</span>
                  {q.question}
                  {q.multiSelect && (
                    <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-content-muted">
                      可多选
                    </span>
                  )}
                </div>

                {/* Options */}
                <div className="space-y-1.5">
                  {q.options.map((opt, oi) => {
                    const selected = a.selected.includes(opt.label);
                    return (
                      <button
                        key={oi}
                        type="button"
                        onClick={() => toggle(qi, opt.label)}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                          selected
                            ? "border-accent bg-accent/10"
                            : "border-edge bg-surface hover:border-accent/60 hover:bg-accent/5",
                        )}
                        title={opt.description}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors",
                            q.multiSelect ? "rounded-sm" : "rounded-full",
                            selected
                              ? "border-accent bg-accent text-surface"
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
                  onChange={(e) => setFreeText(qi, e.target.value)}
                  placeholder="或输入自定义回答…"
                  className="mt-2 font-sans"
                />
              </div>
            );
          })}
        </div>

        {/* Footer — fixed at bottom, always visible */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-edge bg-surface-muted/40 px-4 py-2.5">
          <span className="text-[10px] tabular-nums text-content-subtle">
            {answeredCount} / {questions.length} 已回答
          </span>
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
