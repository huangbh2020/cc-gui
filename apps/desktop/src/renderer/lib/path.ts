/**
 * Renderer-side path utilities.
 *
 * The renderer runs under contextIsolation and cannot `require("node:path")`.
 * These pure-string helpers cover the small set of path operations the IDE
 * panel needs (basename, dirname, extension). They handle both POSIX `/` and
 * Windows `\` separators since project paths may come from either platform.
 */

/** Matches the last path separator (forward or back slash). */
const SEP_RE = /[/\\]/;

/** The base name of a path — the segment after the last separator.
 *  `"foo/bar/baz.ts"` → `"baz.ts"`. Returns the input unchanged if it has no
 *  separator. */
export function basename(p: string): string {
  const parts = p.split(SEP_RE);
  return parts[parts.length - 1] ?? p;
}

/** The directory containing a path — everything before the last separator.
 *  `"foo/bar/baz.ts"` → `"foo/bar"`. Returns `""` for a bare file name. */
export function dirname(p: string): string {
  const last = p.lastIndexOf("/");
  const lastBack = p.lastIndexOf("\\");
  const cut = Math.max(last, lastBack);
  return cut < 0 ? "" : p.slice(0, cut);
}

/** The file extension including the leading dot, lowercased — `""` if none.
 *  Used to pick a Monaco language id. `"baz.ts"` → `".ts"`. */
export function extname(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // dot at 0 = hidden file, no extension
  return base.slice(dot).toLowerCase();
}

/** Join two path segments with a single separator. Handles the case where
 *  the base already ends with a separator and/or the add starts with one.
 *  Uses `/` (works on macOS/Linux; Windows tolerates it in Node APIs). */
export function joinPath(base: string, add: string): string {
  if (!add) return base;
  const left = base.endsWith("/") || base.endsWith("\\") ? base : base + "/";
  const right = add.startsWith("/") || add.startsWith("\\") ? add.slice(1) : add;
  return left + right;
}
