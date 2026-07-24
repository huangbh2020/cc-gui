import { useState } from "react";
import type { AskUserQuestionItem } from "@contracts/runtime";

/**
 * Inline prompt shown above the composer when claude uses the AskUserQuestion
 * tool. Supports the full surface: multiple questions (tabbed), single- and
 * multi-select options, plus a free-text input per question. On submit the
 * answers are composed into one message and sent as the next user turn (claude
 * auto-cancels the tool result in non-interactive mode, so the answer can't be
 * written back into the finished turn — the next message carries it).
 */
export function QuestionPrompt({
  questions,
  onSubmit,
  onDismiss,
}: {
  questions: AskUserQuestionItem[];
  onSubmit: (text: string) => void;
  onDismiss: () => void;
}) {
  const [active, setActive] = useState(0);
  // answers[i] holds: selected option labels + optional free text.
  const [answers, setAnswers] = useState<Array<{ selected: string[]; text: string }>>(
    questions.map(() => ({ selected: [], text: "" })),
  );

  const q = questions[active];
  const a = answers[active];

  const toggle = (label: string) => {
    setAnswers((prev) =>
      prev.map((item, i) => {
        if (i !== active) return item;
        if (q.multiSelect) {
          const has = item.selected.includes(label);
          return { ...item, selected: has ? item.selected.filter((s) => s !== label) : [...item.selected, label] };
        }
        // single select: replace
        return { ...item, selected: item.selected[0] === label ? [] : [label] };
      }),
    );
  };

  const answeredCount = answers.filter((x) => x.selected.length > 0 || x.text.trim()).length;
  const allAnswered = answeredCount === questions.length;

  const submit = () => {
    // Compose "Q: ... \n A: ..." for each answered question.
    const parts: string[] = [];
    questions.forEach((qq, i) => {
      const aa = answers[i];
      const bits = [...aa.selected];
      if (aa.text.trim()) bits.push(aa.text.trim());
      if (bits.length === 0) return;
      parts.push(`${qq.question}\n→ ${bits.join(", ")}`);
    });
    if (parts.length === 0) return;
    onSubmit(parts.join("\n\n"));
  };

  return (
    <div className="mb-2 rounded-xl border border-violet-700/50 bg-violet-950/30 px-3 py-2.5 text-xs backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-violet-300">Claude is asking</span>
        <button
          onClick={onDismiss}
          className="rounded px-1.5 text-violet-400 hover:bg-violet-900/50 hover:text-violet-200"
          title="Dismiss"
        >
          ✕
        </button>
      </div>

      {/* Tabs for multiple questions */}
      {questions.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {questions.map((qq, i) => {
            const done = answers[i].selected.length > 0 || answers[i].text.trim();
            return (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={`rounded-md px-2 py-0.5 text-[10px] transition-colors ${
                  i === active ? "bg-violet-700/60 text-violet-100" : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-700/60"
                }`}
                title={qq.header}
              >
                {done && "✓ "}
                {qq.header}
              </button>
            );
          })}
        </div>
      )}

      {/* Active question */}
      <div className="space-y-2">
        <div className="text-zinc-200">
          <span className="mr-1 font-semibold text-zinc-100">{q.header}:</span>
          {q.question}
          {q.multiSelect && <span className="ml-1 text-[10px] text-zinc-500">(可多选)</span>}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {q.options.map((opt, oi) => {
            const selected = a.selected.includes(opt.label);
            return (
              <button
                key={oi}
                onClick={() => toggle(opt.label)}
                className={`group rounded-md border px-2.5 py-1 text-left transition-colors ${
                  selected
                    ? "border-violet-400 bg-violet-800/60 text-violet-100"
                    : "border-zinc-700 bg-zinc-900 hover:border-violet-500 hover:bg-violet-900/30"
                }`}
                title={opt.description}
              >
                <span className="font-medium">{selected ? "✓ " : ""}{opt.label}</span>
                {opt.description && (
                  <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">{opt.description}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Free-text input */}
        <input
          type="text"
          value={a.text}
          onChange={(e) =>
            setAnswers((prev) => prev.map((item, i) => (i === active ? { ...item, text: e.target.value } : item)))
          }
          placeholder="或在此输入自定义回答…"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950/70 px-2.5 py-1.5 text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none"
        />
      </div>

      {/* Footer */}
      <div className="mt-2.5 flex items-center justify-between border-t border-violet-800/40 pt-2">
        <span className="text-[10px] text-zinc-500">
          {answeredCount}/{questions.length} 已回答
        </span>
        <div className="flex items-center gap-1.5">
          {questions.length > 1 && active > 0 && (
            <button
              onClick={() => setActive((v) => v - 1)}
              className="rounded-md bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700"
            >
              上一题
            </button>
          )}
          {questions.length > 1 && active < questions.length - 1 && (
            <button
              onClick={() => setActive((v) => v + 1)}
              className="rounded-md bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700"
            >
              下一题
            </button>
          )}
          <button
            onClick={submit}
            disabled={!allAnswered}
            className="rounded-md bg-violet-600 px-3 py-1 font-medium text-violet-50 transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            title={allAnswered ? "提交所有回答" : "请先回答所有问题"}
          >
            提交回答
          </button>
        </div>
      </div>
    </div>
  );
}
