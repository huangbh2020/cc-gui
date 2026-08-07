/**
 * Pi token usage — mapping the SDK's already-normalized context / stats readouts
 * onto the provider-neutral {@link ContextSnapshot}.
 *
 * Unlike the Claude path (`claudeTokenUsage.ts`), there is NO client-side math
 * to do for window occupancy: the Pi SDK's `session.getContextUsage()` already
 * returns `{ tokens, contextWindow, percent }` — the same three fields our
 * `ContextSnapshot` exposes as `usedTokens / maxTokens / pct`. Pi even runs the
 * `chars/4` heuristic for tail messages without a usage report, so the estimate
 * stays meaningful between LLM responses.
 *
 * What Pi does NOT give us is the granular warning kinds (uncached-ingestion /
 * near-window / large-prompt). We synthesize a minimal subset from `pct` so the
 * context ring can still tint at the near-window threshold. Throughput fields
 * (`totalProcessedTokens` / `outputTokens` / cache fields / `costUsd`) come from
 * `session.getSessionStats()` — cumulative across the whole session (including
 * compacted-away history), so they match Pi's own /session readout.
 */
import type {
  ContextSnapshot,
  ContextWarning,
  ContextWarningKind,
} from "@contracts/runtime";
import type {
  ContextUsage,
  SessionStats,
} from "@earendil-works/pi-coding-agent";

/** near-window threshold for the granular warning (mirrors the Claude rule). */
const NEAR_WINDOW_RATIO = 0.8;

/** Round to 1 decimal place, matching the Claude adapter's `round1`. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Derive the coarse warning level from occupancy pct.
 *  Same bands as the Claude path: >=90 critical, >=70 near-window, else ok. */
function warningFromPct(pct: number): ContextWarning {
  return pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";
}

/** Derive the granular warning kinds we CAN compute from a Pi readout.
 *  Only `near-window` is derivable from `pct` alone — the other two kinds
 *  (uncached-ingestion / large-prompt) need raw per-turn cache fields the Pi
 *  SDK doesn't expose, so we leave them out rather than guess. */
function warningsFromPct(pct: number, maxTokens: number): ContextWarningKind[] {
  const out: ContextWarningKind[] = [];
  if (pct >= NEAR_WINDOW_RATIO * 100) out.push("near-window");
  // Avoid div-by-zero when contextWindow is 0 (shouldn't happen — the SDK
  // returns undefined when contextWindow <= 0 — but guard anyway).
  if (maxTokens > 0 && pct >= (200_000 / maxTokens) * 100 && pct >= 0) {
    // large-prompt only makes sense for ≥200k models; skip otherwise to avoid
    // false positives on small-window local models.
  }
  return out;
}

/** Build a display-ready snapshot from a Pi context-usage readout + the
 *  cumulative session stats (for throughput / billing fields).
 *
 *  Returns `undefined` when `ctx` is missing or carries no token estimate
 *  (e.g. right after compaction, before the next LLM response), so the caller
 *  can skip emitting — avoids a ghost "0 / N (0%)" readout.
 *
 *  @param ctx    Result of `session.getContextUsage()` — window occupancy.
 *  @param stats  Result of `session.getSessionStats()` — cumulative totals.
 *  @param modelId  Optional model id (e.g. "openai/gpt-4o") for the snapshot. */
export function buildPiTokenSnapshot(
  ctx: ContextUsage | undefined,
  stats: SessionStats | undefined,
  modelId?: string,
): ContextSnapshot | undefined {
  if (!ctx) return undefined;
  const maxTokens = ctx.contextWindow > 0 ? ctx.contextWindow : 0;
  if (maxTokens <= 0) return undefined;

  // tokens is null right after compaction (before the next LLM response writes
  // a fresh usage). Surface nothing rather than a misleading 0.
  if (ctx.tokens == null) return undefined;

  const usedTokens = Math.min(ctx.tokens, maxTokens);
  const pct = round1(Math.min(100, ctx.percent ?? (usedTokens / maxTokens) * 100));
  const warning = warningFromPct(pct);

  const t = stats?.tokens;
  return {
    usedTokens,
    // Session-wide throughput (cumulative, includes compacted-away history).
    // Falls back to `usedTokens` when stats are unavailable so the field is
    // never zero for a non-empty snapshot.
    totalProcessedTokens: t?.total ?? usedTokens,
    maxTokens,
    outputTokens: t?.output ?? 0,
    cacheReadTokens: t?.cacheRead,
    cacheCreationTokens: t?.cacheWrite,
    costUsd: typeof stats?.cost === "number" && stats.cost > 0 ? stats.cost : undefined,
    model: modelId,
    pct,
    warning,
    warnings: warningsFromPct(pct, maxTokens),
  };
}
