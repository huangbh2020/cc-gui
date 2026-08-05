# 修复：TaskUpdate 跨 turn 后右上角任务卡片状态不更新

## 问题根因

模型调用 `TaskUpdate({taskId: 6, status: "completed"})` 时，消息流里显示了 "Updated task #6 status"（来自 `tool_result`），但右上角胶囊卡片中任务状态没变成完成。

根因在 `SdkMessageAdapter.ts:817-828` 的 `TaskUpdate` 分支：

```ts
if (Number.isInteger(taskId) && taskId >= 1 && taskId <= this.state.tasks.length) {
  this.state.tasks[taskId - 1] = { ...status: norm };
  // emit todo.update
}
```

**两个相互叠加的问题：**

1. **跨 turn 状态丢失（主因）**：每个 turn 新建 `SdkMessageAdapter`，`state.tasks` 从空 `[]` 开始（构造函数第 332 行）。上一 turn 用 `TaskCreate`/`TodoWrite` 建了任务（如 taskId 1-6），本 turn adapter 重建、`state.tasks` 清空。本 turn 模型只调 `TaskUpdate(taskId=6)` 而不再重建任务列表，于是 `taskId(6) <= state.tasks.length(0)` 为 false，**静默跳过，不 emit `todo.update`**，胶囊卡片永不更新。

2. **`TaskUpdate` 索引假设过强 + `TaskCreate` 字段单一（次因）**：`taskId` 被当作 1-based 数组下标，越界即丢弃。另外 `TaskCreate` 只读 `subject` 字段（第 808 行），若模型用 `description`/`activeForm`/`content` 作为主字段，任务不入列表，`state.tasks` 不增长，进一步加剧问题 1。

项目文档 `docs/claude-stream-json.md:327-337` 早已记录 TaskCreate/TaskUpdate 是增量操作、需跨 turn 累积，但当前实现没有真正解决跨 turn 状态延续。

## 修复方案（4 个文件）

### 1. `packages/contracts/src/provider.ts` — `StartTurnRequest` 加 `initialTodos` 字段

在 `StartTurnRequest` 接口末尾新增可选字段，让 host 能把上一 turn 持久化的 todos 注入 provider：

```ts
/** Persisted todos from the previous turn(s). The provider seeds its
 *  in-memory task list with these so that incremental TaskUpdate calls
 *  (which reference a 1-based taskId from earlier turns) still resolve
 *  correctly instead of being silently dropped on a fresh adapter. */
initialTodos?: SessionTodoItem[];
```

需要 import `SessionTodoItem` from `./session.js`。类型与 `TodoUpdateEvent["todos"][number]` 完全一致（都是 `{content, status, priority}`），无需转换。

### 2. `apps/desktop/src/main/claude/RuntimeManager.ts` — 填充 `initialTodos`

在 `sendTurn` 第 260-270 行构造 `req` 时加一行：

```ts
initialTodos: session.todos ?? undefined,
```

`sendTurn(session: Session, ...)` 直接接收完整 `Session` 对象，`session.todos: SessionTodoItem[] | null` 在此可用。

### 3. `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts` — 三处改动

**(a) 构造函数接收 `initialTodos`，用作 `state.tasks` 初始值**

构造函数末尾新增参数（带默认值，不破坏已有调用顺序）：
```ts
/** Initial todos seeded from the persisted session state. Lets a fresh
 *  adapter resolve TaskUpdate(taskId=N) from earlier turns instead of
 *  silently dropping it when state.tasks is empty. */
initialTodos: TodoUpdateEvent["todos"] = [],
```

`state.tasks` 初始化从 `[]` 改为 `[...initialTodos]`（第 332 行）。

不 emit 初始 `todo.update`——渲染端 `todosBySession` 本就保留着上一 turn 的值；只有当本 turn 模型实际调用 TaskCreate/TaskUpdate/TodoWrite 时才 emit，避免无谓事件。

**(b) `TaskUpdate` 分支放宽越界处理（第 817-828 行）**

当 `taskId > state.tasks.length` 时，不再静默丢弃，而是用占位项补齐数组到 `taskId` 位置（占位内容 `"Task #N"`），再更新状态并 emit。这样即使 `TaskCreate` 因字段差异没入列表，`TaskUpdate` 仍能生效，用户至少能看到任务被标记完成。

```ts
} else if (b.name === "TaskUpdate") {
  const taskId = Number((b.input)?.taskId);
  const status = readStr((b.input)?.status);
  if (Number.isInteger(taskId) && taskId >= 1) {
    const norm = status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "pending";
    // Pad with placeholder items if taskId exceeds the current list (can
    // happen when TaskCreate used a field name we don't read, or when the
    // list was seeded but the model references a higher id). Better to show
    // a completed placeholder than to silently drop the update.
    while (this.state.tasks.length < taskId) {
      this.state.tasks.push({ content: `Task #${this.state.tasks.length + 1}`, status: "pending", priority: "medium" });
    }
    this.state.tasks[taskId - 1] = { ...this.state.tasks[taskId - 1], status: norm };
    this.ctx.emit({ type: "todo.update", sessionId: this.sessionId, todos: [...this.state.tasks] });
  }
}
```

**(c) `TaskCreate` 分支字段兼容（第 807-816 行）**

除了 `subject`，也接受 `description`/`activeForm`/`content` 作为 content 候选（按优先级回退），避免因模型字段名差异导致任务不入列表：

```ts
} else if (b.name === "TaskCreate") {
  const inp = (b.input ?? {}) as Record<string, unknown>;
  const subject = readStr(inp.subject) ?? readStr(inp.description) ?? readStr(inp.activeForm) ?? readStr(inp.content);
  if (subject) {
    this.state.tasks.push({ content: subject, status: "pending", priority: "medium" });
    this.ctx.emit({ type: "todo.update", sessionId: this.sessionId, todos: [...this.state.tasks] });
  }
}
```

（注：`readStr` 返回 `string | undefined`，需确认其对 undefined/非字符串输入返回 undefined 以支持 `??` 回退——若 `readStr` 对 falsy 返回空串则改用 `||`。实现时确认。）

### 4. `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts` — 传递 `initialTodos`

在第 401-409 行 `new SdkMessageAdapter(...)` 调用末尾加传 `req.initialTodos ?? []`。

## 验证

1. **类型检查**：`cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
2. **场景验证**（手动）：
   - 用 MiniMax-M3 等使用 TaskCreate/TaskUpdate 的模型，turn 1 创建若干任务，turn 2 调 `TaskUpdate(taskId=N, status=completed)`，确认右上角胶囊卡片对应任务变为完成（✓）。
   - 确认 turn 1 结束后、turn 2 开始前，胶囊卡片仍显示已有任务（渲染端 `todosBySession` 保留 + DB 持久化）。
   - 确认使用 TodoWrite 的模型（Claude 默认）行为不受影响——TodoWrite 仍是全量替换语义。
