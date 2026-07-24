/**
 * Repository functions over the three SQLite tables. Each function does the
 * camelCase (domain) ↔ snake_case (column) translation so callers stay in
 * domain types. Synchronous (sql.js queries are sync); writes trigger a coalesced
 * flush to disk via `persist()`.
 *
 * Replaces the P1 in-memory Maps (memoryStore.ts). The two call sites are
 * ipc/projects.ts and ipc/claude.ts.
 */
import type { Project, Session, MessageRecord } from "@contracts/session";
import { getDb, persist } from "./db.js";

/* sql.js binds `?` params positionally as an array. Values must be
 * string | number | Uint8Array | null — booleans/undefined aren't accepted,
 * so we normalize values before binding. Nulls are passed through. */
type BindValue = string | number | Uint8Array | null;
function v(x: unknown): BindValue {
  if (x === undefined || x === null) return null;
  if (typeof x === "boolean") return x ? 1 : 0;
  return x as BindValue;
}

/* ─────────────────────────────── Projects ─────────────────────────────── */

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
  updated_at: number;
}

function rowToProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, path: r.path, createdAt: r.created_at, updatedAt: r.updated_at };
}

export const ProjectRepo = {
  create(p: Project): void {
    getDb().run(
      "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [v(p.id), v(p.name), v(p.path), v(p.createdAt), v(p.updatedAt)],
    );
    persist();
  },

  list(): Project[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM projects ORDER BY created_at ASC");
    const out: Project[] = [];
    while (stmt.step()) out.push(rowToProject(stmt.getAsObject() as unknown as ProjectRow));
    stmt.free();
    return out;
  },

  get(id: string): Project | undefined {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM projects WHERE id = ?");
    stmt.bind([v(id)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as ProjectRow) : undefined;
    stmt.free();
    return row ? rowToProject(row) : undefined;
  },
};

/* ─────────────────────────────── Sessions ─────────────────────────────── */

interface SessionRow {
  id: string;
  project_id: string;
  claude_session_id: string | null;
  title: string;
  status: string;
  model: string;
  effort: string;
  permission_mode: string;
  created_at: number;
  updated_at: number;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    projectId: r.project_id,
    claudeSessionId: r.claude_session_id,
    title: r.title,
    status: r.status as Session["status"],
    model: r.model,
    effort: r.effort as Session["effort"],
    permissionMode: r.permission_mode as Session["permissionMode"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const SessionRepo = {
  create(s: Session): void {
    getDb().run(
      `INSERT INTO sessions
       (id, project_id, claude_session_id, title, status, model, effort, permission_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v(s.id),
        v(s.projectId),
        v(s.claudeSessionId),
        v(s.title),
        v(s.status),
        v(s.model),
        v(s.effort),
        v(s.permissionMode),
        v(s.createdAt),
        v(s.updatedAt),
      ],
    );
    persist();
  },

  listByProject(projectId: string): Session[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC");
    stmt.bind([v(projectId)]);
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
  },

  get(id: string): Session | undefined {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
    stmt.bind([v(id)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as SessionRow) : undefined;
    stmt.free();
    return row ? rowToSession(row) : undefined;
  },

  /** Persist claude's own session id so future turns can --resume. */
  updateClaudeSessionId(id: string, claudeSessionId: string): void {
    getDb().run("UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?", [
      v(claudeSessionId),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  updateTitle(id: string, title: string): void {
    getDb().run("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", [v(title), v(Date.now()), v(id)]);
    persist();
  },

  updateStatus(id: string, status: Session["status"]): void {
    getDb().run("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?", [v(status), v(Date.now()), v(id)]);
    persist();
  },
};

/* ─────────────────────────────── Messages ─────────────────────────────── */

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string; // JSON string
  created_at: number;
}

function rowToMessage(r: MessageRow): MessageRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as MessageRecord["role"],
    content: JSON.parse(r.content),
    createdAt: r.created_at,
  };
}

export const MessageRepo = {
  /**
   * Replace all messages for a session with the given snapshot. The renderer
   * sends the full ChatMessage[] at turn boundaries (turn.done / error); we
   * wipe and re-insert in one transaction so the table always reflects the
   * last-complete view. Simple and avoids per-delta write churn.
   */
  replaceAll(sessionId: string, messages: MessageRecord[]): void {
    const db = getDb();
    db.run("BEGIN");
    try {
      db.run("DELETE FROM messages WHERE session_id = ?", [v(sessionId)]);
      const stmt = db.prepare(
        "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const m of messages) {
        stmt.run([v(m.id), v(m.sessionId), v(m.role), v(JSON.stringify(m.content)), v(m.createdAt)]);
      }
      stmt.free();
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },

  listBySession(sessionId: string): MessageRecord[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC");
    stmt.bind([v(sessionId)]);
    const out: MessageRecord[] = [];
    while (stmt.step()) out.push(rowToMessage(stmt.getAsObject() as unknown as MessageRow));
    stmt.free();
    return out;
  },
};

/* ─────────────────────────────── Settings ──────────────────────────────── */
/* Generic key-value store for app preferences (e.g. the configured claude CLI
 * path). Keeps us from adding a table per setting. */

export const SettingRepo = {
  get(key: string): string | null {
    const db = getDb();
    const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    stmt.bind([v(key)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as { value: BindValue }) : undefined;
    stmt.free();
    return row ? String(row.value) : null;
  },

  /** Upsert a setting value. */
  set(key: string, value: string): void {
    getDb().run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [v(key), v(value)],
    );
    persist();
  },
};
