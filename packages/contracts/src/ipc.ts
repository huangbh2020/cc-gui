/**
 * IPC contract — validated messages crossing the Electron main↔renderer boundary.
 * Every channel is whitelisted in the preload and validated with zod before
 * the main process acts on it. This is the security boundary.
 */
import { z } from "zod";
import type { RuntimeEvent } from "./runtime.js";
import type { Project, Session, MessageRecord, TurnInput, ApprovalDecision } from "./session.js";

/**
 * Setting key under which the user's configured claude CLI path is persisted
 * (in the `settings` table). Shared between main (resolver/handler) and
 * renderer (settings modal) so the string never drifts.
 */
export const CLAUDE_PATH_SETTING_KEY = "claudePath";

/* ──────────────────────────  Renderer → Main (RPC)  ────────────────────────── */

export const StartSessionSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).default("default"),
  permissionMode: z.enum(["default", "plan", "acceptEdits"]).default("default"),
});
export type StartSessionInput = z.infer<typeof StartSessionSchema>;

export const SendTurnSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  attachments: z.array(z.string()).optional(),
});
export type SendTurnInput = z.infer<typeof SendTurnSchema>;

export const InterruptSchema = z.object({ sessionId: z.string() });
export type InterruptInput = z.infer<typeof InterruptSchema>;

export const ApproveSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  granted: z.boolean(),
  always: z.boolean().optional(),
});
export type ApproveInput = z.infer<typeof ApproveSchema>;

export const CreateProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

/* A persisted message: content is opaque JSON (text/thinking/tool_use blocks).
 * P2's renderer serializes its ChatMessage.blocks array here.
 * We use z.custom<unknown>() for content: zod treats z.unknown()/z.any() as
 * optional in its inferred type, which would mismatch MessageRecord.content
 * (required `unknown`). z.custom() preserves the exact type we give it. */
export const MessageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.custom<unknown>((v) => v !== undefined, "content is required"),
  createdAt: z.number(),
});

export const SessionMessagesSchema = z.object({ sessionId: z.string() });
export type SessionMessagesInput = z.infer<typeof SessionMessagesSchema>;

export const SaveMessagesSchema = z.object({
  sessionId: z.string(),
  /** Full message snapshot for the session — replaces whatever is stored. */
  messages: z.array(MessageRecordSchema),
});
/**
 * We type `messages` against the domain MessageRecord rather than z.infer,
 * because zod renders z.unknown()/z.any() content as optional, which would
 * mismatch MessageRecord.content (required). The schema still validates shape
 * at runtime; the type is asserted to match the domain model.
 */
export type SaveMessagesInput = { sessionId: string; messages: MessageRecord[] };

/* ── Settings & claude path config ── */
export const GetSettingSchema = z.object({ key: z.string() });
export type GetSettingInput = z.infer<typeof GetSettingSchema>;

export const SetSettingSchema = z.object({ key: z.string(), value: z.string() });
export type SetSettingInput = z.infer<typeof SetSettingSchema>;

export const TestClaudePathSchema = z.object({ path: z.string() });
export type TestClaudePathInput = z.infer<typeof TestClaudePathSchema>;

/** Result of probing a configured claude path by running `claude --version`. */
export interface TestClaudePathResult {
  ok: boolean;
  /** claude's version string on success. */
  version?: string;
  /** Error message on failure (not found / non-zero exit / timeout). */
  error?: string;
}

/* ──────────────────────────  Main → Renderer (events)  ─────────────────────── */

export interface ClaudeEventMessage {
  channel: "claude:event";
  sessionId: string;
  event: RuntimeEvent;
}

export interface TerminalDataMessage {
  channel: "terminal:data";
  terminalId: string;
  data: string;
}

export type MainToRendererMessage = ClaudeEventMessage | TerminalDataMessage;

/* ──────────────────────────  RPC method map  ───────────────────────────────── */

/** A typed map of all renderer→main RPC invocations. The preload exposes a
 * typed `window.api` matching this shape; the renderer imports it for safety. */
export interface RpcMap {
  // Claude
  "claude.startSession": (input: StartSessionInput) => Promise<{ session: Session }>;
  /** Returns the (possibly retitled) session so the renderer can refresh. */
  "claude.sendTurn": (input: SendTurnInput) => Promise<{ session: Session }>;
  "claude.interrupt": (input: InterruptInput) => Promise<void>;
  "claude.approve": (input: ApproveInput) => Promise<void>;
  // Projects
  "project.create": (input: CreateProjectInput) => Promise<{ project: Project }>;
  "project.list": () => Promise<{ projects: Project[] }>;
  "project.sessions": (projectId: string) => Promise<{ sessions: Session[] }>;
  // Sessions (P2 persistence)
  "session.messages": (input: SessionMessagesInput) => Promise<{ messages: MessageRecord[] }>;
  "session.saveMessages": (input: SaveMessagesInput) => Promise<void>;
  // Settings & claude path
  "setting.get": (input: GetSettingInput) => Promise<{ value: string | null }>;
  "setting.set": (input: SetSettingInput) => Promise<void>;
  "claude.testPath": (input: TestClaudePathInput) => Promise<TestClaudePathResult>;
  "dialog.pickFile": () => Promise<{ path: string | null }>;
}

/** The channel names used in invoke/handle and send/on. Keep these centralized
 * so the preload allowlist and the main handlers never drift. */
export const IPC = {
  // invoke/handle (RPC)
  CLAUDE_START_SESSION: "claude:startSession",
  CLAUDE_SEND_TURN: "claude:sendTurn",
  CLAUDE_INTERRUPT: "claude:interrupt",
  CLAUDE_APPROVE: "claude:approve",
  PROJECT_CREATE: "project:create",
  PROJECT_LIST: "project:list",
  PROJECT_SESSIONS: "project:sessions",
  SESSION_MESSAGES: "session:messages",
  SESSION_SAVE_MESSAGES: "session:saveMessages",
  // Settings & claude path config
  SETTING_GET: "setting:get",
  SETTING_SET: "setting:set",
  CLAUDE_TEST_PATH: "claude:testPath",
  DIALOG_PICK_FILE: "dialog:pickFile",
  // send/on (push events)
  CLAUDE_EVENT: "claude:event",
  TERMINAL_DATA: "terminal:data",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
