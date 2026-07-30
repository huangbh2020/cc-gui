import { useMemo, useState } from "react";
import type { TodoItem, PlanDraft, TurnUsageRecord } from "@renderer/stores/sessionStore.js";
import type { ContextSnapshot, SubagentSnapshot } from "@contracts/runtime";
import { fmtTokens, getContextBreakdown } from "@renderer/lib/contextWindow.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconCoins,
  IconDatabase,
  IconArrowBarToDown,
  IconArrowBarToUp,
  IconStack2,
  IconCpu,
  IconClock,
} from "@renderer/lib/icons.js";
import { Markdown } from "./Markdown.js";

/* ── Tasks section (extracted from the old TodosPopover) ────────────── */

const STATUS_META: Record<TodoItem["status"], { icon: string; cls: string }> = {
  pending: { icon: "○", cls: "text-content-subtle" },
  in_progress: { icon: "◐", cls: "text-warning" },
  completed: { icon: "✓", cls: "text-accent" },
};

const PRIORITY_BAR: Record<TodoItem["priority"], string> = {
  high: "border-l-red-500",
  medium: "border-l-amber-500",
  low: "border-l-zinc-600",
};

/** Status tints per subagent lifecycle state. Exported so the capsule
 *  chip (SubagentsChip) can render matching labels/colors without
 *  duplicating the map. */
export const SUBAGENT_STATUS_META: Record<SubagentSnapshot["status"], { label: string; cls: string; spin?: boolean }> = {
  running: { label: "运行中", cls: "text-warning", spin: true },
  completed: { label: "已完成", cls: "text-accent" },
  failed: { label: "失败", cls: "text-danger" },
  killed: { label: "已终止", cls: "text-danger" },
};

/** Plan section phase labels. The badge color escalates with how far along
 *  plan mode is — `drafting` is informational, `ready` means the model is
 *  blocking on the user's decision. */
const PLAN_PHASE_META: Record<PlanDraft["phase"], { label: string; cls: string }> = {
  drafting: { label: "✎ 草拟中", cls: "text-info" },
  ready: { label: "⚡ 等待批准", cls: "text-warning" },
  cleared: { label: "", cls: "" },
};

/** Compact "1.2k tokens · 5 tools · 12s" string. Exported for reuse by the
 *  capsule chip's tooltip / popover. */
export function fmtUsage(snap: SubagentSnapshot): string {
  const parts: string[] = [];
  if (typeof snap.totalTokens === "number") parts.push(`${(snap.totalTokens / 1000).toFixed(1)}k tokens`);
  if (typeof snap.toolUses === "number") parts.push(`${snap.toolUses} tools`);
  if (typeof snap.durationMs === "number") parts.push(`${Math.round(snap.durationMs / 1000)}s`);
  return parts.join(" · ");
}

/** Truncate a string to N characters with an ellipsis, preserving newlines. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

/* ── Section primitives ─────────────────────────────────────────────── */

/** A horizontal section header: icon + title (left), badge/right slot. */
function SectionHeader({
  icon,
  title,
  right,
}: {
  icon: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
      <span className="text-[11px] font-semibold text-content-muted">
        <span className="mr-1 opacity-80">{icon}</span>
        {title}
      </span>
      {right && <span className="text-[10px] text-content-subtle">{right}</span>}
    </div>
  );
}

/* ── Section: Tasks ─────────────────────────────────────────────────── */

function TasksSection({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  return (
    <>
      <SectionHeader
        icon="✓"
        title="Tasks"
        right={
          <span className="rounded-full bg-surface-muted px-2 py-0.5 tabular-nums">
            {done}/{todos.length} · {pct}%
          </span>
        }
      />
      <ul className="max-h-60 overflow-y-auto py-1">
        {todos.map((t, i) => {
          const meta = STATUS_META[t.status];
          return (
            <li
              key={i}
              className={`flex items-start gap-2 border-l-2 px-3 py-1.5 ${PRIORITY_BAR[t.priority]}`}
            >
              <span className={`mt-0.5 shrink-0 text-xs ${meta.cls}`}>{meta.icon}</span>
              <span
                className={`text-xs leading-relaxed ${
                  t.status === "completed" ? "text-content-subtle line-through" : "text-content-muted"
                }`}
              >
                {t.content}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ── Section: Subagents ────────────────────────────────────────────── */

function SubagentsSection({ agents }: { agents: SubagentSnapshot[] }) {
  const running = agents.filter((a) => a.status === "running").length;
  return (
    <>
      <SectionHeader
        icon="🤖"
        title={`子代理 · ${agents.length} 个`}
        right={
          running > 0 ? (
            <span className="flex items-center gap-1 text-warning">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              {running} 运行中
            </span>
          ) : null
        }
      />
      <ul className="max-h-60 overflow-y-auto py-1">
        {agents.map((s) => {
          const meta = SUBAGENT_STATUS_META[s.status];
          const usage = fmtUsage(s);
          return (
            <li key={s.taskId} className="border-l-2 border-l-info/60 px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                {s.subagentType && (
                  <span className="rounded bg-info/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-info">
                    {s.subagentType}
                  </span>
                )}
                <span className={`flex items-center gap-1 text-[10px] ${meta.cls}`}>
                  {meta.spin && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />}
                  {meta.label}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-content" title={s.description}>
                {s.description || "(无描述)"}
              </p>
              {(usage || s.lastToolName) && (
                <p className="mt-0.5 text-[10px] text-content-subtle">
                  {[s.lastToolName, usage].filter(Boolean).join(" · ")}
                </p>
              )}
              {s.summary && (
                <p className="mt-0.5 truncate text-[10px] italic text-content-subtle" title={s.summary}>
                  {s.summary}
                </p>
              )}
              {s.error && <p className="mt-0.5 text-[10px] text-danger">{s.error}</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ── Section: Usage ─────────────────────────────────────────────────── */

/** Format a duration (ms) as "12.3s" / "1m 02s". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${String(rs).padStart(2, "0")}s`;
}

/** Sum the cost across finalized turns. */
function totalCost(history: TurnUsageRecord[]): number {
  return history.reduce((sum, h) => sum + (h.costUsd ?? 0), 0);
}




function UsageSection({
  snapshot,
  history,
}: {
  snapshot?: ContextSnapshot;
  history: TurnUsageRecord[];
}) {
  const [expanded, setExpanded] = useState(false);
  const breakdown = snapshot ? getContextBreakdown(snapshot) : null;

  // Session-wide totals from finalized turns.
  const totals = useMemo(() => {
    const t = {
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      processed: 0,
      cost: 0,
      turns: history.length,
    };
    for (const h of history) {
      t.output += h.outputTokens;
      t.cacheRead += h.cacheReadTokens;
      t.cacheCreation += h.cacheCreationTokens;
      t.processed += h.totalProcessedTokens;
      t.cost += h.costUsd ?? 0;
    }
    return t;
  }, [history]);

  // Most-recent-first: latest turn on top.
  const ordered = useMemo(() => [...history].reverse(), [history]);

  return (
    <>
      <SectionHeader
        icon="⚡"
        title="上下文消耗"
        right={
          <span className="tabular-nums">
            {totals.turns} 轮 · {fmtTokens(totals.processed)} tokens
            {totals.cost > 0 ? ` · $${totals.cost.toFixed(4)}` : ""}
          </span>
        }
      />

      {/* Live occupancy bar (current context window state). */}
      {snapshot && breakdown && (
        <div className="border-b border-white/5 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-content">当前占用</span>
            <span className="text-[11px] tabular-nums text-content-muted">
              {fmtTokens(snapshot.usedTokens)} / {fmtTokens(snapshot.maxTokens)} · {snapshot.pct}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div
              className={
                snapshot.warning === "critical"
                  ? "h-full rounded-full bg-danger"
                  : snapshot.warning === "near-window"
                    ? "h-full rounded-full bg-warning"
                    : "h-full rounded-full bg-accent"
              }
              style={{ width: `${Math.min(100, Math.max(0, snapshot.pct))}%` }}
            />
          </div>
        </div>
      )}

      {/* Session totals grid. */}
      <div className="grid grid-cols-2 gap-px border-b border-white/5 bg-white/5">
        {[
          { label: "输出", value: fmtTokens(totals.output), Icon: IconArrowBarToUp },
          { label: "缓存读取", value: fmtTokens(totals.cacheRead), Icon: IconDatabase },
          { label: "缓存写入", value: fmtTokens(totals.cacheCreation), Icon: IconDatabase },
          { label: "处理总量", value: fmtTokens(totals.processed), Icon: IconStack2 },
        ].map((cell) => (
          <div key={cell.label} className="bg-surface px-3 py-1.5">
            <div className="flex items-center gap-1 text-[10px] text-content-subtle">
              <cell.Icon size={11} className="opacity-70" />
              {cell.label}
            </div>
            <div className="mt-0.5 text-[12px] font-medium tabular-nums text-content">
              {cell.value}
            </div>
          </div>
        ))}
      </div>

      {/* Per-turn history (collapsible). */}
      {ordered.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-1 px-3 py-1.5 text-[11px] text-content-muted transition-colors hover:bg-surface-muted"
          >
            {expanded ? (
              <IconChevronDown size={12} className="opacity-70" />
            ) : (
              <IconChevronRight size={12} className="opacity-70" />
            )}
            <span>按轮次明细 ({ordered.length})</span>
          </button>
          {expanded && (
            <ul className="max-h-56 overflow-y-auto border-t border-white/5 py-1">
              {ordered.map((h, i) => (
                <TurnUsageRow
                  key={`${h.endedAt}-${i}`}
                  index={ordered.length - i}
                  record={h}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

/** One row in the per-turn usage list. Expandable to show the token split. */
function TurnUsageRow({ index, record }: { index: number; record: TurnUsageRecord }) {
  const [open, setOpen] = useState(false);
  const cells = [
    { label: "输出", value: fmtTokens(record.outputTokens), Icon: IconArrowBarToUp },
    { label: "缓存读取", value: fmtTokens(record.cacheReadTokens), Icon: IconDatabase },
    { label: "缓存写入", value: fmtTokens(record.cacheCreationTokens), Icon: IconDatabase },
    { label: "处理总量", value: fmtTokens(record.totalProcessedTokens), Icon: IconStack2 },
  ];
  return (
    <li className="border-l-2 border-l-accent/40 px-3 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        {open ? (
          <IconChevronDown size={11} className="shrink-0 opacity-60" />
        ) : (
          <IconChevronRight size={11} className="shrink-0 opacity-60" />
        )}
        <span className="text-[11px] font-medium text-content">第 {index} 轮</span>
        <span className="ml-auto flex items-center gap-2 text-[10px] tabular-nums text-content-subtle">
          {record.model && (
            <span className="flex items-center gap-0.5">
              <IconCpu size={10} className="opacity-70" />
              {record.model.length > 16 ? record.model.slice(0, 16) + "…" : record.model}
            </span>
          )}
          <span className="flex items-center gap-0.5">
            <IconClock size={10} className="opacity-70" />
            {fmtDuration(record.durationMs)}
          </span>
          {record.costUsd != null && record.costUsd > 0 && (
            <span className="flex items-center gap-0.5 text-content-muted">
              <IconCoins size={10} className="opacity-70" />
              ${record.costUsd.toFixed(4)}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 pl-4">
          {cells.map((c) => (
            <div key={c.label} className="flex items-center justify-between text-[10px]">
              <span className="flex items-center gap-0.5 text-content-subtle">
                <c.Icon size={10} className="opacity-70" />
                {c.label}
              </span>
              <span className="tabular-nums text-content-muted">{c.value}</span>
            </div>
          ))}
          <div className="flex items-center justify-between text-[10px]">
            <span className="flex items-center gap-0.5 text-content-subtle">
              <IconArrowBarToDown size={10} className="opacity-70" />
              轮后占用
            </span>
            <span className="tabular-nums text-content-muted">{fmtTokens(record.usedTokens)}</span>
          </div>
        </div>
      )}
    </li>
  );
}

/* ── Section: Plan ─────────────────────────────────────────────────── */

/** Number of characters of plan text to show in the preview before "展开". */
const PLAN_PREVIEW_CHARS = 480;

function PlanSection({
  plan,
  phase,
  onOpenFull,
}: {
  plan: PlanDraft["plan"];
  phase: PlanDraft["phase"];
  /** Callback to open the full plan in PlanApprovalPrompt. Currently the
   *  approval modal is only shown by canUseTool on ExitPlanMode, so this
   *  just toggles the inline expanded view in the popover. */
  onOpenFull?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = PLAN_PHASE_META[phase];
  const needsTruncation = plan.length > PLAN_PREVIEW_CHARS && !expanded;
  return (
    <>
      <SectionHeader
        icon="📋"
        title="计划文档"
        right={meta.label ? <span className={meta.cls}>{meta.label}</span> : null}
      />
      <div className="max-h-72 overflow-y-auto px-3 py-2">
        {plan ? (
          <div className="prose-plan text-[11px] leading-relaxed text-content-muted">
            <Markdown>{needsTruncation ? truncate(plan, PLAN_PREVIEW_CHARS) : plan}</Markdown>
          </div>
        ) : (
          <p className="text-[11px] italic text-content-subtle">
            {phase === "drafting" ? "模型正在撰写计划…（提交后会自动填入）" : "暂无计划"}
          </p>
        )}
      </div>
      {(plan.length > PLAN_PREVIEW_CHARS || onOpenFull) && (
        <div className="flex items-center justify-end gap-1 border-t border-white/5 px-3 py-1.5">
          {plan.length > PLAN_PREVIEW_CHARS && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded px-2 py-0.5 text-[10px] text-content-muted transition-colors hover:bg-surface-muted hover:text-content"
              title={expanded ? "收起" : "展开完整内容"}
            >
              {expanded ? "收起" : "展开"}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ── Root: ActivityPopover ─────────────────────────────────────────── */

/**
 * Unified activity popover for the ChatPane sticky capsule. Renders up to
 * four sections — Plan, Subagents, Tasks, Usage — in priority order. Each
 * section is omitted entirely when its source state is empty (no Todos →
 * no Tasks section), so the popover gracefully degrades to whatever the
 * active session is actually doing right now.
 *
 * The Usage section shows the current context-window occupancy + a session
 * total and a collapsible per-turn breakdown (each turn expandable to its
 * token split). Click the capsule to open; click a turn row to expand its
 * details.
 *
 * Pure presentational: open/close + outer positioning is handled by the
 * caller (ChatPane). This component is the "expanded view of the
 * activity capsule".
 */
export function ActivityPopover({
  todos,
  plan,
  subagents,
  snapshot,
  usageHistory,
}: {
  todos: TodoItem[];
  plan: PlanDraft;
  subagents: SubagentSnapshot[];
  snapshot?: ContextSnapshot;
  usageHistory: TurnUsageRecord[];
}) {
  const showPlan = plan.phase !== "cleared" || plan.plan.length > 0;
  const showSubagents = subagents.length > 0;
  const showTasks = todos.length > 0;
  const showUsage = !!snapshot || usageHistory.length > 0;

  return (
    <div className="absolute right-0 top-9 z-30 w-96 overflow-hidden rounded-xl border border-white/10 bg-surface/95 shadow-2xl backdrop-blur">
      {/* Stacked sections: Plan → Subagents → Tasks → Usage. Thin dividers
          between them; the topmost rendered section gets the rounded top
          (handled by `overflow-hidden` on the parent). */}
      {showPlan && (
        <div className="border-b border-white/5">
          <PlanSection plan={plan.plan} phase={plan.phase} />
        </div>
      )}
      {showSubagents && (
        <div className="border-b border-white/5">
          <SubagentsSection agents={subagents} />
        </div>
      )}
      {showTasks && (
        <div className="border-b border-white/5">
          <TasksSection todos={todos} />
        </div>
      )}
      {showUsage && (
        <div>
          <UsageSection snapshot={snapshot} history={usageHistory} />
        </div>
      )}
    </div>
  );
}
