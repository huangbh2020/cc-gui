## 目标
Git 面板两处优化,均在 `apps/desktop/src/renderer/components/ide/GitRepoCard.tsx` 单文件内:
1. 提交信息输入框改为**多行文本**(默认 1 行,最多 3 行,超过 3 行显示"最大化"按钮,点击轻量弹出预览面板);**提交按钮移到输入框下方**。
2. "放弃更改?"弹框用组件库重写,改善样式(当前缺 padding/width、用裸 `<button>`,与 `CustomModelsPanel` 的成熟样式不一致)。

## 现状(已确认)
- `CommitBox`(366-512 行):单行 `<input type="text">`(426-438) + 右侧内嵌 AI 生成图标(440-457) + 同行右侧分裂提交按钮(460-508,主"提交"+下拉 提交/提交并推送/提交并同步)。整行 `flex gap-1.5`。
- 丢弃弹框(321-359 行):已用 `Dialog`,但 `Dialog.Popup` **未传 className**(无 padding/width,内容贴边),操作按钮是裸 `<button>`(取消=灰文、确认=`bg-danger text-surface` 实心红)。对比 `CustomModelsPanel`(421-461)的成熟写法:`Dialog.Popup className="w-[360px] max-w-[90vw] p-4"` + `<Button variant="ghost">`/`<Button variant="danger">` + `Dialog.Close`。
- `Button` 的 `danger` variant 是**文字红**(`text-danger hover:bg-danger/10`),与 `CustomModelsPanel` 删除确认一致--采用它。
- 已导出图标:`IconMaximize`/`IconMinimize`(icons.tsx:104-105),无需新增。
- `commitMsg` 是 `GitRepoCard` 本地 `useState`(48 行),经 `value`/`onChange` 传入 `CommitBox`。
- 字体:`var(--right-panel-font-size)`(14px)。

## 改动 1:多行提交框 + 提交按钮下移

重写 `CommitBox` 的 return(`421-511` 行):

### 布局(纵向)
```
┌───────────────────────────────────────┐
│ textarea (1~3 行自适应)    [✨][▢]    │  ← 输入框 + 右上角生成/最大化图标
├───────────────────────────────────────┤
│ [提交 ▾]                   (下方整行) │  ← 提交分裂按钮移到下方
└───────────────────────────────────────┘
```

### textarea 实现(替换原 input)
- `<textarea rows={1}>`,`resize: none`,样式沿用现有 token:`w-full rounded-md border border-edge-input bg-surface px-2 py-1 [font-size:var(--right-panel-font-size)] leading-relaxed text-content outline-none focus:border-accent disabled:opacity-50`。
- **自适应高度 + 3 行上限**:用 `useRef<HTMLTextAreaElement>` + `useLayoutEffect`,每次 `value` 变化时重置 `height=auto` 再读 `scrollHeight`,按行高换算为可见行数。可见行数 = `min(实际行数, 3)`,设 `style.height`。同时记录 `overflowed = 实际行数 > 3`,用于显示最大化按钮。
  - 行高取 `lineHeight` 计算(从 ref 的 `computedStyle` 读),避免硬编码。
- **Enter 行为调整**:textarea 里 Enter 默认换行(多行本就该如此);用 `Ctrl/Cmd+Enter` 触发提交(常见多行输入框约定),保留快捷提交能力。
- 右上角图标区(absolute right-1 top-1.5,纵向排列或并排):AI 生成图标(`IconSparkles`/`IconLoader2`,仅 `commitGenModel` 配置时显示);**最大化图标**(`IconMaximize`,仅 `overflowed` 时显示,点击打开预览面板)。

### 最大化预览面板(轻量弹窗)
- 复用 `Dialog` 组件(组件库既有,轻量、居中、带 backdrop)。
- `CommitBox` 内加 `const [previewOpen, setPreviewOpen] = useState(false)`。
- 预览面板内容:`Dialog.Popup className="w-[480px] max-w-[90vw] p-4"`,`Dialog.Title`="编辑提交信息",一个大 `<textarea rows={10} className="resize-y ...">`(可缩放、完整编辑),`Dialog.Description` 提示"Ctrl+Enter 提交"。
- **双向同步**:预览 textarea 直接绑定 `value`/`onChange`(与主输入框同源,因为是同一份 `commitMsg` 状态)。关闭面板即回写到主输入框。
- 底部:取消(`<Button variant="ghost">` 关闭面板) + 提交(`<Button variant="primary">` 调 `onCommit("commit")` 并关闭)。

### 提交按钮下移
- 原"分裂提交按钮"(主"提交" + 下拉 提交/推送/同步,460-508)整体移到 textarea 下方,独立一行 `flex justify-end gap-1.5 mt-1.5`。分裂按钮内部结构(Menu + Trigger)保持不变。
- 主"提交"按钮:可选地用 `<Button variant="primary" size="sm">` 替代裸 `<button>`,但分裂按钮的视觉拼接(主按钮+下拉 trigger 共享圆角/边框)用裸 button + 现有 className 更易保持。**保留裸 button**(仅样式微调,与下方布局对齐),避免破坏分裂按钮拼接;焦点放在布局下移。
- disabled 条件不变(`!value.trim() || disabled`)。

## 改动 2:重写"放弃更改?"弹框(321-359 行)

对齐 `CustomModelsPanel` 成熟样式:
- `Dialog.Popup` 加 `className="w-[360px] max-w-[90vw] p-4"`(补 padding/width)。
- 头部:危险图标圆 `IconAlertTriangle`(保留 `bg-danger/10 text-danger`,圆 `h-8 w-8` 微调)+ `Dialog.Title`="放弃更改?" + `Dialog.Description`="将放弃 N 个文件的本地更改,此操作不可撤销。"
- 加 `Dialog.Close`(右上角 X 关闭,组件库既有,提升一致性)。
- 底部 `mt-4 flex justify-end gap-2`:
  - 取消:`<Button variant="ghost" size="sm" onClick={() => setPendingDiscard(null)}>取消</Button>`
  - 确认:`<Button variant="danger" size="sm" onClick={handleDiscard} disabled={busy !== null}><IconTrash size={12}/>放弃更改</Button>`
  - (busy 时显示 spinner:`{busy === "commit" ? <IconLoader2 .../> : <IconTrash .../>}`)
- `handleDiscard`(192-206)与 `pendingDiscard` 状态(50)逻辑不变,仅替换 JSX。

## 导入调整(GitRepoCard.tsx 顶部)
- 新增 `Button` 导入(从 `@renderer/components/ui/index.js`,与 `Dialog` 同处)。
- 新增图标:`IconMaximize`(从 `@renderer/lib/icons.js`)。`IconArrowsMaximize` 不用(用已有的 `IconMaximize`)。
- `useLayoutEffect` 从 react 导入(CommitBox 自适应高度用)。

## 不做的事
- 不改 `commitMsg` 状态归属(仍 `GitRepoCard` 本地 state,经 props 传 `CommitBox`)。
- 不改 `handleCommit`/`handleDiscard` 业务逻辑。
- 不新增 Textarea 组件(库内无,沿用裸 `<textarea>` + 既有 className 约定,与 `settings/GitPanel.tsx` 一致)。
- 不改分裂提交按钮的 Menu 交互,只移位置。
- `danger` 用 `Button` 文字红 variant(对齐 `CustomModelsPanel`),不新增实心红 variant。

## 验证
1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 通过(重点:`useLayoutEffect` 导入、`Button` 导入、textarea ref 类型、Dialog 预览面板 props)。
2. `pnpm dev`:
   - 有暂存文件时,CommitBox 显示多行 textarea;输入 1~3 行自适应增高,超过 3 行出现最大化按钮;点最大化弹出预览面板,可完整编辑,关闭回写;Ctrl+Enter 提交;提交按钮在输入框下方。
   - 点文件"放弃更改":弹框有 padding/宽度、危险图标、X 关闭、取消/放弃更改按钮(组件库样式),确认后放弃、取消可关闭。
3. 回归:AI 生成提交信息(✨)仍可用;分裂提交按钮的 提交/推送/同步 三个选项仍可用。