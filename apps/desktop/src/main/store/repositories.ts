/**
 * Repository functions over the three SQLite tables. Each function does the
 * camelCase (domain) ↔ snake_case (column) translation so callers stay in
 * domain types. Synchronous (sql.js queries are sync); writes trigger a coalesced
 * flush to disk via `persist()`.
 *
 * Replaces the P1 in-memory Maps (memoryStore.ts). The two call sites are
 * ipc/projects.ts and ipc/claude.ts.
 */
import type {
  Project,
  Session,
  MessageRecord,
  SessionTodoItem,
  SessionPlanDraft,
} from "@contracts/session";
import type { ContextSnapshot, SubagentSnapshot } from "@contracts/runtime";
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

function safeJson(x: unknown): unknown {
  if (typeof x !== "string") return x;
  try { return JSON.parse(x); } catch { return x; }
}

/* ─────────────────────────────── Projects ─────────────────────────────── */

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const ProjectRepo = {
  create(p: Project): void {
    getDb().run(
      "INSERT INTO projects (id, name, path, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [v(p.id), v(p.name), v(p.path), v(p.archived ? 1 : 0), v(p.createdAt), v(p.updatedAt)],
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

  /** Hard-delete a project. Child sessions + messages cascade-delete via the
   *  sessions.project_id / messages.session_id ON DELETE CASCADE constraints
   *  (PRAGMA foreign_keys = ON is set in initDb). */
  delete(id: string): void {
    getDb().run("DELETE FROM projects WHERE id = ?", [v(id)]);
    persist();
  },

  /** Set the archived (soft-delete) flag. */
  setArchived(id: string, archived: boolean): void {
    getDb().run("UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?", [
      v(archived ? 1 : 0),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },
};

/* ─────────────────────────────── Sessions ─────────────────────────────── */

interface SessionRow {
  id: string;
  project_id: string;
  provider_id: string;
  claude_session_id: string | null;
  title: string;
  status: string;
  model: string;
  effort: string;
  permission_mode: string;
  custom_model_id: string | null;
  archived: number;
  context_snapshot: string | null;
  todos: string | null;
  subagents: string | null;
  plan_draft: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    projectId: r.project_id,
    providerId: r.provider_id ?? "claude-sdk",
    claudeSessionId: r.claude_session_id,
    title: r.title,
    status: r.status as Session["status"],
    model: r.model,
    effort: r.effort as Session["effort"],
    permissionMode: r.permission_mode as Session["permissionMode"],
    customModelId: r.custom_model_id ?? null,
    archived: !!r.archived,
    contextSnapshot: (r.context_snapshot ? safeJson(r.context_snapshot) : null) as ContextSnapshot | null,
    todos: (r.todos ? safeJson(r.todos) : null) as SessionTodoItem[] | null,
    subagents: (r.subagents ? safeJson(r.subagents) : null) as SubagentSnapshot[] | null,
    planDraft: (r.plan_draft ? safeJson(r.plan_draft) : null) as SessionPlanDraft | null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const SessionRepo = {
  create(s: Session): void {
    getDb().run(
      `INSERT INTO sessions
       (id, project_id, provider_id, claude_session_id, title, status, model, effort, permission_mode, custom_model_id, archived, context_snapshot, todos, subagents, plan_draft, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v(s.id),
        v(s.projectId),
        v(s.providerId),
        v(s.claudeSessionId),
        v(s.title),
        v(s.status),
        v(s.model),
        v(s.effort),
        v(s.permissionMode),
        v(s.customModelId),
        v(s.archived ? 1 : 0),
        v(s.contextSnapshot ? JSON.stringify(s.contextSnapshot) : null),
        v(s.todos ? JSON.stringify(s.todos) : null),
        v(s.subagents ? JSON.stringify(s.subagents) : null),
        v(s.planDraft ? JSON.stringify(s.planDraft) : null),
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

  /** Persist the latest context-usage snapshot for a session. */
  updateSnapshot(id: string, snapshot: unknown): void {
    getDb().run("UPDATE sessions SET context_snapshot = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(snapshot)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the latest todo list (claude's TodoWrite) for a session. */
  updateTodos(id: string, todos: SessionTodoItem[]): void {
    getDb().run("UPDATE sessions SET todos = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(todos)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the latest subagent roster for a session. */
  updateSubagents(id: string, agents: SubagentSnapshot[]): void {
    getDb().run("UPDATE sessions SET subagents = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(agents)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the latest plan-mode draft for a session. */
  updatePlanDraft(id: string, plan: SessionPlanDraft): void {
    getDb().run("UPDATE sessions SET plan_draft = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(plan)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist which custom-model config this session is bound to (null = built-in). */
  updateCustomModelId(id: string, customModelId: string | null): void {
    getDb().run("UPDATE sessions SET custom_model_id = ?, updated_at = ? WHERE id = ?", [
      v(customModelId),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Hard-delete a session. Child messages cascade-delete via
   *  messages.session_id ON DELETE CASCADE. */
  delete(id: string): void {
    getDb().run("DELETE FROM sessions WHERE id = ?", [v(id)]);
    persist();
  },

  /** Set the archived (soft-delete) flag. */
  setArchived(id: string, archived: boolean): void {
    getDb().run("UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?", [
      v(archived ? 1 : 0),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Update session-scoped settings (model, effort, permissionMode, customModelId). */
  updateSettings(
    id: string,
    patch: { model?: string; effort?: string; permissionMode?: string; customModelId?: string | null },
  ): void {
    const sets: string[] = [];
    const vals: BindValue[] = [];
    if (patch.model !== undefined) { sets.push("model = ?"); vals.push(v(patch.model)); }
    if (patch.effort !== undefined) { sets.push("effort = ?"); vals.push(v(patch.effort)); }
    if (patch.permissionMode !== undefined) { sets.push("permission_mode = ?"); vals.push(v(patch.permissionMode)); }
    if (patch.customModelId !== undefined) { sets.push("custom_model_id = ?"); vals.push(v(patch.customModelId)); }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    vals.push(v(Date.now()), v(id));
    getDb().run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, vals);
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
