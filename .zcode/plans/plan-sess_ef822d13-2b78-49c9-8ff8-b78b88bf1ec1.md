# 用户消息编辑重发功能实现计划

## 功能概述
用户发送消息后发现内容有误，停止 agent 后，可在已发送的用户消息右下方点击编辑图标，原位编辑消息内容并重新发送。编辑重发时，删除该消息及其后所有 AI 回复，用编辑后的内容重新发送。

## 架构决策

### SDK resume 处理
保持 `resume` 机制不变。GUI 截断消息历史后，仍用 `providerSessionId` 发送。SDK 服务端会保留旧消息，但 GUI 历史是干净的。AI 会看到原始消息 + 编辑后的消息，以最新消息为准。这是最务实的方案——真正的"fork from edit"需要全新 provider 会话，代价过大且丢失全部上下文。

### 消息截断与持久化
- 截断 `messagesBySession[sessionId]` 到目标用户消息索引之前
- 立即调用 `api.session.saveMessages` 持久化截断后的历史（DB 层是全量 replace）
- 然后追加新的用户消息并调用 `sendTurn` IPC

## 实现步骤

### 1. Store 层：新增 `editAndResendMessage` action
**文件**: `apps/desktop/src/renderer/stores/sessionStore.ts`

在 store interface 中新增 action 签名（约 line 559 附近）：
```ts
editAndResendMessage: (
  sessionId: string,
  messageId: string,
  newPrompt: string,
  attachments?: { preview: string; content: string; attachmentKind?: "paste" | "file"; filePath?: string }[],
  displayText?: string,
) => Promise<void>;
```

实现逻辑（放在 `sendPrompt` 实现之后）：
1. 守卫：`sessionId` 有效、`newPrompt` 非空、该 session 未在运行（`!runningBySession[sessionId]`）
2. 获取当前消息数组，找到 `messageId` 的索引
3. 截断：`messagesBySession[sessionId]` 只保留索引之前的消息
4. 立即持久化截断后的历史：`void api.session.saveMessages({ sessionId, messages: toRecords(sessionId, truncated) })`
5. 构建新的用户消息（与 `sendPrompt` 相同的 blocks 构建逻辑：attachment blocks + text block）
6. 追加新用户消息，设置 `runningBySession[sessionId] = true` + `runningTurnStartedAt`
7. 读取 model/customModelId/effort/permissionMode，调用 `api.claude.sendTurn({ sessionId, prompt, ... })`
8. IPC 失败时清理 running 状态（与 `sendPrompt` 一致）
9. 成功时更新 session 行缓存

**注意**：此 action 显式接收 `sessionId` 参数（不依赖 `activeSessionId`），支持多 tab 场景。同时需要清理该 session 的 turn-files 等可能残留的 per-turn 状态（`turnFilesBySession`），因为截断后旧 turn 的文件卡片不应保留。

### 2. UI 层：MessageRow 添加编辑功能
**文件**: `apps/desktop/src/renderer/components/chat/ChatPane.tsx`

#### 2a. 导入编辑图标
在现有 icon 导入（line 3-16）中添加 `IconPencil`（已在 `icons.tsx` 中导出）。

#### 2b. 新增 EditRow 组件（类似 CopyRow）
在 `CopyRow` 组件附近新增 `EditRow`：
```tsx
function EditRow({ onEdit, align = "end" }: { onEdit: () => void; align?: "start" | "end" }) {
  return (
    <div className={cn("flex", align === "end" ? "justify-end" : "justify-start")}>
      <button type="button" onClick={onEdit} title="编辑" aria-label="编辑"
        className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted">
        <IconPencil size={12} />
      </button>
    </div>
  );
}
```

#### 2c. 修改 MessageRow 组件
- 新增 props：`sessionId: string`、`canEdit?: boolean`（仅用户消息 + turn 未运行时为 true）、`onEditMessage?: (msg: ChatMessage) => void`
- 将 CopyRow 和 EditRow 包在同一个 hover 容器中（flex row），这样编辑和复制按钮并排显示在用户消息右下方
- 编辑按钮仅对用户消息显示，且 `canEdit` 为 true 时显示

#### 2d. 编辑模式状态管理
在 `ChatPaneForSession` 组件中添加编辑状态：
```ts
const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
```

新增 `EditMessageInline` 组件：当用户点击编辑按钮时，将 `editingMessageId` 设为该消息 id。`MessageRow` 检测到 `editingMessageId === msg.id` 时，渲染编辑 UI（textarea + 发送/取消按钮）替代正常内容。

编辑 UI 结构：
- 一个 textarea，预填原消息的 text block 内容
- 下方一行：取消按钮（恢复显示）+ 发送按钮（调用 `editAndResendMessage`）
- Enter 发送，Shift+Enter 换行，Escape 取消

#### 2e. 连接 store
在 `ChatPaneForSession` 中从 store 获取：
```ts
const editAndResendMessage = useSessionStore((s) => s.editAndResendMessage);
const isRunning = useSessionStore((s) => s.runningBySession[sessionId] ?? false);
```

`handleEditSubmit` 回调：
```ts
const handleEditSubmit = async (msg: ChatMessage, newText: string) => {
  const text = newText.trim();
  if (!text) return;
  setEditingMessageId(null);
  // 重建 prompt：如果原消息有 attachments，需要保留它们
  const attachmentBlocks = msg.blocks.filter(b => b.kind === "attachment");
  const attachments = attachmentBlocks.map(b => ({ preview: b.preview, content: b.content, ... }));
  const prompt = composePromptWithTags(text, /* tags from attachments */);
  await editAndResendMessage(sessionId, msg.id, prompt, attachments, text);
};
```

#### 2f. 传递 props 到 MessageRow
在 `renderListItem`（line 882 附近）渲染 `single` 类型消息时，传入新 props：
```tsx
<MessageRow
  msg={m}
  isStreamingTail={...}
  isTurnTail={...}
  beforeMap={beforeMap}
  sessionId={sessionId}
  canEdit={isUser && !isRunning}
  editingMessageId={editingMessageId}
  onEditMessage={(msg) => setEditingMessageId(msg.id)}
  onEditSubmit={handleEditSubmit}
  onEditCancel={() => setEditingMessageId(null)}
/>
```

### 3. 类型与边界处理
- 编辑时只编辑 text block 内容，attachment blocks 保留原样（用户编辑的是文本部分，附件内容通过 prompt 重新组合）
- 如果原消息有 attachments，编辑后的 prompt 仍用 `composePromptWithTags` 重新组合（将 attachment blocks 转回 tags 格式）
- 截断后清理该 session 的 `turnFilesBySession`、`pendingApprovals`（属于被截断 turn 的）等残留状态
- 编辑按钮仅在 `!isRunning` 时显示（用户必须先停止 agent）

## 涉及文件
1. `apps/desktop/src/renderer/stores/sessionStore.ts` - 新增 `editAndResendMessage` action
2. `apps/desktop/src/renderer/components/chat/ChatPane.tsx` - MessageRow 编辑 UI + 编辑模式状态 + 连接 store

## 验证
- 改完后运行 `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 类型检查
- 手动验证流程：发送消息 -> 停止 -> 点击编辑图标 -> 修改内容 -> 发送 -> 确认旧消息和 AI 回复被删除，新消息已发送