/**
 * Session domain types — projects, sessions, and messages persisted in SQLite.
 */
import type {
  PermissionMode,
  SessionStatus,
  EffortLevel,
  ContextSnapshot,
  SubagentSnapshot,
  PlanUpdateEvent,
  TurnFileEntry,
} from "./runtime.js";

/** A single todo item (mirrors the renderer's TodoItem; kept here so the
 *  persisted Session row is typed on both sides of the IPC boundary). */
export interface SessionTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/** Plan-mode draft snapshot persisted with the session. Same shape as
 *  PlanDraft in the renderer store and PlanUpdateEvent's payload. */
export interface SessionPlanDraft {
  plan: string;
  phase: PlanUpdateEvent["phase"];
}

export interface Project {
  id: string;
  name: string;
  /** Absolute filesystem path that claude will use as cwd. */
  path: string;
  /** Soft-delete flag: archived projects are hidden from the main tree and
   *  live in the "archived" section; they can be restored or hard-deleted. */
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  /** The provider powering this session. Defaults to "claude-sdk". */
  providerId: string;
  /** claude's own session id, used for `--resume`. Null until first turn. */
  claudeSessionId: string | null;
  title: string;
  status: SessionStatus;
  /** Model alias or full name ("default" = let claude pick). → --model. */
  model: string;
  /** Reasoning effort ("default" = don't pass --effort). → --effort. */
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /** Id of the user's custom-model config bound to this session (null = use
   *  built-in credential discovery). Set when the user picks a custom model
   *  in the composer; persisted so a resumed session keeps its endpoint. */
  customModelId: string | null;
  /** Soft-delete flag: archived sessions are hidden from the main tree and
   *  live in the "archived" section; they can be restored or hard-deleted. */
  archived: boolean;
  /** Normalized ContextSnapshot from the most recent token-usage.updated
   *  event, serialized as JSON. Null for sessions that never saw a turn. */
  contextSnapshot: ContextSnapshot | null;
  /** Capsule state persisted so the top-right status pill reloads on
   *  session reopen. Each is null for sessions that never produced the
   *  corresponding activity. JSON-serialized in the DB. */
  todos: SessionTodoItem[] | null;
  subagents: SubagentSnapshot[] | null;
  planDraft: SessionPlanDraft | null;
  /** Files touched by the most recent turn (persisted so the "本轮修改" card
   *  survives a session reopen). Null for sessions that never saw a file edit.
   *  Cleared (set to null) after a rewind. JSON-serialized in the DB. */
  turnFiles: TurnFileEntry[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  /** Content stored as JSON: text blocks, tool_use, tool_result, etc. */
  content: unknown;
  createdAt: number;
}

/** Input to start a new session turn. */
export interface TurnInput {
  sessionId: string;
  prompt: string;
  /** File paths attached via @file references. */
  attachments?: string[];
}

/** A user's decision on an approval request. */
export interface ApprovalDecision {
  sessionId: string;
  requestId: string;
  granted: boolean;
  /** If true, remember the decision for this tool type this session. */
  always?: boolean;
}
