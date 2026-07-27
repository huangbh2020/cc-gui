## 修复目标

让 AskUserQuestion 工具调用阻塞等待用户答案，答案通过专门的 IPC 通道回填给被挂起的 provider turn（Deferred 唤醒），使同一轮对话继续生成——彻底替换当前的 fire-and-forget 模式。

参考依据：[SDK 官方文档](https://code.claude.com/docs/en/agent-sdk/user-input)、Synara 实现指南 §3.1（Deferred + pending map）。

---

## 改动清单（按依赖顺序）

### 1. `packages/contracts/src/provider.ts` — 答案数据结构结构化
把 `UserInputDecision.answers: string` 改成结构化的 `Record<questionId, string | string[] | null>`，便于 provider 把答案精确映射回每个 question（SDK 要求 answers 的 key 是问题文本，value 是 label）。

```ts
export type UserInputAnswers = Record<string, string | string[] | null>;
export interface UserInputDecision { answers: UserInputAnswers; }
```
`UserInputRequest` 增加可选 `toolUseId?: string`（SDK canUseTool 的 toolUseID，回填 updatedInput 时用）。

### 2. `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts` — ★ 核心修复
- `canUseTool` 里 `AskUserQuestion` 分支不再 `return null`，改为：
  - 调用 `ctx.requestUserInput({ requestId, toolUseId, questions })`（Deferred 阻塞）
  - 把返回的 `answers` 映射成 SDK 期望的 `{ "问题文本": "label" }` 形态
  - 返回 `{ behavior: "allow", updatedInput: { questions: input.questions, answers } }` —— SDK 官方文档明确要求 questions 必须回传
- 删除 `onUserDialog` 里对 AskUserQuestion 的一刀切 `cancelled`（保留对其他未知 dialog_kind 返回 cancelled 的兜底；AskUserQuestion 已被 canUseTool 处理，不会再触发 dialog）
- `SdkMessageAdapter` 里 `AskUserQuestion` 的 tool_use 事件**不再发** `question.ask`（避免和 canUseTool 重复触发；改由 canUseTool 路径统一发）

### 3. `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts` — sentinel 模式补 requestId
sentinel 扫描器扫到问题时，给 `question.ask` 事件带上 `requestId`（`randomUUID()`），并存到 adapter 内部一个 `sentinelPendingId` 字段。provider 在 sentinel 模式下需要监听这个事件、用同样 Deferred 模式阻塞——为此 provider 需要一个回调钩子。

实现方式：给 `SdkMessageAdapter` 构造函数注入一个 `onSentinelQuestion(questions, requestId) => Promise<UserInputAnswers>` 回调；adapter 在 sentinel 扫到问题时 `await` 它，拿到答案后用 sentinel 约定的文本回填方式送回（sentinel 模式没有真正的 tool_use，所以答案只能作为「下一条 user 消息」由 provider 自己注入到 query 的后续流——但因 SDK 单 turn 已结束，这里降级为：sentinel 模式触发 `question.ask` 后，provider 不阻塞，由前端走回填通道把答案作为新一轮 prompt 发出，并在前面加上约定前缀让 Claude 识别）。

**为避免方案膨胀，sentinel 模式本期保持 fire-and-forget 语义但走新的「答案回填」通道**：前端把答案拼成文本通过新 IPC 发到 main，main 用 `runtimeManager.sendTurn` 作为下一轮 prompt 发出（前缀提示 Claude 这是上一题的答案）。这是 sentinel fallback 的固有局限，文档里也会注明。**原生 AskUserQuestion 模式（主要场景）走完整的 Deferred 阻塞。**

### 4. `packages/contracts/src/ipc.ts` — 新增答案回填 RPC 通道
- 新增 `RespondQuestionSchema = z.object({ sessionId, requestId, answers })`
- 新增 `IPC.CLAUDE_RESPOND_QUESTION = "claude:respondQuestion"`
- `RpcMap` 加 `"claude.respondQuestion"`

### 5. `apps/desktop/src/preload/index.ts` — 暴露新通道
`api.claude` 加 `respondQuestion(input)`。

### 6. `apps/desktop/src/main/ipc/claude.ts` — 注册 handler
```ts
ipcMain.handle(IPC.CLAUDE_RESPOND_QUESTION, (_evt, raw) => {
  const input = RespondQuestionSchema.parse(raw);
  runtimeManager.resolveUserInput(input.requestId, input.answers);
});
```

### 7. `apps/desktop/src/main/claude/RuntimeManager.ts` — resolveUserInput 签名对齐
`resolveUserInput(requestId, answers: UserInputAnswers)`，透传给 ApprovalBridge。

### 8. `apps/desktop/src/main/claude/ApprovalBridge.ts` — 签名对齐
`resolveUserInput(requestId, answers: UserInputAnswers)`，`resolve({ answers })`。

### 9. `apps/desktop/src/renderer/stores/sessionStore.ts` — pendingQuestion 带 requestId，提交走新通道
- `pendingQuestion` 类型加 `requestId: string`
- `ingestEvent` 收 `question.ask` 时存下 `requestId`（sentinel 模式可能没有 → 兜底生成一个 `sentinel_<uuid>` 标记，main 识别到 `sentinel_` 前缀走降级路径当作普通 prompt 发）
- 新增 action `respondQuestion(answers)`：调 `api.claude.respondQuestion`，**并把 isRunning 设回 true**（用户答案提交即进入等待 Claude 继续的状态），同时 `set({ pendingQuestion: null })`

### 10. `apps/desktop/src/renderer/components/chat/ChatPane.tsx` — onSubmit 改走新通道
`QuestionPrompt.onSubmit` 签名从 `(text: string)` 改为 `(answers: UserInputAnswers)`：
- 不再 `sendPrompt(text)`
- 改为从 store 读 `pendingQuestion.requestId`，调 `respondQuestion(answers)`
- isRunning 由 store action 内部置 true

### 11. `apps/desktop/src/renderer/components/chat/QuestionPrompt.tsx` — 输出结构化答案
`submit()` 把 `answers` 数组归并成 `Record<questionText, label | labels[] | null>`：
- 多选 → `string[]`
- 单选/自由文本 → `string`（自由文本作为自定义 label）
- 跳过 → `null`

key 用 question.question 文本（和 SDK 官方约定一致）。

---

## 关键技术点

1. **answers 映射规则**（provider 内）：`UserInputAnswers` 的 key 是 questionId（前端用 question 文本作 key），provider 转成 `{ [question.question]: label }` 给 SDK。
2. **isRunning 时序**：原生模式下 provider 的 `query()` generator 在 canUseTool await 期间本就没结束（Deferred 阻塞），所以 `turn.done` 不会提前到，前端 isRunning 保持 true 即可。sentinel 降级模式下 turn 已结束，需要前端在 respondQuestion 时把 isRunning 重新置 true（store action 处理）。
3. **取消按钮（onDismiss）**：发空 answers `{}`，provider 收到后仍要 `behavior: allow` 让 turn 结束（避免 tool 永久阻塞）。
4. **turn.done 兜底**：ApprovalBridge 在 dispose 时已 rejectAll，无需新增。

---

## 验证步骤

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 全绿
2. `pnpm dev` 启动，触发一次 AskUserQuestion（要求模型用 AskUserQuestion 工具，例如让它问选择题）
3. 验证：提交答案后**输入框立刻禁用**、Claude 在**同一轮**内继续生成回复（日志里只看到一个 query turn，没有重启）
4. 验证取消按钮：点 ✕ 后 turn 正常结束，不卡死
5. 验证 sentinel fallback（如果当前模型不支持原生工具）：问题卡片仍能弹出，答案作为下一轮 prompt 发出

---

## 影响面
- 跨进程契约改动（provider.ts / ipc.ts）—— 但都是新增/兼容性扩展，不破坏现有 approval 通道
- 11 个文件，无新文件
- 完全局限在 P3 工具审批 + AskUserQuestion 子系统，不碰 P2 持久化、P1 渲染主线