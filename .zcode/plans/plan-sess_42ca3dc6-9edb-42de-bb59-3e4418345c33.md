# 胶囊状态持久化方案

## 目标
让右上角胶囊的内容（todos / subagents / plan + 已有的 contextSnapshot）落库保存，重开线程时默认加载，运行中实时更新。已有的 `contextSnapshot` 持久化是参考样板，本次补全另外三项。

## 核心链路
```
事件流过 RuntimeManager.emit
  → 转发到 renderer（已有）
  → 持久化到 DB（token-usage.updated 已有，本次补 todo/subagent/plan）  ← 新增
renderer selectSession/openTab
  → 从 session 行水合到 per-session 桶（contextSnapshot 已有，本次补三项）  ← 新增
```

## 改动文件（5 个，完全镜像 contextSnapshot 的既有模式）

### 1. `apps/desktop/src/main/store/db.ts` — 加 3 列
在 `migrate()` 里加 3 个 `addColumnIfMissing`（紧跟现有的 `context_snapshot` 那行）：
```ts
addColumnIfMissing(database, "sessions", "todos", "TEXT");
addColumnIfMissing(database, "sessions", "subagents", "TEXT");
addColumnIfMissing(database, "sessions", "plan_draft", "TEXT");
```
均为 nullable TEXT（JSON 序列化），和 `context_snapshot` 一致。

### 2. `packages/contracts/src/session.ts` — Session 接口加 3 字段
```ts
todos: TodoItem[] | null;
subagents: SubagentSnapshot[] | null;
planDraft: PlanDraft | null;
```
镜像 `contextSnapshot: ContextSnapshot | null`（line 41）。需 import 这三个类型（来自 runtime + store）。

### 3. `apps/desktop/src/main/store/repositories.ts`
- `SessionRow` 加 3 个 snake_case 列（`todos`, `subagents`, `plan_draft`）
- `rowToSession` 加 3 行水合（镜像 line 130 的 `safeJson` 模式）
- `create()` 的 INSERT 列表 + VALUES 补齐 3 列
- 新增 3 个 Repo 方法（镜像 `updateSnapshot` line 203-210）：`updateTodos(id, todos)` / `updateSubagents(id, agents)` / `updatePlanDraft(id, plan)`

### 4. `apps/desktop/src/main/claude/RuntimeManager.ts` — emit hook 补 3 分支
在 `emit` 回调里（line 48-54 区域）现有的 `token-usage.updated` 持久化分支后，加 3 个并列 `if`：
```ts
if (e.type === "todo.update") {
  try { SessionRepo.updateTodos(session.id, e.todos); } catch (err) { log.error(...); }
}
if (e.type === "subagent.update") {
  try { SessionRepo.updateSubagents(session.id, e.agents); } catch (err) { log.error(...); }
}
if (e.type === "plan.update") {
  try { SessionRepo.updatePlanDraft(session.id, { plan: e.plan, phase: e.phase }); } catch (err) { log.error(...); }
}
```
fire-and-forget，每个事件类型 → 一个 Repo 调用。

### 5. `apps/desktop/src/renderer/stores/sessionStore.ts` — 水合逻辑
新增一个合并的 `hydrateCapsule` 辅助函数（镜像已有的 `hydrateContextSnapshot`），从 session 行读取 todos/subagents/planDraft 写入 per-session 桶。在 `selectSession` + `openTab` 里调用（紧跟现有的 `hydrateContextSnapshot` 调用）。

**turn.done 清理逻辑不动** —— 它清理的是渲染端内存状态（给下一个 turn 干净起点），而持久化在事件到达时就已完成，所以重开线程恢复的是最后一次事件的状态。链路自洽：
- subagents/plan 在 turn.done 前的最后一次 `subagent.update`/`plan.update` 已写入 DB
- todos 跨 turn 累积，每次 `todo.update` 都覆盖 DB

## 不需要改动
- `turn.done` 清理（保持现状，它只清内存不碰 DB）
- `deleteSession` 的桶清理（保持现状）
- 胶囊 UI（StatusCapsule 已读取这些桶，水合后自动显示）
- IPC 契约（Session 类型扩展自动通过 `api.project.sessions` 往返）

## 验证
`npx tsc --noEmit` 通过。重启后打开一个之前跑过 todos/subagent/plan 的线程，胶囊应显示上次保存的内容。