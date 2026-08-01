/**
 * Welcome block shown above the composer on an empty (brand-new) thread.
 *
 * Two pieces:
 *  - A centered title ("在「项目名」中开始新的会话") + one-line subtitle.
 *  - A row of fixed development-task suggestion chips. Clicking a chip fills
 *    the composer with its prompt (NOT sending) so the user can review/edit
 *    before hitting Enter. `disabled` aligns the chips with the composer's
 *    lock state (approvals / pending questions).
 *
 * Kept in its own file so ChatPane's composer area doesn't grow further —
 * the empty state is only about guidance, it has no git/state logic of its
 * own (that lives in ProjectBranchIndicator, rendered above this block).
 */
import { cn } from "@renderer/lib/cn.js";
import { IconBook, IconFlask, IconGitBranch, IconSearch, IconEdit } from "@renderer/lib/icons.js";
import type { TablerIcon } from "@tabler/icons-react";

export interface EmptyThreadWelcomeProps {
  /** Project display name; empty string degrades the title to "开始新的会话". */
  projectName: string;
  /** Whether the chips are clickable. Mirrors the composer lock state. */
  disabled: boolean;
  /** Clicking a suggestion chip → fill the composer with this prompt. */
  onPickPrompt: (prompt: string) => void;
}

/** Fixed development-task starters. Project-agnostic by design — no probing
 *  of the project's content, so they're always useful and always stable. */
const SUGGESTIONS: { icon: TablerIcon; label: string; prompt: string }[] = [
  { icon: IconBook, label: "解释项目", prompt: "解释这个项目的结构和主要功能。" },
  { icon: IconFlask, label: "写单元测试", prompt: "为项目编写单元测试。" },
  { icon: IconGitBranch, label: "审查最近改动", prompt: "审查最近的 git 改动,找出潜在问题。" },
  { icon: IconSearch, label: "查找修复 bug", prompt: "帮我定位并修复项目中的 bug。" },
  { icon: IconEdit, label: "重构代码", prompt: "重构代码,提高可读性和可维护性。" },
];

export function EmptyThreadWelcome({ projectName, disabled, onPickPrompt }: EmptyThreadWelcomeProps) {
  return (
    <div className="mb-4 flex flex-col items-center gap-3">
      <div className="text-center">
        <h2 className="text-base font-semibold text-content">
          {projectName ? `在「${projectName}」中开始新的会话` : "开始新的会话"}
        </h2>
        <p className="mt-1 text-[13px] text-content-muted">向 Claude 提问,或点击下方快捷任务开始</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={disabled}
            onClick={() => onPickPrompt(s.prompt)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface px-3 py-1.5 text-[12px] text-content-muted transition-colors",
              "hover:border-accent/50 hover:bg-accent/10 hover:text-content disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <s.icon size={13} className="shrink-0 opacity-80" />
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
