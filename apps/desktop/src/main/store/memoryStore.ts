import type { Project, Session } from "@contracts/session";

/** In-memory store for P1. P2 replaces this with SQLite persistence.
 * Kept as a module singleton so all IPC handlers share one source of truth. */

export const projects = new Map<string, Project>();
export const sessions = new Map<string, Session>();

/** Find the project (and thus cwd) for a given session. */
export function projectForSession(sessionId: string): Project | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return projects.get(session.projectId);
}
