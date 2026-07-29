/**
 * Shared filesystem path containment helpers used by IDE IPC handlers
 * (files / git / terminal). Every renderer-supplied path must resolve inside
 * a known project root before main touches the disk or spawns a process.
 */
import { resolve, sep } from "node:path";
import { ProjectRepo } from "@main/store/repositories.js";

/** Compare two filesystem paths for equality after normalizing (resolving
 *  `.`, `..`, redundant separators, and trailing separators). */
export function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** True if `abs` is inside `root` (or equals it), after normalizing both.
 *  Uses `resolve` + a separator-aware prefix check so "/foo/bar" doesn't
 *  match root "/foo/ba". */
export function pathWithin(root: string, abs: string): boolean {
  const r = resolve(root);
  const a = resolve(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

/** Verify a path is inside SOME persisted project root. Returns the matching
 *  project root path, or null if the path is outside all roots (refuse). */
export function findContainingProject(absPath: string): string | null {
  const projects = ProjectRepo.list();
  const proj = projects.find((p) => pathWithin(p.path, absPath));
  return proj?.path ?? null;
}

/** True if `projectPath` exactly matches a persisted Project.path (normalized). */
export function isKnownProjectPath(projectPath: string): boolean {
  return ProjectRepo.list().some((p) => samePath(p.path, projectPath));
}
