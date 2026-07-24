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
  session: {
    messages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_MESSAGES, input)) as RpcMap["session.messages"],
    saveMessages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_SAVE_MESSAGES, input)) as RpcMap["session.saveMessages"],
  },
  setting: {
    get: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_GET, input)) as RpcMap["setting.get"],
    set: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_SET, input)) as RpcMap["setting.set"],
  },

  // ── Main-only helpers (not part of the provider/session RPC map) ──
  /** Open a native folder picker; returns the chosen path or null. */
  pickFolder: (): Promise<{ path: string | null }> =>
    ipcRenderer.invoke("dialog:pickFolder"),
  /** Open a native file picker (for configuring the claude CLI path). */
  pickFile: (() => ipcRenderer.invoke(IPC.DIALOG_PICK_FILE)) as RpcMap["dialog.pickFile"],
  /** Probe a candidate claude path by running `claude --version`. */
  testClaudePath: ((input: { path: string }) =>
    ipcRenderer.invoke(IPC.CLAUDE_TEST_PATH, input)) as RpcMap["claude.testPath"],
  /** Probe whether claude CLI is installed and resolvable. */
  claudeHealthCheck: (): Promise<{
    installed: boolean;
    source: string | null;
    command: string | null;
  }> => ipcRenderer.invoke("claude:healthCheck"),

  // ── Push events (main → renderer) ──
  on: {
    /** Subscribe to a main→renderer push channel. Returns an unsubscribe fn. */
    claudeEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "claude:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.CLAUDE_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.CLAUDE_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.CLAUDE_EVENT, listener);
      };
    },
    terminalData(handler: (msg: Extract<MainToRendererMessage, { channel: "terminal:data" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.TERMINAL_DATA) handler(msg);
      };
      ipcRenderer.on(IPC.TERMINAL_DATA, listener);
      return () => {
        ipcRenderer.off(IPC.TERMINAL_DATA, listener);
      };
    },
  },
} as const;

contextBridge.exposeInMainWorld("api", api);

// Type declaration so the renderer sees `window.api`.
export type Api = typeof api;
