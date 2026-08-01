## 目标

充实新建会话线程(空态)界面,在输入框上方加入:
1. **欢迎语 + 项目标题**:居中显示"在「{项目名}」中开始新的会话"标题 + 副标题。
2. **快捷任务建议卡**:一排固定的开发任务 starter chips(解释项目/写单元测试/审查最近改动/查找修复 bug/重构代码),点击填入输入框并聚焦(用户可编辑后发送,不直接发)。

用户决策:**填入输入框**(点击后填入+聚焦)+ **固定开发任务集**(不依赖项目内容动态探测)。

---

## 设计要点

- **新组件 `EmptyThreadWelcome`**:封装欢迎标题 + 建议卡。空态专用,收在单独文件里避免继续膨胀 `ChatPane.tsx`(已 1100+ 行)。
- **建议卡数据**:模块级常量 `SUGGESTIONS`,含 `{ icon, label, prompt }`。固定 5 条,全部使用已验证存在的图标(`IconBook`/`IconFlask`/`IconGitBranch`/`IconSearch`/`IconEdit`——全部在 `lib/icons.tsx`)。
- **点击行为**:`onPickPrompt(prompt)` → 父组件 `setValue(prompt)` + `textareaRef.current?.focus()`(填入+聚焦,不发送)。空态下禁用态与 `inputBlocked` 对齐(防御,空会话通常不 busy)。
- **布局顺序**(空态区块,自上而下):
  1. `ProjectBranchIndicator`(已有,`empty && projectPath`,项目名+git 分支)
  2. `EmptyThreadWelcome`(欢迎标题 + 建议卡)
  3. composer(输入框)
  视觉上:项目/分支 → 欢迎语 → 建议卡 → 输入框。

---

## 改动清单

### 1. 新建 `apps/desktop/src/renderer/components/chat/EmptyThreadWelcome.tsx`

```tsx
export interface EmptyThreadWelcomeProps {
  /** 项目显示名;空串时标题退化为"开始新的会话"。 */
  projectName: string;
  disabled: boolean;
  /** 点击建议卡 → 父组件填入输入框并聚焦。 */
  onPickPrompt: (prompt: string) => void;
}

const SUGGESTIONS: { icon: typeof IconBook; label: string; prompt: string }[] = [
  { icon: IconBook,       label: "解释项目",   prompt: "解释这个项目的结构和主要功能。" },
  { icon: IconFlask,      label: "写单元测试", prompt: "为项目编写单元测试。" },
  { icon: IconGitBranch,  label: "审查最近改动", prompt: "审查最近的 git 改动,找出潜在问题。" },
  { icon: IconSearch,     label: "查找修复 bug", prompt: "帮我定位并修复项目中的 bug。" },
  { icon: IconEdit,       label: "重构代码",   prompt: "重构代码,提高可读性和可维护性。" },
];
```

**JSX 结构**:
```tsx
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
```

**imports**:`cn`、图标(`IconBook`/`IconFlask`/`IconGitBranch`/`IconSearch`/`IconEdit`)。

### 2. `apps/desktop/src/renderer/components/chat/ChatPane.tsx`

- **import** `EmptyThreadWelcome`:`import { EmptyThreadWelcome } from "./EmptyThreadWelcome.js";`
- **渲染**:在现有 `{empty && projectPath && (<ProjectBranchIndicator/>)}` 区块之后、`{headApproval && ...}` 之前插入:
  ```tsx
  {empty && (
    <EmptyThreadWelcome
      projectName={projectName}
      disabled={inputBlocked}
      onPickPrompt={(prompt) => {
        setValue(prompt);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }}
    />
  )}
  ```
  `projectName` 选择器已存在(上一功能刚加);`inputBlocked` 已存在。

### 不需要改动(已验证)
- 建议卡点击只填输入框,不触达 store/send —— 无新 IPC、无 store 改动。
- `ProjectBranchIndicator` 保持不变。
- 非空会话不受影响(`empty` gate)。

---

## 验证

1. **typecheck**:`cd apps/desktop && npx tsc --noEmit -p tsconfig.json`。
2. **手动**(pnpm dev):
   - 新建会话(空)→ 输入框上方出现:项目名+分支指示器 → 欢迎标题"在「xx」中开始新的会话" → 一排建议卡。
   - 点"解释项目" → 输入框填入对应 prompt 并聚焦(未发送)。
   - 编辑后按 Enter → 正常发送。
   - 非 git 项目 → 仍显示欢迎语+建议卡(只是没有分支指示器)。
   - 发消息后 → 空态区块消失,正常会话布局。
3. **回归**:输入框、队列、发送、@mention、分支切换均不受影响。