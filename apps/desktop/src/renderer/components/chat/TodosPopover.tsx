import type { TodoItem } from "@renderer/stores/sessionStore.js";

/** Status glyph + tint per todo status. */
const STATUS_META: Record<TodoItem["status"], { icon: string; cls: string }> = {
  pending: { icon: "○", cls: "text-zinc-500" },
  in_progress: { icon: "◐", cls: "text-amber-400" },
  completed: { icon: "✓", cls: "text-emerald-400" },
};

/** Left accent per priority. */
const PRIORITY_BAR: Record<TodoItem["priority"], string> = {
  high: "border-l-red-500",
  medium: "border-l-amber-500",
  low: "border-l-zinc-600",
};

/**
 * Tasks popover — the expanded view of the tasks capsule. ZCode-style: glassy
 * card, clear status tints, completion count header. Pure presentational;
 * open/close is controlled by the parent.
 */
export function TodosPopover({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  return (
    <div className="absolute right-0 top-9 z-30 w-80 overflow-hidden rounded-xl border border-white/10 bg-zinc-900/95 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <span className="text-xs font-semibold text-zinc-200">Tasks</span>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] tabular-nums text-zinc-400">
          {done}/{todos.length} · {pct}%
        </span>
      </div>
      <ul className="max-h-80 overflow-y-auto py-1">
        {todos.map((t, i) => {
          const meta = STATUS_META[t.status];
          return (
            <li key={i} className={`flex items-start gap-2 border-l-2 px-3 py-1.5 ${PRIORITY_BAR[t.priority]}`}>
              <span className={`mt-0.5 shrink-0 text-xs ${meta.cls}`}>{meta.icon}</span>
              <span
                className={`text-xs leading-relaxed ${
                  t.status === "completed" ? "text-zinc-600 line-through" : "text-zinc-300"
                }`}
              >
                {t.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
