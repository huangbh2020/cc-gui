# 文件树右键菜单实现计划

## 目标
在文件树节点(文件 + 文件夹)上添加右键上下文菜单,提供 5 个操作:**打开、在资源管理器中打开、复制绝对路径、复制相对路径、添加到聊天**。

## 范围决策(采用推荐方案)
- **文件节点**:显示全部 5 个操作。
- **文件夹节点**:显示 4 个操作(`打开`、`在资源管理器中显示`、`复制绝对路径`、`复制相对路径`),**不显示"添加到聊天"**(目录作为 `@path` 文件引用 tag 不合适)。文件夹的"打开"语义是展开/折叠切换。

## 架构概览

```
FileTree.tsx (ContextMenu.Root 包裹行)
   ├── 打开           → store.openFileInIde(path) / 目录: toggleDirExpanded
   ├── 在资源管理器中显示 → 新 IPC: shell.showItemInFolder (shell.showItemInFolder)
   ├── 复制绝对路径    → navigator.clipboard.writeText(path) + 行内 toast
   ├── 复制相对路径    → 新 helper relativePath(path, projectPath) + clipboard
   └── 添加到聊天      → store 新动作 enqueueChatFile(path) → ChatPane 消费
```

## 详细改动

### 1. 新增 IPC: `shell:showItemInFolder`(在资源管理器中显示)

**为什么新建**:现有 `shell.openPath` 只接受精确等于项目根的路径(`shell.ts:27` 拒绝非根路径)。要"在 Finder/资源管理器中显示具体文件",需用 Electron 的 `shell.showItemInFolder(path)`,它接受任意路径并在文件管理器中定位该文件。

- **`packages/contracts/src/ipc.ts`**:
  - 新增 `ShowItemInFolderSchema = z.object({ path: z.string() })` + 类型(放在 `OpenPathSchema` 旁,~line 376)。
  - `RPC` 常量加 `SHELL_SHOW_ITEM_IN_FOLDER: "shell:showItemInFolder"`(line 1243 旁)。
  - `RpcMap` 加 `"shell.showItemInFolder": (input: ShowItemInFolderInput) => Promise<void>`(line 1171 旁)。
- **`apps/desktop/src/main/ipc/shell.ts`**:
  - 在 `registerShellHandlers` 新增 `ipcMain.handle(IPC.SHELL_SHOW_ITEM_IN_FOLDER, ...)`:用 `pathWithin` 风格的校验(复用 `ProjectRepo.list()` + `resolve` 包含检查,确保路径在某个未归档项目根内),通过后调 `shell.showItemInFolder(input.path)`。沿用现有"拒绝即静默 resolve"的优雅降级约定。
- **`apps/desktop/src/preload/index.ts`**:
  - `shell` 命名空间加 `showItemInFolder`(line 104 旁)。

### 2. "添加到聊天" 桥接:store ephemeral 队列

**为什么**:composer 的 `tags` 状态是 `ChatPane` 的本地 `useState`(`ChatPane.tsx:481`),文件树无法直接 `setTags`。采用项目已有的 **per-session ephemeral 桶**模式(与 `pendingQuestionBySession` / `turnFilesBySession` 一致)。

- **`apps/desktop/src/renderer/stores/sessionStore.ts`**:
  - 新增状态字段:`chatFileQueueBySession: Record<string, string[]>`(未持久化,纯转发队列)。
  - 新增动作:
    - `enqueueChatFile(filePath: string)`:把路径 push 进**活动 session** 的队列(活动 session 没有则 no-op,符合"前台 tab 的配置"语义)。
    - `drainChatFileQueue(): string[]`:读取并清空活动 session 的队列,返回路径数组(供 ChatPane 消费)。
  - 在 `deleteSession` 的清理逻辑里同步删除该 session 的队列桶(与 `pendingQuestionBySession` 清理一致,~line 2336)。
- **`apps/desktop/src/renderer/components/chat/ChatPane.tsx`**:
  - 在 `ChatPaneForSession` 内加一个 `useEffect`,依赖一个从 store 派生的"队列版本/快照"(订阅 `chatFileQueueBySession[sessionId]`),每当队列非空时调用现有的 `addFileTags` 逻辑(复用 `appendUniqueFileTags`)把路径转成 file tags,然后 `drainChatFileQueue()` 清空。这样不改动 `tags` 的归属(仍为本地状态),只增加一个外部注入入口。

### 3. 文件树右键菜单 UI(`FileTree.tsx`)

- `import { ContextMenu } from "@base-ui/react/context-menu";`(与 `GitRepoCard.tsx` 一致)。
- 复用 `GitRepoCard` 的 Popup/Item className 约定(`z-50 min-w-[140px] rounded-md border border-edge bg-surface py-1 shadow-2xl ...` + `data-[highlighted]:bg-surface-muted`,危险项用 `text-danger`)。
- **重构 `FileNodeRow`**:用 `ContextMenu.Root` + `ContextMenu.Trigger render={<button/>}` 包裹现有 button,把 button 的现有 props(`draggable`、`onClick`、`ref` 注册)原样保留到 trigger render 元素上。菜单项:
  - `打开` (`IconExternalLink` / `IconFile`) → `onClick`
  - `在资源管理器中显示` (`IconFolderShare` 或 `IconExternalLink`) → `api.shell.showItemInFolder({ path })`
  - `复制绝对路径` (`IconClipboard`) → clipboard + 行内 toast
  - `复制相对路径` (`IconCopy`) → clipboard + 行内 toast
  - `添加到聊天` (`IconMessage` / `IconPlus`) → `enqueueChatFile(path)`
- **重构 `DirNode` 的 button**:同样用 `ContextMenu.Root` 包裹,但菜单只含前 4 项(无"添加到聊天");"打开"= `onToggle`(展开/折叠)。
- **传参调整**:`TreeNode` 已有 `entry`、`projectPath`、`openFileInIde`、`toggleDirExpanded`;需把 `projectPath` 透传给 `FileNodeRow`/`DirNode`(目前 `FileNodeRow` 没收到 `projectPath`,用于算相对路径)。`FileNodeRow` 的 props 增加 `projectPath: string`。
- **新增"复制成功"反馈**:行内用一个短暂的 `copied` state(类似 `Markdown.tsx:132` 的 `CopyButton` 模式)在菜单按钮上方显示一个轻量 toast,2s 后消失。或更简单:菜单项点击后关闭,在文件树区域底部显示一个 transient 提示。倾向于前者(组件内 state,最简单)。

### 4. 相对路径 helper

- **`apps/desktop/src/renderer/lib/path.ts`**:新增 `relativePath(absPath: string, root: string): string` —— 去掉 `absPath` 开头的 `root` 前缀(分隔符感知,处理 `/` 和 `\`),返回形如 `src/sub/a.ts`。若 `absPath` 不以 `root` 开头则回退返回 `absPath`(防御)。复用该文件现有的 SEP_RE 风格。
- 文件树里用 `relativePath(path, projectPath)`。

### 5. 图标
- 从 `@renderer/lib/icons.js` 选用:`IconExternalLink`(在资源管理器中显示)、`IconClipboard`(复制绝对路径)、`IconCopy`(复制相对路径)、`IconMessage` 或 `IconPlus`(添加到聊天)、`IconFile`/`IconFolderOpen`(打开)。这些在 icons.tsx 中已 re-export 或可加。

## 关键约束(遵循 AGENTS.md)
- 所有 className 用 `cn()`(不用 template literal 拼接)。
- 语义 token:`bg-surface` / `text-content-muted` / `border-edge` / `text-danger` 等,不用原始 Tailwind 颜色。
- IPC 新通道走完整三步:contracts schema + `IPC` 常量 → preload 白名单 → main handler 用 zod `parse` 校验。
- 文件间相对导入带 `.js` 后缀(nodeNext)。
- base-ui 直接在调用点 import(项目无 Menu 封装组件,遵循 `GitRepoCard` 既有约定)。

## 涉及文件清单
| 文件 | 改动 |
|------|------|
| `packages/contracts/src/ipc.ts` | + `ShowItemInFolderSchema`/type, + `IPC.SHELL_SHOW_ITEM_IN_FOLDER`, + `RpcMap` 项 |
| `apps/desktop/src/main/ipc/shell.ts` | + handler(校验项目根包含 + `shell.showItemInFolder`) |
| `apps/desktop/src/preload/index.ts` | + `shell.showItemInFolder` |
| `apps/desktop/src/renderer/lib/path.ts` | + `relativePath()` helper |
| `apps/desktop/src/renderer/stores/sessionStore.ts` | + `chatFileQueueBySession` 状态 + `enqueueChatFile` / `drainChatFileQueue` 动作 + 删除 session 清理 |
| `apps/desktop/src/renderer/components/chat/ChatPane.tsx` | + useEffect 消费队列 → `addFileTags` |
| `apps/desktop/src/renderer/components/ide/FileTree.tsx` | 重构 `FileNodeRow`/`DirNode` 包裹 `ContextMenu`,加 5 项/4 项菜单 + 复制反馈 |

## 验证
1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`(改完先 typecheck)。
2. 手动验证(开发模式):右键文件/文件夹出现菜单;各项功能可用;复制有反馈;添加到聊天后 composer 出现 file tag chip;在资源管理器中显示打开 Finder/Explorer 并定位文件。