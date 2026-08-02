/**
 * IPC handler for skill discovery. The composer's `/` menu lists skills the
 * user has installed; we discover them by scanning the local filesystem
 * (user-global `~/.claude/skills/` + active-project `.claude/skills/`) and
 * parsing each skill's SKILL.md frontmatter.
 *
 * We deliberately do NOT call the SDK's `Query.supportedCommands()` for the
 * listing: that method needs a running query handle, but this app spawns a
 * fresh query per turn, so there is no live handle to query between turns.
 * Scanning the disk is instant, runs without booting the claude binary, and
 * matches what the SDK itself scans when `skills: "all"` is passed. Selecting
 * a skill inserts `/name` into the textarea; the user sends it as a normal
 * turn and the SDK (started with `skills: "all"`) recognizes and runs it.
 */
import type { IpcMain } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path, { sep } from "node:path";
import {
  IPC,
  SkillsListSchema,
  SkillsReadSchema,
  SkillsSaveSchema,
  SkillsDeleteSchema,
} from "@contracts/ipc";
import type { SkillInfo, SkillSource } from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** Case-insensitive, normalized equality for project-root matching — same
 *  helper logic the file handlers use (they inline it as `samePath`). Paths
 *  arrive with arbitrary case/trailing slashes from the renderer, so a raw
 *  `===` would falsely refuse legit roots on case-insensitive filesystems. */
function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/** True if `abs` is inside `root` (or equals it), after normalizing both.
 *  Containment check for write/delete ops — same logic as files.ts pathWithin.
 *  Separator-aware so "/foo/bar" doesn't match root "/foo/ba". */
function pathWithin(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

/** Resolve a known project root from a caller-supplied projectPath, or null
 *  when it isn't a persisted Project. Centralizes the same containment guard
 *  every skills handler uses (mirrors files.ts / git.ts). */
function findKnownProject(projectPath: string) {
  return ProjectRepo.list().find((p) => samePath(p.path, projectPath));
}

/** Resolve the skills root directory for a given source. Global skills live
 *  under ~/.claude/skills; project skills under <project>/.claude/skills.
 *  Returns the absolute root path. */
function resolveSkillRoot(source: SkillSource, projectPath: string): string {
  if (source === "global") {
    return path.join(homedir(), ".claude", "skills");
  }
  return path.join(projectPath, ".claude", "skills");
}

/** Resolves to an absolute path, following symlinks. Returns null on any
 *  error (missing / no access) so the caller can skip cleanly. */
async function safeRealPath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/** Read up to `maxBytes` of a file as utf-8 text. Returns null on any error. */
async function readTextHead(filePath: string, maxBytes = 8192): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Parse the YAML frontmatter of a SKILL.md file. We only need `name`,
 * `description`, and (optionally) `argument-hint` / `argumentHint`, so a
 * hand-rolled line scan is enough — no yaml dependency. The frontmatter is
 * the YAML block delimited by `---` lines at the top of the file.
 *
 * Returns whatever fields were found; the caller fills in fallbacks
 * (e.g. name ← directory name).
 */
function parseSkillFrontmatter(md: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
} {
  // Frontmatter must be the very first thing in the file: "---\n".
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return {};
  // Find the closing "---" on its own line. Split on newlines so the leading
  // "---" line isn't matched by the closing fence regex.
  const lines = md.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const fm = lines.slice(1, end);

  const out: { name?: string; description?: string; argumentHint?: string } = {};
  for (const raw of fm) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    // Strip surrounding quotes (single/double) and trailing whitespace.
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "name") out.name = val;
    else if (key === "description") out.description = val;
    else if (key === "argument-hint" || key === "argumenthint") out.argumentHint = val;
  }
  return out;
}

/**
 * Scan one skills root dir and append its skills to `into`. Each direct child
 * directory is treated as a skill; its SKILL.md frontmatter supplies the
 * metadata, with the directory name as the `name` fallback. Symlinks are
 * followed (realpath). Any IO error is caught and skipped — this function
 * never throws.
 */
async function scanSkillsRoot(rootDir: string, source: SkillSource, into: Map<string, SkillInfo>): Promise<void> {
  const root = await safeRealPath(rootDir);
  if (!root) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // not present / unreadable — nothing to list
  }
  for (const entry of entries) {
    // A skill is a directory — either a real one or a symlink pointing at a
    // directory (common when linking a shared checkout like gstack). NOTE:
    // `Dirent.isDirectory()` does NOT follow symlinks — a symlink reports
    // `isSymbolicLink()` and `isDirectory() === false` — so we must accept
    // both and let `safeRealPath` resolve the link to its real target. Plain
    // files (e.g. .DS_Store) fall through and are skipped.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = path.join(root, entry.name);
    const real = await safeRealPath(skillPath);
    if (!real) continue;
    // Guard against symlinks that resolve to a file (not a dir) — `realpath`
    // follows the link, so a stat on the resolved path tells the true type.
    let isDir = true;
    try {
      const st = await fs.stat(real);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const md = await readTextHead(path.join(real, "SKILL.md"));
    const fm = md ? parseSkillFrontmatter(md) : {};
    const name = fm.name?.trim() || entry.name;
    // Dedupe by name: project-scoped entries are scanned AFTER global ones,
    // so a project skill naturally overrides a same-named global skill.
    into.set(name, {
      name,
      description: fm.description?.trim() ?? "",
      argumentHint: fm.argumentHint?.trim() || undefined,
      source,
    });
  }
}

export function registerSkillsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SKILLS_LIST, async (_evt, raw) => {
    const input = SkillsListSchema.parse(raw);
    // Containment guard: the project root must be a known persisted Project.
    const project = findKnownProject(input.projectPath);
    if (!project) {
      return { skills: [] };
    }
    const globalDir = resolveSkillRoot("global", project.path);
    const projectDir = resolveSkillRoot("project", project.path);

    const byName = new Map<string, SkillInfo>();
    try {
      // Global first, then project — so project entries override.
      await scanSkillsRoot(globalDir, "global", byName);
      await scanSkillsRoot(projectDir, "project", byName);
    } catch (err) {
      // Should be unreachable (scanSkillsRoot never throws), but be defensive:
      // a broken skills dir must never break the composer.
      log.warn(`skills.list scan failed: ${(err as Error).message}`);
    }
    // Stable ordering: project-first then global, alphabetical within each,
    // so the menu doesn't reshuffle between renders.
    const skills = [...byName.values()].sort((a, b) => {
      if (a.source !== b.source) return a.source === "project" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { skills };
  });

  // ── Read one skill's full SKILL.md source ──
  ipcMain.handle(IPC.SKILLS_READ, async (_evt, raw) => {
    const input = SkillsReadSchema.parse(raw);
    const project = findKnownProject(input.projectPath);
    if (!project) return { content: "" };
    const root = resolveSkillRoot(input.source, project.path);
    const skillDir = path.join(root, input.name);
    // Containment guard: the resolved skill dir must stay inside the root.
    if (!pathWithin(root, skillDir)) return { content: "" };
    try {
      const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
      return { content };
    } catch {
      // Missing file (e.g. a skill dir without SKILL.md) → empty editor.
      return { content: "" };
    }
  });

  // ── Create or overwrite a skill's SKILL.md ──
  ipcMain.handle(IPC.SKILLS_SAVE, async (_evt, raw) => {
    const input = SkillsSaveSchema.parse(raw);
    const project = findKnownProject(input.projectPath);
    if (!project) return { ok: false, error: "未知的项目路径" };
    const root = resolveSkillRoot(input.source, project.path);
    const skillDir = path.join(root, input.name);
    if (!pathWithin(root, skillDir)) {
      return { ok: false, error: "无效的 skill 路径" };
    }
    try {
      // Rename (move) the skill directory when a new name is requested and it
      // actually differs. Reserved for future rename UI; v1 leaves it unset.
      if (input.newName && input.newName !== input.name) {
        const newDir = path.join(root, input.newName);
        if (!pathWithin(root, newDir)) {
          return { ok: false, error: "无效的新 skill 名" };
        }
        await fs.rename(skillDir, newDir);
      }
      const targetDir = input.newName && input.newName !== input.name
        ? path.join(root, input.newName)
        : skillDir;
      // mkdir -p the skill dir (and the .claude/skills root if it's the first
      // project-scoped skill). recursive:true is a no-op if it already exists.
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "SKILL.md"), input.content, "utf-8");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Delete a skill directory ──
  ipcMain.handle(IPC.SKILLS_DELETE, async (_evt, raw) => {
    const input = SkillsDeleteSchema.parse(raw);
    const project = findKnownProject(input.projectPath);
    if (!project) return { ok: false, error: "未知的项目路径" };
    const root = resolveSkillRoot(input.source, project.path);
    const skillDir = path.join(root, input.name);
    if (!pathWithin(root, skillDir)) {
      return { ok: false, error: "无效的 skill 路径" };
    }
    try {
      // Distinguish symlink vs real directory: a symlinked skill (common when
      // users link a shared checkout like gstack) must only have the LINK
      // removed — unlinking the target would destroy the shared source. Real
      // directories are removed recursively.
      const stat = await fs.lstat(skillDir);
      if (stat.isSymbolicLink()) {
        await fs.unlink(skillDir);
      } else if (stat.isDirectory()) {
        await fs.rm(skillDir, { recursive: true, force: true });
      } else {
        // Not a dir and not a symlink — refuse rather than delete an unknown
        // file type (defensive; the lister only ever surfaces directories).
        return { ok: false, error: "目标不是 skill 目录" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
