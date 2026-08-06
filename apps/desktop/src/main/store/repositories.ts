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
import type { ContextSnapshot, SubagentSnapshot, TurnFileEntry, TurnUsageRecord } from "@contracts/runtime";
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
  group: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    archived: !!r.archived,
    // Normalize empty string / undefined (pre-migration rows) to null so the
    // renderer only ever sees null | <non-empty group name>.
    group: r.group && r.group.length > 0 ? r.group : null,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const ProjectRepo = {
  create(p: Project): void {
    const db = getDb();
    // Append the new project at the end: MAX(sort_order)+1. COALESCE handles
    // the empty-table case (MAX returns NULL → -1 → next is 0). Computed here
    // (not passed in) so callers don't have to reason about ordering.
    const nextOrderStmt = db.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects",
    );
    nextOrderStmt.step();
    const nextOrder = (nextOrderStmt.getAsObject() as { next: number }).next;
    nextOrderStmt.free();
    db.run(
      "INSERT INTO projects (id, name, path, archived, `group`, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        v(p.id),
        v(p.name),
        v(p.path),
        v(p.archived ? 1 : 0),
        v(p.group ?? null),
        v(nextOrder),
        v(p.createdAt),
        v(p.updatedAt),
      ],
    );
    persist();
  },

  list(): Project[] {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC",
    );
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

  /** Assign a project to a group. Pass null to remove it from any group.
   *  `group` is a column name in SQLite so it must be backtick-quoted. */
  setGroup(id: string, group: string | null): void {
    getDb().run("UPDATE projects SET `group` = ?, updated_at = ? WHERE id = ?", [
      v(group),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Rewrite sort_order for every id in `orderedIds` (index = position).
   *  Accepts the full ordered list so the operation is idempotent and
   *  self-healing — gaps from prior deletes collapse on the next reorder.
   *  Unknown ids in the input are skipped (the UPDATE matches nothing); ids
   *  absent from the input keep their old sort_order. Mirrors the
   *  MessageRepo.replaceAll transaction pattern. */
  reorder(orderedIds: string[]): void {
    const db = getDb();
    db.run("BEGIN");
    try {
      const stmt = db.prepare("UPDATE projects SET sort_order = ? WHERE id = ?");
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run([v(i), v(orderedIds[i])]);
      }
      stmt.free();
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
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
  turn_files: string | null;
  usage_history: string | null;
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
    turnFiles: (r.turn_files ? safeJson(r.turn_files) : null) as TurnFileEntry[] | null,
    usageHistory: (r.usage_history ? safeJson(r.usage_history) : null) as TurnUsageRecord[] | null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const SessionRepo = {
  create(s: Session): void {
    getDb().run(
      `INSERT INTO sessions
       (id, project_id, provider_id, claude_session_id, title, status, model, effort, permission_mode, custom_model_id, archived, context_snapshot, todos, subagents, plan_draft, turn_files, usage_history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        v(s.turnFiles ? JSON.stringify(s.turnFiles) : null),
        v(s.usageHistory ? JSON.stringify(s.usageHistory) : null),
        v(s.createdAt),
        v(s.updatedAt),
      ],
    );
    persist();
  },

  /** List sessions for a project, most recently active first.
   *
   *  Ordered by `updated_at DESC` so a session floats to the top whenever it
   *  is touched (new message, title/status change, snapshot save, …); ties
   *  fall back to `created_at DESC` for a stable order. `opts.limit` /
   *  `opts.offset` paginate (used by the left-bar tree, which loads the first
   *  page and appends on "load more"). `opts.archived` filters by the
   *  soft-delete flag: omit for all, `false` for the active thread list, `true`
   *  for the archived bin. */
  listByProject(
    projectId: string,
    opts?: { limit?: number; offset?: number; archived?: boolean },
  ): Session[] {
    const db = getDb();
    const where = ["project_id = ?"];
    const params: BindValue[] = [v(projectId)];
    if (opts?.archived !== undefined) {
      where.push("archived = ?");
      params.push(opts.archived ? 1 : 0);
    }
    let sql = `SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, created_at DESC`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(v(opts.limit));
      if (opts?.offset !== undefined) {
        sql += " OFFSET ?";
        params.push(v(opts.offset));
      }
    }
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
  },

  /** Count sessions for a project, optionally filtered by archived flag.
   *  Used to compute `hasMore` for pagination. */
  countByProject(projectId: string, archived?: boolean): number {
    const db = getDb();
    const where = ["project_id = ?"];
    const params: BindValue[] = [v(projectId)];
    if (archived !== undefined) {
      where.push("archived = ?");
      params.push(archived ? 1 : 0);
    }
    const stmt = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${where.join(" AND ")}`);
    stmt.bind(params);
    stmt.step();
    const n = (stmt.getAsObject() as { n: number }).n;
    stmt.free();
    return n;
  },

  /** Cross-project title-substring search (Ctrl+K unified search). Scans all
   *  non-archived sessions across every project, newest first. Desktop-scale
   *  session counts make a full-table LIKE scan cheap; no FTS index needed. */
  searchByTitle(query: string, opts?: { limit?: number }): Session[] {
    const db = getDb();
    const q = `%${query.trim()}%`;
    const params: BindValue[] = [v(q)];
    const limit = opts?.limit ?? 30;
    params.push(v(limit));
    const sql = `SELECT * FROM sessions WHERE archived = 0 AND title LIKE ? ORDER BY updated_at DESC, created_at DESC LIMIT ?`;
    const stmt = db.prepare(sql);
    stmt.bind(params);
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

  /** Persist the most recent turn's modified-files snapshot (the "本轮修改"
   *  card). Pass null to clear it (e.g. after a rewind) so the card doesn't
   *  reappear on session reopen. */
  updateTurnFiles(id: string, files: TurnFileEntry[] | null): void {
    getDb().run("UPDATE sessions SET turn_files = ?, updated_at = ? WHERE id = ?", [
      v(files ? JSON.stringify(files) : null),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the per-turn token/cost history. Appended at each turn-end so
   *  the context-stats history popover survives restart. */
  updateUsageHistory(id: string, history: TurnUsageRecord[]): void {
    getDb().run("UPDATE sessions SET usage_history = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(history)),
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

  /** Update session-scoped settings (model, effort, permissionMode,
   *  customModelId, providerId). */
  updateSettings(
    id: string,
    patch: { model?: string; effort?: string; permissionMode?: string; customModelId?: string | null; providerId?: string },
  ): void {
    const sets: string[] = [];
    const vals: BindValue[] = [];
    if (patch.model !== undefined) { sets.push("model = ?"); vals.push(v(patch.model)); }
    if (patch.effort !== undefined) { sets.push("effort = ?"); vals.push(v(patch.effort)); }
    if (patch.permissionMode !== undefined) { sets.push("permission_mode = ?"); vals.push(v(patch.permissionMode)); }
    if (patch.customModelId !== undefined) { sets.push("custom_model_id = ?"); vals.push(v(patch.customModelId)); }
    if (patch.providerId !== undefined) { sets.push("provider_id = ?"); vals.push(v(patch.providerId)); }
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
