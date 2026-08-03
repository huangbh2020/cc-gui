/**
 * Empty-thread welcome, split into two pieces rendered on opposite sides of
 * the composer:
 *  - EmptyThreadWelcome: the centered title + subtitle (above the input box).
 *  - SuggestionCards: the responsive grid of development-task starter cards
 *    (below the input box). Clicking a card fills the composer with its
 *    prompt (NOT sending) so the user can review/edit before hitting Enter.
 *
 * Splitting around the composer keeps the input box as the visual focus of
 * the home screen — the title invites, the cards offer starting points, and
 * the input sits between them as the primary action surface. `disabled`
 * mirrors the composer's lock state (approvals / pending questions).
 *
 * A light fade-up plays once on mount on each piece (see `home-fade-up` in
 * styles.css); disabled under prefers-reduced-motion.
 */
import { cn } from "@renderer/lib/cn.js";
import {
  IconBook,
  IconFlask,
  IconGitBranch,
  IconSearch,
  IconEdit,
} from "@renderer/lib/icons.js";
import type { TablerIcon } from "@tabler/icons-react";

export interface EmptyThreadWelcomeProps {
  /** Project display name; empty string degrades the title to "开始新的会话". */
  projectName: string;
}

export interface SuggestionCardsProps {
  /** Whether the cards are clickable. Mirrors the composer lock state. */
  disabled: boolean;
  /** Clicking a suggestion card → fill the composer with this prompt. */
  onPickPrompt: (prompt: string) => void;
}

/** Fixed development-task starters. Project-agnostic by design — no probing
 *  of the project's content, so they're always useful and always stable.
 *  Each carries a short description so the card has more presence than the
 *  old bare chip and reads as a capability entry, not a toolbar button. */
const SUGGESTIONS: { icon: TablerIcon; label: string; desc: string; prompt: string }[] = [
  { icon: IconBook, label: "解释项目", desc: "快速了解项目结构与职责", prompt: "解释这个项目的结构和主要功能。" },
  { icon: IconFlask, label: "写单元测试", desc: "为核心模块补齐测试", prompt: "为项目编写单元测试。" },
  { icon: IconGitBranch, label: "审查最近改动", desc: "检查 git 改动中的隐患", prompt: "审查最近的 git 改动,找出潜在问题。" },
  { icon: IconSearch, label: "查找修复 Bug", desc: "定位并修复问题", prompt: "帮我定位并修复项目中的 bug。" },
  { icon: IconEdit, label: "重构代码", desc: "提升可读性与可维护性", prompt: "重构代码,提高可读性和可维护性。" },
];

export function EmptyThreadWelcome({ projectName }: EmptyThreadWelcomeProps) {
  return (
    <div className="mb-4 flex animate-[home-fade-up_160ms_ease-out] justify-center">
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-content">
          {projectName ? `在「${projectName}」中开始新的会话` : "开始新的会话"}
        </h2>
        <p className="text-sm text-content-muted">
          向 Claude 提问,或从下方选择一个任务开始
        </p>
      </div>
    </div>
  );
}

export function SuggestionCards({ disabled, onPickPrompt }: SuggestionCardsProps) {
  return (
    <div className="mt-4 grid w-full animate-[home-fade-up_160ms_ease-out] grid-cols-2 gap-2.5 md:grid-cols-5">
      {SUGGESTIONS.map((s) => (
        <button
          key={s.label}
          type="button"
          disabled={disabled}
          onClick={() => onPickPrompt(s.prompt)}
          className={cn(
            "group flex flex-col items-start gap-2 rounded-xl border border-edge bg-surface-muted/40 p-3 text-left transition-all",
            "hover:-translate-y-0.5 hover:border-accent/40 hover:bg-accent/5",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-edge disabled:hover:bg-surface-muted/40",
          )}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <s.icon size={16} />
          </span>
          <span className="text-[13px] font-medium text-content">{s.label}</span>
          <span className="text-[11px] leading-snug text-content-subtle">{s.desc}</span>
        </button>
      ))}
    </div>
  );
}
