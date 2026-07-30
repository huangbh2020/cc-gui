/**
 * Composer slash-command registry (Claude Code style).
 *
 * Triggered when the user types `/` at line start or after whitespace in the
 * composer. Commands are either:
 *  - local UI actions (clear draft, switch permission mode, open model picker)
 *  - prompts sent to the agent as the full turn text (e.g. `/compact`)
 *
 * This is intentionally separate from the Cmd/Ctrl+K app command palette
 * (`lib/commands.ts`) and from terminal custom commands.
 */
import type { ComponentType } from "react";
import type { PermissionMode } from "@contracts/runtime";
import type { TablerIconProps } from "@renderer/lib/icons.js";
import {
  IconEraser,
  IconStack2,
  IconCoins,
  IconHelpCircle,
  IconCpu,
  IconShield,
  IconShieldCheck,
  IconShieldLock,
  IconNotebook,
  IconGitBranch,
  IconFileSearch,
  IconRocket,
  IconBulb,
  IconListDetails,
} from "@renderer/lib/icons.js";

export type SlashCommandKind = "local" | "prompt";

export interface SlashCommandContext {
  /** Remove the `/token` from the textarea (or clear it entirely). */
  clearToken: () => void;
  /** Clear composer draft text + tags. */
  clearDraft: () => void;
  /** Send a prompt as a full turn (uses current model/effort/permission). */
  sendPrompt: (prompt: string) => void;
  /** Set the active session's permission mode. */
  setPermissionMode: (mode: PermissionMode) => void;
  /** Best-effort: open/focus the model dropdown if present in DOM. */
  openModelPicker: () => void;
}

export interface SlashCommandDef {
  /** Without leading slash, e.g. "clear". */
  id: string;
  /** Display name with leading slash. */
  name: string;
  description: string;
  keywords?: string[];
  icon?: ComponentType<TablerIconProps>;
  kind: SlashCommandKind;
  /** For kind==="prompt", the exact text to send (defaults to `name`). */
  prompt?: string;
  run?: (ctx: SlashCommandContext) => void;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    id: "clear",
    name: "/clear",
    description: "清空当前输入框与附件草稿",
    keywords: ["reset", "empty", "清空"],
    icon: IconEraser,
    kind: "local",
    run: (ctx) => {
      ctx.clearDraft();
      ctx.clearToken();
    },
  },
  {
    id: "compact",
    name: "/compact",
    description: "请求压缩上下文（发送给 agent）",
    keywords: ["summarize", "context", "压缩"],
    icon: IconStack2,
    kind: "prompt",
  },
  {
    id: "cost",
    name: "/cost",
    description: "查询本会话费用与用量",
    keywords: ["usage", "price", "费用"],
    icon: IconCoins,
    kind: "prompt",
  },
  {
    id: "help",
    name: "/help",
    description: "显示可用斜杠命令帮助",
    keywords: ["?", "commands"],
    icon: IconHelpCircle,
    kind: "prompt",
  },
  {
    id: "model",
    name: "/model",
    description: "打开模型选择",
    keywords: ["llm", "switch"],
    icon: IconCpu,
    kind: "local",
    run: (ctx) => {
      ctx.clearToken();
      ctx.openModelPicker();
    },
  },
  {
    id: "permissions",
    name: "/permissions",
    description: "切回默认权限模式（需审批）",
    keywords: ["default", "approve", "权限"],
    icon: IconShield,
    kind: "local",
    run: (ctx) => {
      ctx.setPermissionMode("default");
      ctx.clearToken();
    },
  },
  {
    id: "accept-edits",
    name: "/accept-edits",
    description: "自动接受文件编辑",
    keywords: ["acceptEdits", "auto"],
    icon: IconShieldCheck,
    kind: "local",
    run: (ctx) => {
      ctx.setPermissionMode("acceptEdits");
      ctx.clearToken();
    },
  },
  {
    id: "plan",
    name: "/plan",
    description: "切换到 Plan 模式",
    keywords: ["plan mode"],
    icon: IconNotebook,
    kind: "local",
    run: (ctx) => {
      ctx.setPermissionMode("plan");
      ctx.clearToken();
    },
  },
  {
    id: "bypass",
    name: "/bypass-permissions",
    description: "绕过权限检查（危险）",
    keywords: ["bypassPermissions", "yolo"],
    icon: IconShieldLock,
    kind: "local",
    run: (ctx) => {
      ctx.setPermissionMode("bypassPermissions");
      ctx.clearToken();
    },
  },
  {
    id: "init",
    name: "/init",
    description: "初始化项目说明（CLAUDE.md 等）",
    keywords: ["setup", "bootstrap"],
    icon: IconRocket,
    kind: "prompt",
  },
  {
    id: "review",
    name: "/review",
    description: "请求代码审查",
    keywords: ["code review"],
    icon: IconFileSearch,
    kind: "prompt",
  },
  {
    id: "memory",
    name: "/memory",
    description: "查看或更新 agent 记忆",
    keywords: ["remember"],
    icon: IconBulb,
    kind: "prompt",
  },
  {
    id: "diff",
    name: "/diff",
    description: "查看当前变更 diff",
    keywords: ["git", "changes"],
    icon: IconGitBranch,
    kind: "prompt",
  },
  {
    id: "todos",
    name: "/todos",
    description: "列出当前任务列表",
    keywords: ["tasks", "todo"],
    icon: IconListDetails,
    kind: "prompt",
  },
];

/** Case-insensitive match on name (without slash) + keywords. Empty query = all. */
export function filterSlashCommands(query: string): SlashCommandDef[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((cmd) => {
    if (cmd.id.includes(q) || cmd.name.toLowerCase().includes(q)) return true;
    if (cmd.description.toLowerCase().includes(q)) return true;
    return (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(q));
  });
}

/** Run a command with the shared context. Prompt-kind commands send via ctx. */
export function executeSlashCommand(
  cmd: SlashCommandDef,
  ctx: SlashCommandContext,
): void {
  if (cmd.kind === "local") {
    cmd.run?.(ctx);
    return;
  }
  const prompt = cmd.prompt ?? cmd.name;
  ctx.clearToken();
  ctx.sendPrompt(prompt);
}
