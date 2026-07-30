/**
 * Time formatting helpers shared across the Git panel.
 *
 * Relative time is shown inline (e.g. "2 分钟前"); the full time is shown as a
 * hover `title`. The input accepts either an ISO string (git log timestamps)
 * or a numeric epoch-ms value (e.g. `Date.now()` for operation logs).
 */

/** Format a time as a short Chinese relative string ("刚刚" / "N 分钟前" / ...). */
export function formatRelativeTime(input: number | string): string {
  const t = typeof input === "number" ? input : new Date(input).getTime();
  if (Number.isNaN(t)) return String(input);
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth} 个月前`;
  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear} 年前`;
}

/** Format a time as a full locale string, for hover tooltips. */
export function formatFullTime(input: number | string): string {
  const d = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  try {
    return d.toLocaleString();
  } catch {
    return String(input);
  }
}
