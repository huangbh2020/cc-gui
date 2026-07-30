/**
 * Context-window display helpers for the renderer.
 *
 * The normalization math (snapshotFromUsage / resolveContextWindow /
 * isUnknownUsage) moved to the main process —
 * `apps/desktop/src/main/providers/claude-sdk/claudeTokenUsage.ts` — so the
 * provider adapter can emit a provider-neutral `token-usage.updated` event
 * carrying an already-normalized {@link ContextSnapshot}. The renderer no
 * longer touches raw token fields; it only stores snapshots and renders them.
 *
 * This module re-exports the shared snapshot types from `@contracts/runtime`
 * (so renderer components import from one place) and keeps the few genuinely
 * renderer-side concerns: token-count formatting and warning → color mapping.
 */
export type {
  ContextSnapshot,
  ContextWarning,
  ContextWarningKind,
} from "@contracts/runtime";

import type { ContextSnapshot, ContextWarning } from "@contracts/runtime";

/**
 * Validate that a persisted/received snapshot has the full post-refactor
 * shape. Pre-refactor `context_snapshot` rows stored the raw-usage object
 * (`{inputTokens, outputTokens, costUsd, ...}`) without `usedTokens` /
 * `maxTokens` / `pct` / `warning` / `warnings` — feeding those to the
 * ContextRing / StatusBar crashes (NaN strokeDashoffset, undefined.length).
 * Drop such stale snapshots and let the next emit overwrite. */
export function isValidSnapshot(s: unknown): s is ContextSnapshot {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.usedTokens === "number" &&
    typeof o.maxTokens === "number" &&
    typeof o.pct === "number" &&
    (o.warning === "ok" || o.warning === "near-window" || o.warning === "critical") &&
    Array.isArray(o.warnings)
  );
}

/* ── formatting ── */

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/* ── warning → tailwind text color ── */

/** Status-bar chip color for a context-warning level.
 *  ok → neutral zinc, near-window → amber, critical → red. */
export function warningColor(w: ContextWarning): string {
  if (w === "critical") return "text-danger";
  if (w === "near-window") return "text-warning";
  return "text-content-muted";
}

/* ── breakdown for rich tooltips ── */

/** One row in the context-usage hover card. */
export interface ContextBreakdownRow {
  key: string;
  label: string;
  value: string;
  /** Optional muted secondary value (e.g. unit). */
  hint?: string;
}

/**
 * Structured token breakdown shared by ContextRing and StatusCapsule.
 * Keeps both surfaces in sync and avoids duplicating the fresh-input math.
 */
export function getContextBreakdown(s: ContextSnapshot): {
  title: string;
  subtitle: string;
  rows: ContextBreakdownRow[];
} {
  const cacheRead = s.cacheReadTokens ?? 0;
  const cacheCreation = s.cacheCreationTokens ?? 0;
  const freshInput = Math.max(0, s.usedTokens - cacheRead - cacheCreation);
  const rows: ContextBreakdownRow[] = [
    { key: "input", label: "输入", value: fmtTokens(freshInput) },
  ];
  if (cacheRead > 0) {
    rows.push({ key: "cache-read", label: "缓存读取", value: fmtTokens(cacheRead) });
  }
  if (cacheCreation > 0) {
    rows.push({ key: "cache-write", label: "缓存写入", value: fmtTokens(cacheCreation) });
  }
  rows.push({ key: "output", label: "输出", value: fmtTokens(s.outputTokens) });
  rows.push({
    key: "processed",
    label: "本轮处理",
    value: fmtTokens(s.totalProcessedTokens),
  });
  if (s.costUsd != null) {
    rows.push({
      key: "cost",
      label: "费用",
      value: `$${s.costUsd.toFixed(4)}`,
    });
  }
  return {
    title: "上下文占用",
    subtitle: `${fmtTokens(s.usedTokens)} / ${fmtTokens(s.maxTokens)} · ${s.pct}%`,
    rows,
  };
}
