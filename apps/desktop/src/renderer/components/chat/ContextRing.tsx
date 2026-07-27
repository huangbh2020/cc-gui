import { cn } from "@renderer/lib/cn.js";
import { fmtTokens, warningColor } from "@renderer/lib/contextWindow.js";
import type { ContextSnapshot } from "@contracts/runtime";

/**
 * Compact circular context-occupancy indicator for the composer row.
 *
 * Renders as a small SVG ring (ZCode-style) whose filled arc length
 * represents `snapshot.pct` and whose color escalates with the warning
 * level (ok → accent, near-window → warning amber, critical → danger red).
 * The percentage sits beside the ring. Hover shows a multi-line tooltip
 * breaking the usage down by token kind (input / cache read / cache
 * creation / output), the window ceiling, and the turn cost.
 *
 * The adapter already did all the math (pct / warning / usedTokens /
 * maxTokens — see claudeTokenUsage.ts); this component is pure rendering.
 */
export function ContextRing({ snapshot }: { snapshot: ContextSnapshot }) {
  const { pct, warning, usedTokens, maxTokens } = snapshot;
  // Geometry: 14px box, ring stroke 2.5 (so inner hole ~9px).
  const size = 14;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * (Math.min(100, Math.max(0, pct)) / 100);
  const colorClass = warningColor(warning);

  const title = buildTooltip(snapshot);

  return (
    <span
      className={cn("inline-flex items-center gap-1 tabular-nums", colorClass)}
      title={title}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="opacity-20"
        />
        {/* Filled arc — rotate so it starts at top (12 o'clock). */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="text-[10px] font-medium leading-none">{pct}%</span>
    </span>
  );
}

/** Build the multi-line hover tooltip showing the token breakdown.
 *  The native `title` attribute renders this as plain text; newlines
 *  become line breaks in most browsers' tooltip implementation.
 *
 *  Breakdown mirrors the SDK's `usage` object:
 *    - 输入:       fresh input tokens (input_tokens) — derived as
 *                  usedTokens − cacheRead − cacheCreation (the non-cached
 *                  slice of the window occupancy).
 *    - 缓存读取:   cache_read_input_tokens (billed at reduced rate).
 *    - 缓存写入:   cache_creation_input_tokens (higher write rate).
 *    - 输出:       output_tokens (the model's reply this turn).
 *    - 本轮处理:   totalProcessedTokens (input+output+cache, throughput).
 *    - 费用:       costUsd for the turn, if known. */
function buildTooltip(s: ContextSnapshot): string {
  const cacheRead = s.cacheReadTokens ?? 0;
  const cacheCreation = s.cacheCreationTokens ?? 0;
  // Pure (non-cached) input = window occupancy minus the two cache slices.
  const freshInput = Math.max(0, s.usedTokens - cacheRead - cacheCreation);
  const lines: string[] = [
    `上下文占用  ${fmtTokens(s.usedTokens)} / ${fmtTokens(s.maxTokens)}  (${s.pct}%)`,
    `──────────────`,
    `输入        ${fmtTokens(freshInput)}`,
  ];
  if (cacheRead > 0) lines.push(`缓存读取    ${fmtTokens(cacheRead)}`);
  if (cacheCreation > 0) lines.push(`缓存写入    ${fmtTokens(cacheCreation)}`);
  lines.push(`输出        ${fmtTokens(s.outputTokens)}`);
  lines.push(`本轮处理    ${fmtTokens(s.totalProcessedTokens)}`);
  if (s.costUsd != null) lines.push(`费用        $${s.costUsd.toFixed(4)}`);
  return lines.join("\n");
}
