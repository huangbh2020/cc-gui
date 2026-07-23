import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@contracts/ipc";
import type { RpcMap } from "@contracts/ipc";
import type { MainToRendererMessage } from "@contracts/ipc";

/**
 * The typed API exposed to the renderer via contextBridge.
 * This is the ONLY bridge into Node — the renderer cannot require() anything.
 */
const api = {
  // ── RPC (renderer → main) ──
  claude: {
    startSession: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_START_SESSION, input)) as RpcMap["claude.startSession"],
    sendTurn: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_SEND_TURN, input)) as RpcMap["claude.sendTurn"],
    interrupt: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_INTERRUPT, input)) as RpcMap["claude.interrupt"],
    approve: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_APPROVE, input)) as RpcMap["claude.approve"],
  },
  project: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_CREATE, input)) as RpcMap["project.create"],
    list: (() => ipcRenderer.invoke(IPC.PROJECT_LIST)) as RpcMap["project.list"],
    sessions: ((projectId) =>
      ipcRenderer.invoke(IPC.PROJECT_SESSIONS, projectId)) as RpcMap["project.sessions"],
  },

  // ── Push events (main → renderer) ──
  on: {
    /** Subscribe to a main→renderer push channel. Returns an unsubscribe fn. */
    claudeEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "claude:event" }>) => void) {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.CLAUDE_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.CLAUDE_EVENT, listener);
      return () => ipcRenderer.off(IPC.CLAUDE_EVENT, listener);
    },
    terminalData(handler: (msg: Extract<MainToRendererMessage, { channel: "terminal:data" }>) => void) {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.TERMINAL_DATA) handler(msg);
      };
      ipcRenderer.on(IPC.TERMINAL_DATA, listener);
      return () => ipcRenderer.off(IPC.TERMINAL_DATA, listener);
    },
  },
} as const;

contextBridge.exposeInMainWorld("api", api);

// Type declaration so the renderer sees `window.api`.
export type Api = typeof api;
