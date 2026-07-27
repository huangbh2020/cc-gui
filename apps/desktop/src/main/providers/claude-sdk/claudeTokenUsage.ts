/**
 * Claude token usage — parsing, normalization, window resolution, warnings.
 *
 * Single source of truth for context-window math. The SdkMessageAdapter calls
 * these helpers to turn raw SDK `usage` / `modelUsage` fields into a provider-
 * neutral {@link ContextSnapshot}, which it then emits as a
 * `token-usage.updated` event. Downstream stages (renderer / persistence) are
 * provider-agnostic — they never touch raw token fields.
 *
 * Design mirrors ClaudeCode's `claudeTokenUsage.ts`
 * (docs/claude-context-usage-tracking.md §2-§5), simplified for the Agent
 * SDK's data model: we have paths A (per assistant response) and C (turn-end
 * result), but not path B (the live `getContextUsage()` control channel —
 * the SDK's stream-json surface doesn't expose it). Effects of that gap are
 * noted inline; see also doc §7.2.
 */
import type {
  ContextSnapshot,
  ContextWarning,
  ContextWarningKind,
} from "@contracts/runtime";

/** Raw usage fields the SDK reports on assistant / result messages. Missing
 *  fields are treated as 0. Field names follow the Anthropic API convention
 *  (the SDK forwards them verbatim from `result.usage`). */
export interface RawClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Approximate USD cost for this turn, if known. */
  costUsd?: number;
  /** Active model id (e.g. `claude-sonnet-4-5`, `claude-opus-4-1[1M]`). */
  model?: string;
}

/* ── thresholds (doc §5) ── */

const UNCACHED_INGESTION_TOKENS = 50_000;
const LARGE_PROMPT_TOKENS = 200_000;
const NEAR_WINDOW_RATIO = 0.8; // 80% of effective budget
// When prompt > this AND cache-read ratio < CACHE_READ_LOW_RATIO, flag
// uncached-ingestion (catches fresh sessions / resumes / large first turns).
const PROMPT_FOR_CACHE_CHECK_TOKENS = 20_000;
const CACHE_READ_LOW_RATIO = 0.2;

/* ── known window ceilings (doc §4) ── */

export const CLAUDE_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;
export type ClaudeContextWindowTag = keyof typeof CLAUDE_CONTEXT_WINDOW_MAX_TOKENS;

/** "Logical prompt tokens" — the count that actually occupies the context
 *  window (doc §3). Cache reads bill at a reduced rate but occupy the window
 *  at full weight: the model still has to read them. */
export function claudePromptTokensFromRawUsage(raw: RawClaudeUsage): number {
  return (
    (raw.inputTokens ?? 0) +
    (raw.cacheCreationInputTokens ?? 0) +
    (raw.cacheReadInputTokens ?? 0)
  );
}

/** Total tokens processed this turn — input + output + cache read + cache
 *  creation. May exceed `maxTokens` (it's a throughput number, not a window
 *  occupancy number). */
export function totalProcessedTokensFromRawUsage(raw: RawClaudeUsage): number {
  return (
    (raw.inputTokens ?? 0) +
    (raw.outputTokens ?? 0) +
    (raw.cacheReadInputTokens ?? 0) +
    (raw.cacheCreationInputTokens ?? 0)
  );
}

/* ── window resolution (doc §4) ── */

/** Heuristic fallback when the SDK doesn't report a window. Opus extended
 *  mode advertises 1M (the `[1M]` suffix); everything else ships 200k. */
export function resolveContextWindowHeuristic(
  model?: string,
  configured?: ClaudeContextWindowTag,
): number {
  if (configured === "1m") return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"];
  if (configured === "200k") return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["200k"];
  if (model?.toLowerCase().includes("opus")) {
    return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"];
  }
  return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["200k"];
}

/** Resolve the effective context-window ceiling, honoring the never-downgrade
 *  rule (doc §4): `Math.max(reported, lastKnown)`. A 1M model occasionally
 *  reports 200k transiently — we refuse to shrink once we've seen the larger
 *  value.
 *
 * @param reported   SDK-reported window from `modelUsage[model].contextWindow`
 * @param lastKnown  Last resolved ceiling for this session (adapter state)
 * @param configured User override ("200k" / "1m") — highest precedence */
export function resolveEffectiveContextWindow(opts: {
  model?: string;
  reported?: number;
  lastKnown?: number;
  configured?: ClaudeContextWindowTag;
}): number {
  const { model, reported, lastKnown, configured } = opts;
  const heuristic = resolveContextWindowHeuristic(model, configured);
  return Math.max(
    positiveOrZero(reported),
    positiveOrZero(lastKnown),
    heuristic,
  );
}

/* ── warnings (doc §5) ── */

/** Compute the granular warning kinds triggered by this usage report.
 *  Returns an empty array when nothing is amiss. Thresholds follow doc §5;
 *  the `near-window` check degrades to `maxTokens * 0.8` because path B
 *  (the live `autoCompactThreshold` control channel) is unavailable — see
 *  doc §7.2. */
export function decideClaudeContextUsageWarnings(
  raw: RawClaudeUsage,
  maxTokens: number,
): ContextWarningKind[] {
  const warnings: ContextWarningKind[] = [];
  const promptTokens = claudePromptTokensFromRawUsage(raw);
  const cacheRead = raw.cacheReadInputTokens ?? 0;
  const uncachedInput = (raw.inputTokens ?? 0) + (raw.cacheCreationInputTokens ?? 0);

  // uncached-ingestion: rapid credit burn (fresh session / resume / first
  // turn of a large context).
  const cacheReadRatio = promptTokens > 0 ? cacheRead / promptTokens : 0;
  if (
    uncachedInput > UNCACHED_INGESTION_TOKENS ||
    (promptTokens > PROMPT_FOR_CACHE_CHECK_TOKENS && cacheReadRatio < CACHE_READ_LOW_RATIO)
  ) {
    warnings.push("uncached-ingestion");
  }
  // near-window: approaching the auto-compact budget. Without path B we use
  // the resolved window ceiling as the budget proxy.
  if (promptTokens > maxTokens * NEAR_WINDOW_RATIO) {
    warnings.push("near-window");
  }
  // large-prompt: big contexts accelerate credit consumption.
  if (promptTokens > LARGE_PROMPT_TOKENS) {
    warnings.push("large-prompt");
  }
  return warnings;
}

/* ── normalization (doc §3) ── */

/** Normalize raw per-turn usage into a display-ready snapshot. Returns
 *  `undefined` when there's nothing to report (all token fields 0 / missing),
 *  so the caller can skip emitting — avoids "0 / 200k (0%)" ghost readouts
 *  from proxies / non-Anthropic gateways that zero out usage. */
export function normalizeClaudeTokenUsage(
  raw: RawClaudeUsage,
  opts: {
    reported?: number;
    lastKnown?: number;
    configured?: ClaudeContextWindowTag;
  },
): ContextSnapshot | undefined {
  const totalProcessed = totalProcessedTokensFromRawUsage(raw);
  if (totalProcessed <= 0) return undefined;

  const maxTokens = resolveEffectiveContextWindow({
    model: raw.model,
    reported: opts.reported,
    lastKnown: opts.lastKnown,
    configured: opts.configured,
  });

  // Window occupancy = logical prompt tokens, clamped to the ceiling.
  const usedTokens = Math.min(
    claudePromptTokensFromRawUsage(raw),
    maxTokens,
  );
  const pct = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
  const warning: ContextWarning =
    pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";
  const warnings = decideClaudeContextUsageWarnings(raw, maxTokens);

  return {
    usedTokens,
    totalProcessedTokens: totalProcessed,
    maxTokens,
    outputTokens: raw.outputTokens ?? 0,
    cacheReadTokens: raw.cacheReadInputTokens,
    cacheCreationTokens: raw.cacheCreationInputTokens,
    costUsd: raw.costUsd,
    model: raw.model,
    pct,
    warning,
    warnings,
  };
}

/* ── path C merge (doc §2 path C) ── */

/** Merge a turn-end accumulated snapshot (from `result.usage`) with the last
 *  known mid-turn snapshot (from path A). Per doc §2 path C, the SDK's
 *  `result.usage` is an accumulated sum — it must NOT be treated as the
 *  current window occupancy. So accumulated contributes
 *  `totalProcessedTokens`, and `usedTokens` comes from whichever is larger
 *  between accumulated and lastKnown (the most recent window read we have). */
export function mergeClaudeTokenUsageSnapshot(
  lastKnown: ContextSnapshot | undefined,
  accumulated: ContextSnapshot,
  maxTokens: number,
): ContextSnapshot {
  if (!lastKnown) return accumulated;
  const usedTokens = Math.min(Math.max(accumulated.usedTokens, lastKnown.usedTokens), maxTokens);
  const pct = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
  const warning: ContextWarning =
    pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";
  return {
    ...accumulated,
    usedTokens,
    pct,
    warning,
    // Take the union of warnings from both — both are "this turn" signals.
    warnings: dedupeWarnings([...accumulated.warnings, ...lastKnown.warnings]),
  };
}

/* ── helpers ── */

function positiveOrZero(n: number | undefined | null): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

function dedupeWarnings(ws: ContextWarningKind[]): ContextWarningKind[] {
  return Array.from(new Set(ws));
}
