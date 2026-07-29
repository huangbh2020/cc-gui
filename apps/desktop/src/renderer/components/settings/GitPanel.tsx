import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { SettingRow } from "./SettingRow.js";

/**
 * Git settings — commit-message generation configuration.
 *
 * Two controls:
 *  - **Model**: pick which custom-model config (from the 模型配置 page) to use
 *    for generating commit messages, or "内置模型" for the default.
 *  - **Prompt**: a textarea for the user's custom prompt template. The staged
 *    git diff is appended after this text. Empty = built-in default.
 *
 * Both are persisted via the settings table and read by the main-process
 * `git.generateCommitMessage` handler.
 */
export function GitPanel() {
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);
  const setCommitGenModel = useSessionStore((s) => s.setCommitGenModel);
  const setCommitGenPrompt = useSessionStore((s) => s.setCommitGenPrompt);
  const customModels = useSessionStore((s) => s.customModels);

  return (
    <div className="divide-y divide-edge">
      <div className="pb-3">
        <h2 className="text-sm font-semibold text-content">Git 提交记录生成</h2>
        <p className="mt-0.5 text-[11px] text-content-subtle">
          配置用于自动生成提交信息的模型和提示词。在 Git 面板的提交框点击「生成」按钮即可使用。
        </p>
      </div>

      {/* Model selector */}
      <SettingRow
        title="生成模型"
        desc="选择用于生成提交信息的模型配置。选择「内置模型」使用系统默认。"
      >
        <select
          value={commitGenModel ?? ""}
          onChange={(e) => setCommitGenModel(e.target.value || null)}
          className={cn(
            "min-w-[180px] rounded-md border border-edge-input bg-surface px-2 py-1.5 text-xs text-content outline-none",
            "focus:border-accent",
          )}
        >
          <option value="">内置模型</option>
          {customModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </SettingRow>

      {/* Prompt template */}
      <SettingRow
        title="提示词模板"
        desc="生成提交信息时使用的提示词。已暂存的 git diff 会附加在提示词之后。留空则使用内置默认提示词。"
      >
        <textarea
          value={commitGenPrompt}
          onChange={(e) => setCommitGenPrompt(e.target.value)}
          placeholder="例如:请根据以下 diff 生成一条符合 Conventional Commits 规范的中文提交信息…"
          rows={5}
          className={cn(
            "w-full max-w-[400px] resize-y rounded-md border border-edge-input bg-surface px-2.5 py-1.5 text-xs leading-relaxed text-content outline-none",
            "focus:border-accent",
          )}
        />
      </SettingRow>
    </div>
  );
}
