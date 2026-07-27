/**
 * Per-turn file snapshot — backs the "撤销本轮" feature (Claude Code's
 * `/rewind` analog, scoped to a single turn).
 *
 * Lifecycle:
 *   1. `recordPre(cwd, filePath)` is called once for each file Edit/Write
 *      touches in the turn. The first call snapshots; subsequent calls
 *      for the same path are no-ops (the *original* content is what
 *      matters, not the latest).
 *   2. At turn end, `freeze()` returns the list of files for the renderer
 *      and marks the snapshot as "ready to rewind". The records stay
 *      in memory so `restore()` can still access them.
 *   3. If the user clicks "撤销本轮", `restore(cwd)` writes the originals
 *      back / unlinks newly created files, then the runtime calls
 *      `clear()` to release memory.
 *
 * Path safety: every path is `path.resolve(cwd, filePath)`-d before any
 * disk access and rejected if it escapes `cwd`. This prevents a hostile
 * prompt from getting us to write outside the project working directory.
 *
 * Why we don't use git / a real checkpoint: out of scope for v1. The
 * roadmap reserves checkpoint timeline for P5; this is the lightweight
 * "last turn only" version that solves 90% of the actual user pain
 * (accidental file overwrite / wrong edits) without taking on a
 * dependency.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Internal record per snapshotted file. */
interface FileRecord {
  /** Path the snapshot was taken from (cwd-resolved, absolute). */
  absPath: string;
  /** True if the file existed when recordPre was called; false if the
   *  file was created by this turn. Restore uses this to choose
   *  writeFile vs unlink. */
  exists: boolean;
  /** Pre-turn content. Empty string for "existed but was empty" or
   *  "didn't exist" (the latter shouldn't be read; we only use
   *  `content` when `exists === true`). */
  content: string;
}

export interface FrozenFile {
  filePath: string;
  kind: "modified" | "created";
}

export class FileSnapshot {
  private originals = new Map<string, FileRecord>();
  /** Once frozen, recordPre() is a no-op. Lets us safely call
   *  freeze() at turn end and have any straggling tool_use events
   *  (rare, but possible) be ignored. */
  private frozen = false;

  /** Number of files currently snapshotted (used by tests and the
   *  empty-after-freeze check). */
  get size(): number {
    return this.originals.size;
  }

  /** Snapshot a file's pre-turn state. Safe to call concurrently — the
   *  Map.set is atomic, and only the first call per path does real
   *  work. Returns silently on any error (ENOENT = created, anything
   *  else = log + skip, never crash the event stream). */
  async recordPre(cwd: string, filePath: string): Promise<void> {
    if (this.frozen) return;
    const abs = safeResolve(cwd, filePath);
    if (abs === null) return; // path escapes cwd — silently ignore
    if (this.originals.has(abs)) return; // already snapshotted
    try {
      const content = await readFile(abs, "utf-8");
      this.originals.set(abs, { absPath: abs, exists: true, content });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File didn't exist before — claude will create it. Record
        // exists:false so restore can unlink.
        this.originals.set(abs, { absPath: abs, exists: false, content: "" });
      } else {
        // EACCES, EISDIR, etc. — not safe to restore later, so skip.
        // Logged so devs can see it without crashing the stream.
        console.warn(`FileSnapshot: skip ${abs} (${code ?? (err as Error).message})`);
      }
    }
  }

  /** Freeze and return the list of files for the renderer. The records
   *  STAY in memory so a subsequent restore() can use them — clear()
   *  is what actually frees them, and the runtime calls it either
   *  after a successful restore or at the start of the next turn. */
  freeze(): FrozenFile[] {
    this.frozen = true;
    const out: FrozenFile[] = [];
    for (const rec of this.originals.values()) {
      out.push({
        filePath: rec.absPath,
        kind: rec.exists ? "modified" : "created",
      });
    }
    return out;
  }

  /** Restore all snapshotted files. Returns the paths that were
   *  successfully restored. Failures are logged and excluded from
   *  the return value so the renderer knows which ones actually
   *  reverted. */
  async restore(cwd: string): Promise<string[]> {
    const restored: string[] = [];
    // Process created-files first (unlink) so a parent that was also
    // modified can be cleanly rewritten without the child blocking.
    const all = [...this.originals.values()];
    const created = all.filter((r) => !r.exists);
    const modified = all.filter((r) => r.exists);
    for (const rec of [...created, ...modified]) {
      if (!safeResolveOk(cwd, rec.absPath)) {
        console.warn(`FileSnapshot: restore refused, escapes cwd: ${rec.absPath}`);
        continue;
      }
      try {
        if (rec.exists) {
          // Ensure parent dir exists in case the user (or another
          // tool) deleted it mid-turn.
          await mkdir(dirname(rec.absPath), { recursive: true });
          await writeFile(rec.absPath, rec.content, "utf-8");
        } else {
          try {
            await unlink(rec.absPath);
          } catch (err) {
            // Already gone — nothing to do.
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
        restored.push(rec.absPath);
      } catch (err) {
        console.warn(`FileSnapshot: restore failed for ${rec.absPath} (${(err as Error).message})`);
      }
    }
    return restored;
  }

  /** Drop the restore records. Called by the runtime after a
   *  successful rewind (so the next turn starts clean) and when a
   *  session is disposed. Also called at the start of each turn
   *  to bound memory. */
  clear(): void {
    this.originals.clear();
    this.frozen = false;
  }
}

/* ──────────────────────────── path safety ──────────────────────────── */

/** Resolve `filePath` against `cwd` and refuse any path that escapes.
 *  Returns null if the path is unsafe (caller should skip silently). */
function safeResolve(cwd: string, filePath: string): string | null {
  let abs: string;
  try {
    abs = resolve(cwd, filePath);
  } catch {
    return null;
  }
  return safeResolveOk(cwd, abs) ? abs : null;
}

/** Re-check that an already-resolved absolute path stays within cwd.
 *  Used by restore() to defend against the cwd changing between
 *  recordPre and restore. */
function safeResolveOk(cwd: string, abs: string): boolean {
  // path.relative with the second arg outside cwd returns a path
  // starting with "..". On Windows an absolute result also means
  // "different root" (different drive).
  const rel = relative(cwd, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
