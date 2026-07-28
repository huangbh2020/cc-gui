/**
 * Hex ⇄ "R G B" triplet conversions for CSS-variable color storage.
 *
 * Several appearance settings (user-message background color, global accent
 * color) persist their value as a space-separated "R G B" triplet so the
 * Tailwind tokens can compose arbitrary alpha channels at runtime (e.g.
 * `--accent: 5 150 105` → `bg-accent/10`). The native HTML color input,
 * however, deals in `#rrggbb`. These helpers bridge the two representations.
 *
 * Identical logic was previously duplicated in ChatAppearancePanel and
 * AccentPanel — extracted here to keep them in sync.
 */

/** Convert "#rrggbb" → "R G B" triplet string. Returns "" on malformed input. */
export function hexToTriplet(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Convert "R G B" triplet → "#rrggbb" for a color input. Returns null on
 *  malformed input so the caller can fall back to a default swatch. */
export function tripletToHex(triplet: string | null): string | null {
  if (!triplet) return null;
  const parts = triplet.trim().split(/\s+/).map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return null;
  }
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`;
}
