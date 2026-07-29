/**
 * Command registry for the Cmd/Ctrl+K command palette.
 *
 * Each command is a self-contained definition: a label the user searches for,
 * a group for visual clustering, an icon, optional keywords, and a `perform`
 * that runs against the live store (fetched via `useSessionStore.getState()`
 * at click time — NOT captured at definition time, so the array itself can be
 * a module-level constant for the static commands).
 *
 * Dynamic commands (e.g. "switch to session X") are produced by
 * `collectCommands()`, which merges the static list with per-store-state
 * items. The palette component calls this on every render of an open palette.
 */
import type { ComponentType } from "react";
import type { SessionState } from "@renderer/stores/sessionStore.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";
import { api } from "@renderer/lib/api.js";
import {
  IconPlus,
  IconMessage,
  IconColumns3,
  IconList,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightExpand,
  IconTerminal2,
  IconFolder,
  IconGitBranch,
  IconSettings,
  IconSun,
  IconMoon,
} from "@renderer/lib/icons.js";

/** Visual grouping label shown as a section header in the palette. */
export const COMMAND_GROUPS = [
  "会话",
  "视图",
  "布局",
  "外观",
] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface CommandDef {
  /** Stable id for keying / dedup. */
  id: string;
  /** Display label — also the primary search target. */
  label: string;
  group: CommandGroup;
  /** Extra lowercase keywords matched by the filter (alongside the label). */
  keywords?: string[];
  /** Leading icon. */
  icon?: ComponentType<TablerIconProps>;
  /** Hint shown on the right (purely display, e.g. "⌘K"). */
  shortcutHint?: string;
  /** Run the command. Called with the live store so actions are fresh. */
  perform: (s: SessionState) => void | Promise<void>;
  /** Return false to hide the command for the current state. */
  available?: (s: SessionState) => boolean;
}

/* ───────────────────── static commands ───────────────────── */

const STATIC_COMMANDS: CommandDef[] = [
  // ── 会话 ──
  {
    id: "session.new",
    label: "新建会话",
    group: "会话",
    keywords: ["new", "session", "chat", "thread", "新建", "对话"],
    icon: IconPlus,
    perform: (s) => {
      void s.startSession();
    },
    available: (s) => s.activeProjectId !== null,
  },

  // ── 视图 ──
  {
    id: "view.display-mode.single",
    label: "显示模式：单会话",
    group: "视图",
    keywords: ["single", "display", "mode", "单", "模式"],
    icon: IconMessage,
    perform: (s) => {
      void s.setDisplayMode("single");
    },
    available: (s) => s.displayMode !== "single",
  },
  {
    id: "view.display-mode.tabs",
    label: "显示模式：标签页",
    group: "视图",
    keywords: ["tabs", "display", "mode", "标签", "多开", "模式"],
    icon: IconColumns3,
    perform: (s) => {
      void s.setDisplayMode("tabs");
    },
    available: (s) => s.displayMode !== "tabs",
  },
  {
    id: "view.right-panel.files",
    label: "右栏：文件",
    group: "视图",
    keywords: ["files", "right", "panel", "文件", "右栏"],
    icon: IconFolder,
    perform: (s) => {
      s.setRightPanelTab("files");
      s.setRightOpen(true);
    },
  },
  {
    id: "view.right-panel.git",
    label: "右栏：Git",
    group: "视图",
    keywords: ["git", "right", "panel", "右栏"],
    icon: IconGitBranch,
    perform: (s) => {
      s.setRightPanelTab("git");
      s.setRightOpen(true);
    },
  },
  {
    id: "view.settings",
    label: "打开设置",
    group: "视图",
    keywords: ["settings", "preferences", "设置", "偏好"],
    icon: IconSettings,
    shortcutHint: "⌘,",
    perform: (s) => {
      s.setSettingsOpen(true);
    },
  },

  // ── 布局 ──
  {
    id: "layout.toggle-left",
    label: "切换左侧栏",
    group: "布局",
    keywords: ["left", "sidebar", "toggle", "左侧", "侧栏"],
    icon: IconLayoutSidebarLeftExpand,
    perform: (s) => {
      s.setLeftOpen(!s.leftOpen);
    },
  },
  {
    id: "layout.toggle-right",
    label: "切换右侧栏",
    group: "布局",
    keywords: ["right", "sidebar", "panel", "toggle", "右侧", "右栏"],
    icon: IconLayoutSidebarRightExpand,
    perform: (s) => {
      s.setRightOpen(!s.rightOpen);
    },
  },
  {
    id: "layout.toggle-bottom-terminal",
    label: "切换底部终端",
    group: "布局",
    keywords: ["terminal", "bottom", "toggle", "终端", "底部"],
    icon: IconTerminal2,
    perform: (s) => {
      s.setBottomTerminalOpen(!s.bottomTerminalOpen);
    },
  },

  // ── 外观 ──
  {
    id: "appearance.theme.light",
    label: "主题：浅色",
    group: "外观",
    keywords: ["theme", "light", "主题", "浅色", "亮色"],
    icon: IconSun,
    perform: () => {
      void api.theme.set({ theme: "light" });
    },
  },
  {
    id: "appearance.theme.dark",
    label: "主题：深色",
    group: "外观",
    keywords: ["theme", "dark", "主题", "深色", "暗色"],
    icon: IconMoon,
    perform: () => {
      void api.theme.set({ theme: "dark" });
    },
  },
];

/* ───────────────────── dynamic commands ───────────────────── */

/** Build the full command list for the current store state.
 *
 *  Merges the static commands with dynamic "switch to session X" entries
 *  (one per session in the active project's loaded page). `s` is the live
 *  store snapshot — the palette passes `useSessionStore.getState()` so
 *  `perform` runs against fresh actions. */
export function collectCommands(s: SessionState): CommandDef[] {
  const cmds = STATIC_COMMANDS.filter((c) => !c.available || c.available(s));

  // Dynamic: "switch to session" — one per session in the active project's
  // currently-loaded page. Rendered under the 会话 group so the user can
  // fuzzy-jump to any open thread.
  const pid = s.activeProjectId;
  const sessions = pid ? s.sessionsByProject[pid] ?? [] : [];
  for (const sess of sessions) {
    const title = sess.title?.trim() || "无标题会话";
    cmds.push({
      id: `session.switch.${sess.id}`,
      label: `切换到会话：${title}`,
      group: "会话",
      keywords: ["switch", "session", "open", "tab", "切换", "跳转", title],
      icon: IconList,
      perform: (store) => {
        void store.openTab(sess.id);
      },
    });
  }

  return cmds;
}

/** Case-insensitive substring match against a command's label + keywords.
 *  An empty query matches everything. */
export function commandMatches(cmd: CommandDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (cmd.label.toLowerCase().includes(q)) return true;
  return (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(q));
}
