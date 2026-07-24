import { create } from "zustand";
import type { Project, Session, MessageRecord } from "@contracts/session";
import type { RuntimeEvent, PermissionMode, EffortLevel, AskUserQuestionItem } from "@contracts/runtime";
import { api } from "@renderer/lib/api.js";

/** A single content block within a message (mirrors how claude structures output). */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; toolName: string; input: unknown; status: "running" | "done" | "error"; result?: unknown }
  | { kind: "error"; message: string };

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  blocks: Block[];
  createdAt: number;
}

/** A single todo item from claude's TodoWrite tool. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/** Per-turn token usage, approximates context occupancy for display. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  model?: string;
}

interface SessionState {
  projects: Project[];
  activeProjectId: string | null;
  sessions: Session[];
  activeSessionId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  isRunning: boolean;
  claudeInstalled: boolean | null;
  /** Settings modal visibility (controlled from TopBar ⚙ and CLI-missing CTA). */
  settingsOpen: boolean;
  /** Permission mode for the next session started (default / plan / acceptEdits).
   * Wired into startSession's permissionMode → claude's --permission-mode flag. */
  permissionMode: PermissionMode;
  /** Model for the next session ("default" = let claude pick). → --model. */
  model: string;
  /** Effort for the next session ("default" = don't pass --effort). → --effort. */
  effort: EffortLevel;
  /** Latest task list per session (from claude's TodoWrite; null = none yet). */
  todosBySession: Record<string, TodoItem[]>;
  /** Latest per-turn usage per session (approx context occupancy for display). */
  usageBySession: Record<string, SessionUsage>;
  /** A pending AskUserQuestion from claude, awaiting the user's answer. Rendered
   * as a prompt above the composer. null when none is open. */
  pendingQuestion: { sessionId: string; questions: AskUserQuestionItem[] } | null;

  // actions
  init: () => Promise<void>;
  addProjectFromFolder: () => Promise<string | null>;
  startSession: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  sendPrompt: (prompt: string) => Promise<void>;
  interrupt: () => Promise<void>;
  ingestEvent: (e: RuntimeEvent) => void;
  setSettingsOpen: (open: boolean) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setModel: (model: string) => void;
  setEffort: (effort: EffortLevel) => void;
  /** Clear the pending question (after answering or dismissing). */
  dismissQuestion: () => void;
  /** Re-probe claude availability; call after the user changes the CLI path. */
  refreshClaudeHealth: () => Promise<void>;
}

/** Map of messageId → { sessionKey, msg } for fast delta accumulation. */
function findMsg(list: ChatMessage[], messageId: string): ChatMessage | undefined {
  return list.find((m) => m.id === messageId);
}

/* ─── P2 persistence: ChatMessage ↔ MessageRecord ───
 * The DB stores `content` as JSON. We put the whole `blocks` array there, so
 * reloading a session round-trips the exact blocks the renderer built — the
 * MessageBlocks renderer already understands Block[]. */

/** Convert the renderer's live messages into the persisted shape. */
function toRecords(sessionId: string, messages: ChatMessage[]): MessageRecord[] {
  return messages.map((m) => ({
    id: m.id,
    sessionId,
    role: m.role,
    content: m.blocks,
    createdAt: m.createdAt,
  }));
}

/** Rehydrate persisted records back into the renderer's live message shape. */
function fromRecords(records: MessageRecord[]): ChatMessage[] {
  return records.map((r) => {
    const blocks = Array.isArray(r.content) ? (r.content as Block[]) : [];
    return {
      id: r.id,
      sessionId: r.sessionId,
      // "system" isn't a chat role — render it as assistant to stay type-safe.
      role: r.role === "user" ? "user" : "assistant",
      blocks,
      createdAt: r.createdAt,
    };
  });
}

/** Stable empty arrays so selectors never return a fresh [] (Zustand Object.is). */
const EMPTY_TODOS: TodoItem[] = [];

export const useSessionStore = create<SessionState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  todosBySession: {},
  usageBySession: {},
  pendingQuestion: null,
  isRunning: false,
  claudeInstalled: null,
  settingsOpen: false,
  permissionMode: "default",
  model: "default",
  effort: "default",

  init: async () => {
    const health = await api.claudeHealthCheck();
    set({ claudeInstalled: health.installed });
    const { projects } = await api.project.list();
    set({ projects });
    if (projects.length > 0) {
      const projectId = projects[0].id;
      set({ activeProjectId: projectId });
      const { sessions } = await api.project.sessions(projectId);
      set({ sessions });
      // Reactivate the most recent session so the user lands on their last
      // conversation (sessions come back newest-first from the repo).
      if (sessions.length > 0) {
        await get().selectSession(sessions[0].id);
      }
    }
  },

  addProjectFromFolder: async () => {
    const { path } = await api.pickFolder();
    if (!path) return null;
    const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
    const { project } = await api.project.create({ name, path });
    set((s) => ({
      projects: [...s.projects, project],
      activeProjectId: project.id,
      sessions: [],
      activeSessionId: null,
    }));
    return project.id;
  },

  startSession: async () => {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const { session } = await api.claude.startSession({
      projectId,
      model: get().model !== "default" ? get().model : undefined,
      effort: get().effort,
      permissionMode: get().permissionMode,
    });
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: session.id,
      messagesBySession: { ...s.messagesBySession, [session.id]: [] },
    }));
  },

  /** Activate an existing session and load its persisted history. */
  selectSession: async (sessionId) => {
    set({ activeSessionId: sessionId });
    // Skip the round-trip if we already hold this session's messages in memory.
    if (get().messagesBySession[sessionId]) return;
    const { messages } = await api.session.messages({ sessionId });
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: fromRecords(messages) },
    }));
  },

  sendPrompt: async (prompt) => {
    const sessionId = get().activeSessionId;
    if (!sessionId || !prompt.trim() || get().isRunning) return;

    // 1. immediately show the user's message
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks: [{ kind: "text", text: prompt }],
      createdAt: Date.now(),
    };
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg],
      },
      isRunning: true,
    }));

    // 2. fire the turn; events stream back via ingestEvent. The handler may
    //    retitle the session (first-message summary), so refresh the list.
    const { session: updated } = await api.claude.sendTurn({ sessionId, prompt });
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId ? updated : x)),
    }));
  },

  interrupt: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await api.claude.interrupt({ sessionId });
    set({ isRunning: false });
  },

  ingestEvent: (e) => {
    const sid = e.sessionId;

    // todo.update and usage are independent state slices (not part of the
    // message stream) — handle them with a dedicated set and skip the
    // message-accumulation logic below.
    if (e.type === "todo.update") {
      set((s) => ({ todosBySession: { ...s.todosBySession, [sid]: e.todos } }));
      return;
    }
    if (e.type === "usage") {
      set((s) => ({
        usageBySession: {
          ...s.usageBySession,
          [sid]: { inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd, model: e.model },
        },
      }));
      return;
    }
    if (e.type === "question.ask") {
      set({ pendingQuestion: { sessionId: sid, questions: e.questions } });
      return;
    }

    set((s) => {
      const list = s.messagesBySession[sid] ?? [];
      let next: ChatMessage[] = list;

      switch (e.type) {
        case "text.delta": {
          // accumulate into the assistant message that owns this messageId,
          // creating it if this is the first delta.
          let msg = findMsg(next, e.messageId);
          if (!msg) {
            msg = { id: e.messageId, sessionId: sid, role: "assistant", blocks: [], createdAt: Date.now() };
            next = [...next, msg];
          }
          const lastBlock = msg.blocks[msg.blocks.length - 1];
          if (lastBlock && lastBlock.kind === "text") {
            // append to the existing text block
            const updatedMsg = { ...msg, blocks: [...msg.blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + e.text }] };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          } else {
            const updatedMsg = { ...msg, blocks: [...msg.blocks, { kind: "text", text: e.text } as Block] };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          }
          break;
        }
        case "thinking": {
          let msg = findMsg(next, e.messageId);
          if (!msg) {
            msg = { id: e.messageId, sessionId: sid, role: "assistant", blocks: [], createdAt: Date.now() };
            next = [...next, msg];
          }
          const lastBlock = msg.blocks[msg.blocks.length - 1];
          if (lastBlock && lastBlock.kind === "thinking") {
            const updatedMsg = { ...msg, blocks: [...msg.blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + e.text }] };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          } else {
            const updatedMsg = { ...msg, blocks: [...msg.blocks, { kind: "thinking", text: e.text } as Block] };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          }
          break;
        }
        case "tool.use": {
          // attach a new tool_use block to the most recent assistant message,
          // or create one if none exists yet.
          let lastAssistant = [...next].reverse().find((m) => m.role === "assistant");
          if (!lastAssistant) {
            lastAssistant = { id: `a_${Date.now()}`, sessionId: sid, role: "assistant", blocks: [], createdAt: Date.now() };
            next = [...next, lastAssistant];
          }
          const block: Block = { kind: "tool_use", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input, status: "running" };
          const updated = { ...lastAssistant, blocks: [...lastAssistant.blocks, block] };
          next = next.map((m) => (m.id === lastAssistant!.id ? updated : m));
          break;
        }
        case "tool.result": {
          // mark the matching tool_use block done/error
          next = next.map((m) => {
            const hasBlock = m.blocks.some((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
            if (!hasBlock) return m;
            return {
              ...m,
              blocks: m.blocks.map((b) =>
                b.kind === "tool_use" && b.toolCallId === e.toolCallId
                  ? { ...b, status: e.isError ? "error" : "done", result: e.content }
                  : b,
              ),
            };
          });
          break;
        }
        case "error": {
          next = [...next, { id: `err_${Date.now()}`, sessionId: sid, role: "assistant", blocks: [{ kind: "error", message: e.message }], createdAt: Date.now() }];
          set({ isRunning: false });
          break;
        }
        case "turn.done": {
          // Close out any tool_use still "running": the turn ended without a
          // matching tool.result, so either the tool wasn't executed (plan
          // mode) or the turn was interrupted. Leaving it spinning forever
          // would mislead — mark it done with a note.
          next = next.map((m) => ({
            ...m,
            blocks: m.blocks.map((b) =>
              b.kind === "tool_use" && b.status === "running"
                ? { ...b, status: "done" as const, result: b.result ?? "(no result — turn ended)" }
                : b,
            ),
          }));
          set({ isRunning: false });
          break;
        }
        default:
          break;
      }

      return { messagesBySession: { ...s.messagesBySession, [sid]: next } };
    });

    // At terminal events the snapshot is final — persist it so the history
    // survives restart. Fire-and-forget; don't block the UI.
    if (e.type === "turn.done" || e.type === "error") {
      const snapshot = get().messagesBySession[sid];
      if (snapshot) {
        void api.session.saveMessages({ sessionId: sid, messages: toRecords(sid, snapshot) });
      }
    }
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setPermissionMode: (mode) => set({ permissionMode: mode }),

  setModel: (model) => set({ model }),
  setEffort: (effort) => set({ effort }),

  dismissQuestion: () => set({ pendingQuestion: null }),

  refreshClaudeHealth: async () => {
    const health = await api.claudeHealthCheck();
    set({ claudeInstalled: health.installed });
  },
}));
