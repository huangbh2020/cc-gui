import { useMemo } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { SettingRow } from "./SettingRow.js";
import { CUSTOM_MODEL_ROLES, CUSTOM_MODEL_ROLE_LABELS } from "@contracts/customModel";
import type { CustomModelRoleKey } from "@contracts/customModel";

/**
 * Git settings — commit-message generation configuration.
 *
 * Two controls:
 *  - **Model**: pick a SPECIFIC model (supplier + role binding, e.g.
 *    "DeepSeek 中转 → Sonnet"). Only custom-model configs with at least one
 *    bound role are listed; the user must have configured models first.
 *  - **Format preference**: a textarea steering only the language / wording /
 *    convention of the generated message (e.g. Conventional Commits, en/zh,
 *    emoji style). The core behavior — emit a clean, diff-derived commit
 *    message with no preamble — is fixed in the backend and cannot be
 *    overridden here. Empty = built-in default preference.
 *
 * The model value is stored as `"configId:roleKey"` (e.g. `"cfg_abc:sonnet"`)
 * in the settings table; at commit-generation time it's split back into
 * `customModelId` + `customModelRole` for the IPC call.
 */
export function GitPanel() {
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);
  const setCommitGenModel = useSessionStore((s) => s.setCommitGenModel);
  const setCommitGenPrompt = useSessionStore((s) => s.setCommitGenPrompt);
  const customModels = useSessionStore((s) => s.customModels);

  // Build a flat list of selectable models: one entry per (config, bound role).
  // Each entry's value is `"configId:roleKey"`, label is `"供应商名 → 角色名"`.
  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const cfg of customModels) {
      for (const role of CUSTOM_MODEL_ROLES) {
        const binding = cfg.roles[role];
        if (binding?.requestModel?.trim()) {
          const roleLabel = binding.displayName || CUSTOM_MODEL_ROLE_LABELS[role];
          opts.push({
            value: `${cfg.id}:${role}`,
            label: `${cfg.name} → ${roleLabel}`,
          });
        }
      }
    }
    return opts;
  }, [customModels]);

  return (
    <div className="divide-y divide-edge">
      <div className="pb-3">
        <h2 className="text-sm font-semibold text-content">Git 提交记录生成</h2>
        <p className="mt-0.5 text-[11px] text-content-subtle">
          配置用于自动生成提交信息的模型和提示词。在 Git 面板的提交框点击生成图标即可使用。
        </p>
      </div>

      {/* Model selector — specific supplier + role binding */}
      <SettingRow
        title="生成模型"
        desc="选择用于生成提交信息的具体模型。需要先在「模型配置」中添加并绑定角色。"
      >
        {modelOptions.length > 0 ? (
          <select
            value={commitGenModel ?? ""}
            onChange={(e) => setCommitGenModel(e.target.value || null)}
            className={cn(
              "min-w-[220px] rounded-md border border-edge-input bg-surface px-2 py-1.5 text-xs text-content outline-none",
              "focus:border-accent",
            )}
          >
            <option value="">未选择</option>
            {modelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-[11px] text-content-subtle">
            暂无可用模型,请先在「模型配置」中添加。
          </p>
        )}
      </SettingRow>

      {/* Prompt template — format/language preference only */}
      <SettingRow
        layout="vertical"
        title="格式与语言偏好"
        desc="仅控制提交信息的语言、措辞风格与规范格式(如 Conventional Commits、中英文、是否加 emoji)。核心生成行为(基于已暂存 diff 输出干净的提交信息)已内置固定,无法被覆盖。留空使用默认偏好。"
      >
        <textarea
          value={commitGenPrompt}
          onChange={(e) => setCommitGenPrompt(e.target.value)}
          placeholder="例如:使用英文、遵循 Conventional Commits 规范、在类型前加 emoji…"
          rows={5}
          className={cn(
            "w-full resize-y rounded-md border border-edge-input bg-surface px-2.5 py-1.5 text-xs leading-relaxed text-content outline-none",
            "focus:border-accent",
          )}
        />
      </SettingRow>
    </div>
  );
}
