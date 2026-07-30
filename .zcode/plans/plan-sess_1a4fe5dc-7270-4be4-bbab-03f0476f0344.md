# 中间面板输入框优化（上下文 / @ / 斜杠命令 / 圆环）

## 目标（对应需求 2–5）

1. **添加上下文**：输入框底部增加图标按钮 → 项目文件选择器 → 以卡片加入 → 发送后消息流同样以卡片展示  
2. **`/` 命令选择**：输入 `/` 触发 Claude Code 风格命令菜单  
3. **优化 `@`**：从系统文件对话框改为**当前项目文件树模糊选择**；选中后变成**文件卡片**（与拖拽/添加上下文一致）  
4. **上下文圆环 hover**：用组件库 + 图标做富文本浮层，替换原生 `title`

## 现状（可复用）

| 能力 | 现状 |
|------|------|
| 文件卡片模型 | `contentTag.ts` 的 `ContentTag` / `makeFileTag`；composer 上方 `ContentTagChip`；消息流 `AttachmentCard` |
| 发送链路 | `composePromptWithTags` + `sendPrompt(..., attachments, displayText)` 已完整 |
| `@` | 仅触发 `api.pickFile()`，插入 `@path` **纯文本**，不进卡片 |
| `/` | 无 composer 斜杠命令 |
| 文件列表 IPC | 仅有一层 `file.listDir`（FileTree 懒加载） |
| 圆环 tooltip | `ContextRing` 用原生 `title=`；`StatusCapsule` 有重复逻辑 |
| UI 原语 | 有 Button/Dialog/Select；**无** Tooltip 封装；CommandPalette 用 Dialog+Combobox 可作菜单参考 |

## 架构示意

```
Composer (ChatPane)
├─ tags row: ContentTagChip[]          ← 已有，@/添加上下文都写入这里
├─ textarea
│   ├─ type "@query" → FileMentionPicker (项目文件模糊搜)
│   └─ type "/query" → SlashCommandPicker (Claude Code 风格命令)
└─ bottom row
    ├─ [+] 添加上下文 → 同一 FileMentionPicker（多选）
    ├─ Model / Effort / Permission
    ├─ ContextRing + Tooltip 富浮层
    └─ Send / Stop
```

## 实现方案

### A. 项目文件索引 IPC（支撑 @ 与添加上下文）

新增一层比 `listDir` 更高层的搜索，避免渲染进程对大仓库做 N 次 IPC BFS。

**合约** `packages/contracts/src/ipc.ts`：
- `file.search`：`{ projectPath, query?, limit? }` → `{ files: { name, path, relativePath }[] }`
- 服务端递归 walk，复用 `files.ts` 的 ignore（`node_modules` / `.git` / `dist` 等），路径必须在 project root 内
- `query` 空：返回截断列表（如 500）；有 query：路径/文件名大小写不敏感子串匹配，limit 默认 80

**主进程** `main/ipc/files.ts` + **preload** 白名单同步。

### B. 共享文件选择浮层 `FileMentionPicker`

新建 `apps/desktop/src/renderer/components/chat/FileMentionPicker.tsx`：
- 锚定在 textarea 上方（fixed/absolute，参考 `TagPopover` / CommandPalette 列表样式）
- 打开时 `api.file.search`；输入防抖过滤
- 键盘：↑↓ 选择、Enter 确认、Esc 关闭、Tab 可选确认
- 图标：`IconFile` / `IconFolder`（按需）+ 相对路径副标题
- 模式：
  - **mention（@）**：单选；回调 `onPick(path)`
  - **attach（添加上下文）**：可多选或连续点选；确认后批量 `makeFileTag`

无 `activeProject` 时：菜单提示「请先打开项目」，不调 IPC。

### C. Composer：添加上下文按钮 + `@` 改为卡片

改 `ChatPane.tsx`：

1. **左下角按钮**（bottom row 最左侧，toolbar 前）  
   - 图标：`IconPaperclip` 或 `IconFilePlus`（补 `icons.tsx` 导出）  
   - 点击打开 `FileMentionPicker`（attach 模式）  
   - 选中 → `setTags(prev => [...prev, ...paths.map(makeFileTag)])`，去重同 path

2. **`@` 行为重写**（替换 `completeAtMention` + `api.pickFile`）  
   - 检测刚输入的 `@`，记录 trigger 下标与 query  
   - 继续输入变成 filter query；退格删掉 `@` 则关闭  
   - 选中文件：  
     - 删除 textarea 中 `@query` 片段  
     - `makeFileTag(path)` 加入 tags  
   - 与拖拽/添加上下文统一为卡片；发送后走现有 `AttachmentCard`

3. **卡片展示**  
   - Composer：沿用并微调 `ContentTagChip`（文件名 + 可选相对路径 title）  
   - 消息流：已有 `AttachmentCard`，保持视觉一致；必要时统一文案/图标

### D. `/` Claude Code 风格命令选择

新建：
- `lib/slashCommands.ts` — 命令注册表  
- `components/chat/SlashCommandPicker.tsx` — 浮层 UI（样式对齐 FileMentionPicker）

**触发规则**：行首或空白后的 `/`，query 为 `/` 后连续非空白字符；空格/Esc/光标离开 token 关闭。

**第一版命令集（Claude Code 风格，可执行优先）**：

| 命令 | 行为 |
|------|------|
| `/clear` | 本地：清空当前会话消息 UI（若已有 clear API 则调用；否则仅清 composer + 明确提示）— 优先对接现有会话能力，不做假成功 |
| `/compact` | 作为 prompt 发送 `/compact`（交给 Claude/SDK） |
| `/cost` | 优先展示当前 `contextSnapshot` 费用浮层；无数据则发送 `/cost` |
| `/help` | 在 picker 内展示可用命令帮助，或发送 `/help` |
| `/model` | 聚焦/打开 ModelDropdown（本地 UI） |
| `/permissions` 或 `/plan` 等 | 映射到已有 permission mode 切换（本地） |
| `/init` `/review` `/memory` `/diff` `/export` 等 | 作为完整 prompt 发送给 agent（与 CLI 习惯一致） |

每项含：`id, name, description, keywords, icon, run(ctx)`。  
过滤：前缀/子串匹配 name+keywords。  
Enter：执行 `run` 并移除输入中的 `/token`；需发送的命令走现有 `sendPrompt`。

> 说明：当前 runtime **未**把 `system/init.slash_commands` 灌进 store。第一版用静态表覆盖常用命令；后续可再接 init 动态列表。

### E. 上下文圆环 Tooltip 优化

1. 新增 `components/ui/tooltip.tsx`：封装 `@base-ui/react/tooltip`（delay、定位、语义 token 样式），并 barrel export  
2. `contextWindow.ts`：抽出共享 `getContextBreakdown(snapshot)`（used/max/pct、freshInput、cache、output、cost）  
3. 重写 `ContextRing` hover：  
   - 标题行：占用 + 进度色  
   - 分项行：`IconArrowDown`/`IconDatabase`/`IconArrowUp`/`IconCoin` 等 + 标签 + 数值  
   - 不再用原生 `title`  
4. `StatusCapsule` 的 context 段复用同一 breakdown + Tooltip，去重 `buildContextTooltip`

### F. 图标补充

`lib/icons.tsx` 增加并导出：`IconPaperclip`、`IconAt`、`IconSlash`（或 `IconCommand`）、tooltip 用到的输入/缓存/费用图标。

## 主要改动文件

| 文件 | 变更 |
|------|------|
| `packages/contracts/src/ipc.ts` | `file.search` schema + IPC 常量 + RpcMap |
| `main/ipc/files.ts` | 实现递归搜索 |
| `preload/index.ts` | 暴露 `api.file.search` |
| `renderer/lib/contentTag.ts` | 小幅：文件 tag 去重 helper（可选） |
| `renderer/lib/slashCommands.ts` | **新建** 命令表 |
| `renderer/lib/contextWindow.ts` | breakdown 共享 |
| `renderer/lib/icons.tsx` | 新图标 |
| `renderer/components/ui/tooltip.tsx` + `index.ts` | **新建** Tooltip |
| `renderer/components/chat/FileMentionPicker.tsx` | **新建** |
| `renderer/components/chat/SlashCommandPicker.tsx` | **新建** |
| `renderer/components/chat/ChatPane.tsx` | 按钮、@/、picker 状态机 |
| `renderer/components/chat/ContentTagChip.tsx` | 卡片微调（如需要） |
| `renderer/components/chat/ContextRing.tsx` | 富 Tooltip |
| `renderer/components/chat/StatusCapsule.tsx` | 复用 tooltip |
| `renderer/components/chat/ComposerToolbar.tsx` | 若 ContextRing 仍内嵌则几乎不动 |

## 交互细节

- **互斥**：`/` 与 `@` picker 同时只开一个；`inputBlocked` 时不打开  
- **去重**：同一 `filePath` 不重复加 tag  
- **占位符**：改为提示 `@ 引用文件 · / 命令 · 左下角添加上下文`  
- **发送**：文件仍只注入 `@path`（agent 自读文件），不在 renderer 读全文——与现拖拽行为一致  
- **无项目**：添加上下文 / @ 给出友好空态

## 验证

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`  
2. 手动：  
   - 点左下角选文件 → 上方卡片 → 发送 → 消息流卡片  
   - 输入 `@` 过滤选中 → 卡片而非纯文本  
   - 输入 `/` 过滤并执行/发送  
   - 圆环 hover 富浮层样式与数据正确  
3. 拖拽文件到 composer 行为不回归

## 非目标（本轮不做）

- 把 `SendTurn.attachments` 接到 main（继续 prompt 内联）  
- 从 `system/init` 动态灌全量 slash_commands  
- Skills 市场 / 自定义用户 slash 配置页  
- 二进制附件 / 图片多模态