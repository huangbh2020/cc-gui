/**
 * IPC contract — validated messages crossing the Electron main↔renderer boundary.
 * Every channel is whitelisted in the preload and validated with zod before
 * the main process acts on it. This is the security boundary.
 */
import { z } from "zod";
import type { RuntimeEvent } from "./runtime.js";
import type { Project, Session, TurnInput, ApprovalDecision } from "./session.js";

/* ──────────────────────────  Renderer → Main (RPC)  ────────────────────────── */

export const StartSessionSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  model: z.string().optional(),
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
  "claude.sendTurn": (input: SendTurnInput) => Promise<void>;
  "claude.interrupt": (input: InterruptInput) => Promise<void>;
  "claude.approve": (input: ApproveInput) => Promise<void>;
  // Projects
  "project.create": (input: CreateProjectInput) => Promise<{ project: Project }>;
  "project.list": () => Promise<{ projects: Project[] }>;
  "project.sessions": (projectId: string) => Promise<{ sessions: Session[] }>;
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
  // send/on (push events)
  CLAUDE_EVENT: "claude:event",
  TERMINAL_DATA: "terminal:data",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
