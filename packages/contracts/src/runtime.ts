/**
 * Runtime events — the normalized stream of activity emitted by a provider
 * (claude.exe via stream-json). These are the lingua franca the renderer
 * renders; the ClaudeAdapter translates raw NDJSON into these.
 */

/** Permission modes mirror claude's --permission-mode flag. */
export type PermissionMode = "default" | "plan" | "acceptEdits";

/** Lifecycle of a single session. */
export type SessionStatus =
  | "idle"
  | "running"
  | "approving"
  | "done"
  | "errored"
  | "interrupted";

/** A text delta (streaming token) from the assistant. */
export interface TextDeltaEvent {
  type: "text.delta";
  sessionId: string;
  messageId: string;
  text: string;
}

/** A complete assistant message boundary. */
export interface MessageCompleteEvent {
  type: "message.complete";
  sessionId: string;
  messageId: string;
}

/** A thinking/reasoning block (claude extended thinking). */
export interface ThinkingEvent {
  type: "thinking";
  sessionId: string;
  messageId: string;
  text: string;
}

/** A tool was invoked by the agent. */
export interface ToolUseEvent {
  type: "tool.use";
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Raw tool input as JSON (e.g. { command, path, ... }). */
  input: unknown;
  /** True if this tool call requires user approval before executing. */
  requiresApproval: boolean;
}

/** A tool finished and returned a result. */
export interface ToolResultEvent {
  type: "tool.result";
  sessionId: string;
  toolCallId: string;
  /** Whether the tool errored. */
  isError: boolean;
  /** Raw result content (string or structured). */
  content: unknown;
}

/** The agent is requesting permission to run a tool (awaiting user decision). */
export interface ApprovalRequestEvent {
  type: "approval.request";
  sessionId: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Human-readable description of what the tool will do. */
  description?: string;
}

/** A todo/task update (claude's TodoWrite tool output). */
export interface TodoUpdateEvent {
  type: "todo.update";
  sessionId: string;
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority: "high" | "medium" | "low";
  }>;
}

/** Token usage reported at the end of a turn. */
export interface UsageEvent {
  type: "usage";
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  /** Approximate cost in USD, if known. */
  costUsd?: number;
  model?: string;
}

/** Session-level error. */
export interface ErrorEvent {
  type: "error";
  sessionId: string;
  message: string;
  /** Raw error code/string from claude, if any. */
  code?: string;
}

/** The turn has fully completed. */
export type TurnDoneReason = "end_turn" | "max_tokens" | "tool_use" | "interrupted" | "error";
export interface TurnDoneEvent {
  type: "turn.done";
  sessionId: string;
  reason: TurnDoneReason;
}

/** The union of all runtime events. */
export type RuntimeEvent =
  | TextDeltaEvent
  | MessageCompleteEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | TodoUpdateEvent
  | UsageEvent
  | ErrorEvent
  | TurnDoneEvent;
