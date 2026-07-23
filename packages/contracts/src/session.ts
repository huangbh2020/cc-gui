/**
 * Session domain types — projects, sessions, and messages persisted in SQLite.
 */
import type { PermissionMode, SessionStatus } from "./runtime.js";

export interface Project {
  id: string;
  name: string;
  /** Absolute filesystem path that claude will use as cwd. */
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  /** claude's own session id, used for `--resume`. Null until first turn. */
  claudeSessionId: string | null;
  title: string;
  status: SessionStatus;
  model: string;
  permissionMode: PermissionMode;
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
