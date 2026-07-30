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
    respondQuestion: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_RESPOND_QUESTION, input)) as RpcMap["claude.respondQuestion"],
    respondPlanApproval: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_RESPOND_PLAN_APPROVAL, input)) as RpcMap["claude.respondPlanApproval"],
    rewindTurn: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_REWIND_TURN, input)) as RpcMap["claude.rewindTurn"],
  },
  project: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_CREATE, input)) as RpcMap["project.create"],
    list: (() => ipcRenderer.invoke(IPC.PROJECT_LIST)) as RpcMap["project.list"],
    sessions: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_SESSIONS, input)) as RpcMap["project.sessions"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_DELETE, input)) as RpcMap["project.delete"],
    archive: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_ARCHIVE, input)) as RpcMap["project.archive"],
  },
  session: {
    messages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_MESSAGES, input)) as RpcMap["session.messages"],
    saveMessages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_SAVE_MESSAGES, input)) as RpcMap["session.saveMessages"],
    updateSettings: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_UPDATE_SETTINGS, input)) as RpcMap["session.updateSettings"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_DELETE, input)) as RpcMap["session.delete"],
    archive: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_ARCHIVE, input)) as RpcMap["session.archive"],
    rename: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_RENAME, input)) as RpcMap["session.rename"],
  },
  setting: {
    get: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_GET, input)) as RpcMap["setting.get"],
    set: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_SET, input)) as RpcMap["setting.set"],
  },

  /** Provider list — returns all registered backends with capabilities. */
  provider: {
    list: (() => ipcRenderer.invoke(IPC.PROVIDER_LIST)) as RpcMap["provider.list"],
  },

  /** Custom-model configs (user-defined Anthropic-compatible endpoints).
   *  Keys are encrypted at rest; the renderer only ever receives a masked form. */
  customModel: {
    list: (() => ipcRenderer.invoke(IPC.CUSTOM_MODEL_LIST)) as RpcMap["customModel.list"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_SAVE, input)) as RpcMap["customModel.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_DELETE, input)) as RpcMap["customModel.delete"],
    test: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_TEST, input)) as RpcMap["customModel.test"],
  },

  /** Color scheme: get/set the preference; theme.changed fires when the
   *  effective theme changes (incl. OS-side changes in 'system' mode). */
  theme: {
    get: (() => ipcRenderer.invoke(IPC.THEME_GET)) as RpcMap["theme.get"],
    set: ((input) =>
      ipcRenderer.invoke(IPC.THEME_SET, input)) as RpcMap["theme.set"],
  },

  /** App + runtime info (version, Electron/Node/Chromium, platform) for the
   *  About panel. Parameterless RPC. */
  app: {
    info: (() => ipcRenderer.invoke(IPC.APP_INFO)) as RpcMap["app.info"],
    /** Check for updates on the GitHub Releases channel. */
    checkForUpdates: (() =>
      ipcRenderer.invoke(IPC.APP_CHECK_FOR_UPDATES)) as RpcMap["app.checkForUpdates"],
    /** Start downloading the pending update (user opted in). */
    downloadUpdate: (() =>
      ipcRenderer.invoke(IPC.APP_DOWNLOAD_UPDATE)) as RpcMap["app.downloadUpdate"],
    /** Quit and install a downloaded update. */
    quitAndInstall: (() =>
      ipcRenderer.invoke(IPC.APP_QUIT_AND_INSTALL)) as RpcMap["app.quitAndInstall"],
  },

  /** Open a project root in the OS file manager. Main refuses any path that
   *  isn't an exact match for a known project root, so only directories the
   *  user has added as projects can be opened. */
  shell: {
    openPath: ((input) =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, input)) as RpcMap["shell.openPath"],
  },

  /** Filesystem operations for the IDE right panel + diff rendering. Every
   *  path must resolve inside a known project root (main enforces this);
   *  read/list degrade to empty on refusal or failure, write returns ok:false. */
  file: {
    readFile: ((input) =>
      ipcRenderer.invoke(IPC.FILE_READ, input)) as RpcMap["file.readFile"],
    /** List one level of a directory (non-recursive) for the file tree. */
    listDir: ((input) =>
      ipcRenderer.invoke(IPC.FILE_LIST_DIR, input)) as RpcMap["file.listDir"],
    /** Recursive file search under a project root (composer @ / add-context). */
    search: ((input) =>
      ipcRenderer.invoke(IPC.FILE_SEARCH, input)) as RpcMap["file.search"],
    /** Grep file contents under a project root (line-level matches). */
    grep: ((input) =>
      ipcRenderer.invoke(IPC.FILE_GREP, input)) as RpcMap["file.grep"],
    /** Write utf-8 content to a file (creates parent dirs). Returns ok. */
    writeFile: ((input) =>
      ipcRenderer.invoke(IPC.FILE_WRITE, input)) as RpcMap["file.writeFile"],
  },

  /** Git operations for the Git panel. All paths must resolve inside a known
   *  project root (main enforces this). Auth for push/pull is handled by the
   *  system's git configuration (SSH keys, credential helpers). */
  git: {
    discoverRepos: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DISCOVER_REPOS, input)) as RpcMap["git.discoverRepos"],
    status: ((input) =>
      ipcRenderer.invoke(IPC.GIT_STATUS, input)) as RpcMap["git.status"],
    stage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_STAGE, input)) as RpcMap["git.stage"],
    unstage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_UNSTAGE, input)) as RpcMap["git.unstage"],
    commit: ((input) =>
      ipcRenderer.invoke(IPC.GIT_COMMIT, input)) as RpcMap["git.commit"],
    push: ((input) =>
      ipcRenderer.invoke(IPC.GIT_PUSH, input)) as RpcMap["git.push"],
    pull: ((input) =>
      ipcRenderer.invoke(IPC.GIT_PULL, input)) as RpcMap["git.pull"],
    diff: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DIFF, input)) as RpcMap["git.diff"],
    discard: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DISCARD, input)) as RpcMap["git.discard"],
    generateCommitMessage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_GENERATE_COMMIT, input)) as RpcMap["git.generateCommitMessage"],
    resolveConflicts: ((input) =>
      ipcRenderer.invoke(IPC.GIT_RESOLVE_CONFLICTS, input)) as RpcMap["git.resolveConflicts"],
    log: ((input) =>
      ipcRenderer.invoke(IPC.GIT_LOG, input)) as RpcMap["git.log"],
    showCommit: ((input) =>
      ipcRenderer.invoke(IPC.GIT_SHOW_COMMIT, input)) as RpcMap["git.showCommit"],
    showFile: ((input) =>
      ipcRenderer.invoke(IPC.GIT_SHOW_FILE, input)) as RpcMap["git.showFile"],
  },

  /** Integrated terminal (xterm in renderer ↔ node-pty in main). Paths on
   *  create must resolve inside a known project root (main enforces this). */
  terminal: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_CREATE, input)) as RpcMap["terminal.create"],
    write: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_WRITE, input)) as RpcMap["terminal.write"],
    resize: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_RESIZE, input)) as RpcMap["terminal.resize"],
    kill: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_KILL, input)) as RpcMap["terminal.kill"],
    list: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_LIST, input)) as RpcMap["terminal.list"],
  },

  // ── Main-only helpers ──
  /** Open a native folder picker; returns the chosen path or null. */
  pickFolder: (): Promise<{ path: string | null }> =>
    ipcRenderer.invoke("dialog:pickFolder"),

  /** @deprecated Use provider.healthCheck() instead. Kept for SettingsModal backward compat. */
  pickFile: (() => ipcRenderer.invoke(IPC.DIALOG_PICK_FILE)) as RpcMap["dialog.pickFile"],
  /** @deprecated Use provider.healthCheck() instead. Kept for SettingsModal backward compat. */
  testClaudePath: ((input: { path: string }) =>
    ipcRenderer.invoke(IPC.CLAUDE_TEST_PATH, input)) as RpcMap["claude.testPath"],

  /** Probe whether the default provider is functional. */
  claudeHealthCheck: (): Promise<{
    installed: boolean;
    source: string | null;
    command: string | null;
  }> => ipcRenderer.invoke("claude:healthCheck"),

  // ── Push events (main → renderer) ──
  on: {
    /** Subscribe to claude:event push channel. Returns an unsubscribe fn. */
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
    /** Fires when a PTY exits (shell `exit`, crash, or kill). */
    terminalExit(handler: (msg: Extract<MainToRendererMessage, { channel: "terminal:exit" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.TERMINAL_EXIT) handler(msg);
      };
      ipcRenderer.on(IPC.TERMINAL_EXIT, listener);
      return () => {
        ipcRenderer.off(IPC.TERMINAL_EXIT, listener);
      };
    },
    /** Fires when the effective theme changes (user picked one, or OS changed
     *  while in 'system' mode). */
    themeChanged(handler: (msg: Extract<MainToRendererMessage, { channel: "theme:changed" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.THEME_CHANGED) handler(msg);
      };
      ipcRenderer.on(IPC.THEME_CHANGED, listener);
      return () => {
        ipcRenderer.off(IPC.THEME_CHANGED, listener);
      };
    },
    /** Fires when the updater finds a newer version on the release channel.
     *  autoDownload is off, so the renderer should prompt the user to download. */
    updateAvailable(handler: (msg: Extract<MainToRendererMessage, { channel: "update:available" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.UPDATE_AVAILABLE) handler(msg);
      };
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, listener);
      return () => {
        ipcRenderer.off(IPC.UPDATE_AVAILABLE, listener);
      };
    },
    /** Fires when a downloaded update is ready to install. */
    updateDownloaded(handler: (msg: Extract<MainToRendererMessage, { channel: "update:downloaded" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.UPDATE_DOWNLOADED) handler(msg);
      };
      ipcRenderer.on(IPC.UPDATE_DOWNLOADED, listener);
      return () => {
        ipcRenderer.off(IPC.UPDATE_DOWNLOADED, listener);
      };
    },
  },
} as const;

contextBridge.exposeInMainWorld("api", api);

// Type declaration so the renderer sees `window.api`.
export type Api = typeof api;
