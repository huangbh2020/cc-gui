# 修复计划：pi 过程数据收纳失效（已在计划模式确认）

## 根因
pi 会话中 turn 的第一条消息（opener）堆积了 1 个 thinking + 86 个 tool_use，后续 text 各自独立成消息，导致 `groupMessagesForRender` 把所有工具之后的 text 误判为"最终回复"外露。

三个层面根因：
1. pi 的 tool 事件（tool_execution_start）与 message 脱节，无 messageId 关联
2. store 的 tool.use 用 findOpenTurnTrailingAssistant 只认带 turnMeta 的 opener → 全堆 opener
3. text/tool 时序竞态（text 走 deltaBuf 延迟 flush）

## 改动（3 个文件）

### 1. packages/contracts/src/runtime.ts — ToolUseEvent 加可选 messageId
向后兼容：claude 不传，pi 传。

### 2. apps/desktop/src/main/providers/pi-sdk/PiMessageAdapter.ts — 关联 tool 到所属 message
- 新增 `pendingToolTargetId` 字段
- `handleMessageUpdate` 加 `toolcall_start` 分支：`pendingToolTargetId = lastMessageId`
- `tool_execution_start` emit tool.use 带 messageId

### 3. apps/desktop/src/renderer/stores/sessionStore.ts — tool.use 按 messageId 精确挂载
- 主 set 前：`if (e.type === "tool.use" && e.messageId) forceDeltaFlush()`
- tool.use case：带 messageId 且 findMsg 命中 → 精确挂载；否则 fallback 原逻辑

## 验证
`cd apps/desktop && npx tsc --noEmit -p tsconfig.json`

## 流程
1. 创建新分支（基于 feat/pi-sdk-integration）
2. 实现上述 3 处改动
3. 类型检查通过
4. 提交（用户若需要我再 commit）