import { create } from "zustand";
import type { Project, Session } from "@contracts/session";
import type { RuntimeEvent } from "@contracts/runtime";
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

interface SessionState {
  projects: Project[];
  activeProjectId: string | null;
  sessions: Session[];
  activeSessionId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  isRunning: boolean;
  claudeInstalled: boolean | null;

  // actions
  init: () => Promise<void>;
  addProjectFromFolder: () => Promise<string | null>;
  startSession: () => Promise<void>;
  sendPrompt: (prompt: string) => Promise<void>;
  interrupt: () => Promise<void>;
  ingestEvent: (e: RuntimeEvent) => void;
}

/** Map of messageId → { sessionKey, msg } for fast delta accumulation. */
function findMsg(list: ChatMessage[], messageId: string): ChatMessage | undefined {
  return list.find((m) => m.id === messageId);
}

export const useSessionStore = create<SessionState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  isRunning: false,
  claudeInstalled: null,

  init: async () => {
    const health = await api.claudeHealthCheck();
    set({ claudeInstalled: health.installed });
    const { projects } = await api.project.list();
    set({ projects });
    if (projects.length > 0) {
      set({ activeProjectId: projects[0].id });
      const { sessions } = await api.project.sessions(projects[0].id);
      set({ sessions });
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
      permissionMode: "default",
    });
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: session.id,
      messagesBySession: { ...s.messagesBySession, [session.id]: [] },
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

    // 2. fire the turn; events stream back via ingestEvent
    await api.claude.sendTurn({ sessionId, prompt });
  },

  interrupt: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await api.claude.interrupt({ sessionId });
    set({ isRunning: false });
  },

  ingestEvent: (e) => {
    const sid = e.sessionId;
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
          set({ isRunning: false });
          break;
        }
        default:
          break;
      }

      return { messagesBySession: { ...s.messagesBySession, [sid]: next } };
    });
  },
}));
