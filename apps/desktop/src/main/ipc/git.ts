/**
 * IPC handlers for git operations (status / stage / commit / push / pull / diff).
 *
 * All operations are scoped to a `repoPath` that must resolve inside a known
 * project root — the same path-containment guard the file handlers use. A
 * single project folder may host MULTIPLE git repos (monorepo, submodules,
 * nested projects); `git.discoverRepos` finds them all by recursive scan.
 *
 * Git access goes through `simple-git` (wraps the system `git` CLI), so auth
 * (SSH keys, credential helpers, git credential manager) is handled by the
 * user's existing system configuration — the app never touches credentials.
 *
 * Every handler degrades gracefully: errors return `{ ok: false, error }` (or
 * empty results) rather than throwing into the renderer.
 */
import type { IpcMain } from "electron";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import simpleGit from "simple-git";
import {
  IPC,
  GitDiscoverReposSchema,
  GitRepoPathSchema,
  GitStageSchema,
  GitUnstageSchema,
  GitCommitSchema,
  GitDiffSchema,
  GitDiscardSchema,
} from "@contracts/ipc";
import type { GitRepo, GitStatusResult, GitFileStatus, GitStatusCode } from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** Max recursion depth for repo discovery. Keeps the scan fast on deep trees
 *  while still finding nested monorepo packages. */
const MAX_SCAN_DEPTH = 3;

/** Directory names to skip during repo discovery (never contain repos we care
 *  about, and descending into them is slow). */
const SCAN_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "out",
]);

/** True if `abs` is inside `root` (or equals it), after normalizing both. */
function pathWithin(root: string, abs: string): boolean {
  const r = resolve(root);
  const a = resolve(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

/** Verify a repoPath is inside SOME persisted project root. Returns the
 *  matching project root, or null if the path is outside all roots (refuse). */
function findContainingProject(repoPath: string): string | null {
  const projects = ProjectRepo.list();
  const proj = projects.find((p) => pathWithin(p.path, repoPath));
  return proj?.path ?? null;
}

/* ───────────────────────── repo discovery ───────────────────────── */

/** Recursively scan `dir` for directories containing a `.git` entry, up to
 *  `maxDepth` levels deep. Returns absolute repo-root paths. Stops descending
 *  into a directory once it's identified as a repo (nested repos inside a repo
 *  are found via their own `.git` only if they're separate worktrees — the
 *  common case is: the root is a repo OR some subdirs are repos). */
async function findGitRepos(dir: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results; // unreadable / gone — skip
  }

  // Check if THIS directory is a git repo (has a .git entry).
  const hasGit = entries.some((e) => e.name === ".git");
  if (hasGit) {
    results.push(dir);
    // Continue scanning subdirs — there may be nested independent repos
    // (e.g. a meta-folder containing several cloned projects).
  }

  if (maxDepth <= 0) return results;

  // Recurse into subdirectories (skip ignored dirs).
  const subdirs = entries.filter(
    (e) => e.isDirectory() && !SCAN_IGNORE.has(e.name),
  );
  await Promise.all(
    subdirs.map(async (e) => {
      const childResults = await findGitRepos(join(dir, e.name), maxDepth - 1);
      results.push(...childResults);
    }),
  );
  return results;
}

/* ───────────────────────── status mapping ───────────────────────── */

/** Map a single porcelain status character to our GitStatusCode union. */
function mapStatusCode(code: string): GitStatusCode {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    case "?":
      return "untracked";
    case "!":
      return "ignored";
    default:
      return "unmodified";
  }
}

/** Map simple-git's StatusResult to our GitStatusResult contract type. */
function mapStatus(raw: import("simple-git").StatusResult): GitStatusResult {
  // simple-git's `.files` array has { path, index, working_dir } where the
  // status codes are single porcelain characters.
  const files: GitFileStatus[] = raw.files.map((f) => ({
    path: f.path,
    index: mapStatusCode(f.index || " "),
    workingTree: mapStatusCode(f.working_dir || " "),
  }));
  return {
    branch: raw.current || "",
    ahead: raw.ahead || 0,
    behind: raw.behind || 0,
    files,
  };
}

/* ───────────────────────── handler registration ───────────────────────── */

export function registerGitHandlers(ipcMain: IpcMain): void {
  /* ── git:discoverRepos — find all git repos under a project root ── */
  ipcMain.handle(IPC.GIT_DISCOVER_REPOS, async (_evt, raw) => {
    const input = GitDiscoverReposSchema.parse(raw);
    // Verify the project path is a known persisted project.
    const known = ProjectRepo.list().some((p) => resolve(p.path) === resolve(input.projectPath));
    if (!known) {
      log.warn(`git.discoverRepos refused — unknown projectPath: ${input.projectPath}`);
      return { repos: [] };
    }
    try {
      const repoPaths = await findGitRepos(input.projectPath, MAX_SCAN_DEPTH);
      const repos: GitRepo[] = repoPaths.map((p) => {
        const rel = relative(input.projectPath, p);
        const name = rel === "" ? input.projectPath.split(/[/\\]/).pop() || p : rel;
        return { path: p, name, isRepo: true as const };
      });
      // Sort by name for stable display order.
      repos.sort((a, b) => a.name.localeCompare(b.name));
      log.info(`git.discoverRepos found ${repos.length} repo(s) under ${input.projectPath}`);
      return { repos };
    } catch (err) {
      log.error(`git.discoverRepos failed: ${(err as Error).message}`);
      return { repos: [] };
    }
  });

  /* ── git:status — status of a single repo ── */
  ipcMain.handle(IPC.GIT_STATUS, async (_evt, raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      log.warn(`git.status refused — repoPath outside any project: ${input.repoPath}`);
      return { status: { branch: "", ahead: 0, behind: 0, files: [] } };
    }
    try {
      const git = simpleGit(input.repoPath);
      const status = await git.status();
      return { status: mapStatus(status) };
    } catch (err) {
      log.warn(`git.status failed for ${input.repoPath}: ${(err as Error).message}`);
      return { status: { branch: "", ahead: 0, behind: 0, files: [] } };
    }
  });

  /* ── git:stage — git add specific files ── */
  ipcMain.handle(IPC.GIT_STAGE, async (_evt, raw) => {
    const input = GitStageSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = simpleGit(input.repoPath);
      await git.add(input.filePaths);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.stage failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:unstage — git reset specific files ── */
  ipcMain.handle(IPC.GIT_UNSTAGE, async (_evt, raw) => {
    const input = GitUnstageSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = simpleGit(input.repoPath);
      // `git reset HEAD -- <files>` unstages without touching working tree.
      await git.reset(input.filePaths.length > 0 ? ["--", ...input.filePaths] : []);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.unstage failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:commit — commit staged changes ── */
  ipcMain.handle(IPC.GIT_COMMIT, async (_evt, raw) => {
    const input = GitCommitSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = simpleGit(input.repoPath);
      await git.commit(input.message);
      log.info(`git.commit succeeded in ${input.repoPath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.commit failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:push — push to upstream ── */
  ipcMain.handle(IPC.GIT_PUSH, async (_evt, raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = simpleGit(input.repoPath);
      await git.push();
      log.info(`git.push succeeded in ${input.repoPath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.push failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:pull — pull from upstream ── */
  ipcMain.handle(IPC.GIT_PULL, async (_evt, raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = simpleGit(input.repoPath);
      await git.pull();
      log.info(`git.pull succeeded in ${input.repoPath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.pull failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:diff — unstaged diff of a single file ── */
  ipcMain.handle(IPC.GIT_DIFF, async (_evt, raw) => {
    const input = GitDiffSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { patch: "" };
    }
    try {
      const git = simpleGit(input.repoPath);
      const patch = await git.diff(["--", input.filePath]);
      return { patch };
    } catch (err) {
      log.warn(`git.diff failed for ${input.repoPath}/${input.filePath}: ${(err as Error).message}`);
      return { patch: "" };
    }
  });

  /* ── git:discard — discard local changes (checkout tracked / clean untracked) ── */
  ipcMain.handle(IPC.GIT_DISCARD, async (_evt, raw) => {
    const input = GitDiscardSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = simpleGit(input.repoPath);
      // Separate tracked (modified/staged/deleted) from untracked files:
      // tracked → git checkout -- <file> (restore to index)
      // untracked → git clean -f -- <file> (remove)
      const status = await git.status();
      const untrackedSet = new Set(
        status.files.filter((f) => f.working_dir === "?" || f.index === "?").map((f) => f.path),
      );
      const tracked: string[] = [];
      const untracked: string[] = [];
      for (const fp of input.filePaths) {
        if (untrackedSet.has(fp)) untracked.push(fp);
        else tracked.push(fp);
      }
      if (tracked.length > 0) {
        await git.checkout(["--", ...tracked]);
      }
      if (untracked.length > 0) {
        await git.clean("f", ["-d", "--", ...untracked]);
      }
      log.info(`git.discard succeeded in ${input.repoPath} (${tracked.length} tracked, ${untracked.length} untracked)`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.discard failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });
}
