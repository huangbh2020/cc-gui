/**
 * Markdown rendering cache layer.
 *
 * Two cache tiers:
 *  1. codeHtmlCache — FNV-1a hash of (codeText + language) → shiki HTML string.
 *     LRU with max 500 entries AND max ~50 MB total HTML bytes.
 *  2. mdAstCache   — FNV-1a hash of full markdown text → remark AST (used to
 *     short-circuit react-markdown parsing for settled content). LRU with max
 *     500 entries, no byte cap (AST size is small).
 *
 * FNV-1a was chosen over SHA/MD5 because it is a ~15-line pure-JS function
 * with zero dependencies and fast enough for string-length hashing in the
 * critical render path.
 */

/* ──────────────────────────── FNV-1a hash ──────────────────────────── */

/** FNV-1a 32-bit hash as a hex string (8 chars, collision-resistant for
 *  our use case — code blocks and markdown text). */
export function fnv1a(str: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Force unsigned 32-bit and format as zero-padded hex.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/* ──────────────────────────── LRU cache ────────────────────────────── */

interface LRUEntry<V> {
  key: string;
  value: V;
  bytes: number;
  prev: LRUEntry<V> | null;
  next: LRUEntry<V> | null;
}

/**
 * Generic doubly-linked-list LRU cache with combined entry-count and
 * total-byte-size eviction policies.
 *
 * - `maxSize`: max number of entries (hard limit).
 * - `maxBytes`: max total byte size of all cached values (soft limit, best-effort).
 *
 * When either limit is exceeded the least-recently-used entry is evicted until
 * both constraints are satisfied. Values MUST implement `byteSize()` for the
 * byte limit to have effect.
 */
export class LRUCache<V extends { byteSize: () => number }> {
  private maxSize: number;
  private maxBytes: number;
  private map = new Map<string, LRUEntry<V>>();
  private head: LRUEntry<V> | null = null;
  private tail: LRUEntry<V> | null = null;
  private _totalBytes = 0;

  constructor(maxSize: number, maxBytes: number) {
    this.maxSize = maxSize;
    this.maxBytes = maxBytes;
  }

  get totalBytes(): number {
    return this._totalBytes;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.moveToHead(entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const existing = this.map.get(key);
    if (existing) {
      // Update in place.
      this._totalBytes -= existing.bytes;
      existing.value = value;
      existing.bytes = value.byteSize();
      this._totalBytes += existing.bytes;
      this.moveToHead(existing);
    } else {
      const bytes = value.byteSize();
      const entry: LRUEntry<V> = {
        key,
        value,
        bytes,
        prev: null,
        next: null,
      };
      this.map.set(key, entry);
      this._totalBytes += bytes;
      this.prepend(entry);
    }
    this.evict();
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
    this.head = this.tail = null;
    this._totalBytes = 0;
  }

  /* ── internal helpers ── */

  private moveToHead(entry: LRUEntry<V>): void {
    if (entry === this.head) return;
    this.unlink(entry);
    this.prepend(entry);
  }

  private prepend(entry: LRUEntry<V>): void {
    entry.next = this.head;
    entry.prev = null;
    if (this.head) this.head.prev = entry;
    this.head = entry;
    if (!this.tail) this.tail = entry;
  }

  private unlink(entry: LRUEntry<V>): void {
    if (entry.prev) entry.prev.next = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    if (entry === this.head) this.head = entry.next;
    if (entry === this.tail) this.tail = entry.prev;
    entry.prev = entry.next = null;
  }

  /** Evict LRU entries until both size and byte limits are satisfied. */
  private evict(): void {
    while (this.map.size > this.maxSize || this._totalBytes > this.maxBytes) {
      const victim = this.tail;
      if (!victim) break;
      this.unlink(victim);
      this.map.delete(victim.key);
      this._totalBytes -= victim.bytes;
    }
  }
}

/* ──────────────────────── String-bytes helper ──────────────────────── */

/** Estimate the byte size of a string (UTF-8). Falls back to 2× char
 *  length when TextEncoder is unavailable (edge cases). */
function stringBytes(s: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s).byteLength;
  }
  return s.length * 2;
}

/* ──────────────────────── String value wrapper ─────────────────────── */

export class CachedString {
  constructor(public readonly value: string) {}
  byteSize(): number {
    return stringBytes(this.value);
  }
}

/* ────────────────────────── Cache instances ────────────────────────── */

/** Cache for shiki-generated HTML strings. Key = fnv1a(codeText + lang). */
export const codeHtmlCache = new LRUCache<CachedString>(500, 52_428_800);

/** Cache for parsed markdown AST strings (serialised JSON of the mdast
 *  produced by remark-parse). Only used for settled (non-streaming) content.
 *  Key = fnv1a(markdownText). */
export const mdAstCache = new LRUCache<CachedString>(500, 52_428_800);

/** Compute a cache key from code text + language tag + Shiki theme.
 *  The theme is included so a theme switch invalidates stale HTML and
 *  triggers re-highlighting instead of serving the wrong palette. */
export function codeCacheKey(text: string, lang: string, theme: string): string {
  return fnv1a(text + "\0" + lang + "\0" + theme);
}

/** Store shiki HTML in the code cache. */
export function setCodeHtml(key: string, html: string): void {
  codeHtmlCache.set(key, new CachedString(html));
}

/** Retrieve cached shiki HTML, or undefined. */
export function getCodeHtml(key: string): string | undefined {
  return codeHtmlCache.get(key)?.value;
}
