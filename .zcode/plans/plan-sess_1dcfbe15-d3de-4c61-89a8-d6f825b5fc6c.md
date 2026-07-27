# my-claude-gui 重构计划：迁移到 Claude Agent SDK + 多 Provider 抽象层

## 一、设计原则与契约边界

**核心洞察**（来自代码调研）：项目设计之初在 `runtime.ts:3-5` 就写明 *"the ClaudeAdapter translates raw NDJSON into these"* —— `RuntimeEvent` 联合本来就是 provider 中立的归一化目标。前端 store 的 `ingestEvent`、IPC 的 `RpcMap`、SQLite 的 `Block[]` 持久化格式，**全部依赖 `RuntimeEvent` 而非 claude 的原始协议**。

因此本次重构的边界纪律：

| 层 | 是否改动 | 原因 |
|----|---------|------|
| `RuntimeEvent` 联合（11 个变体） | **不改** | 前端渲染契约 + 持久化契约（已落盘的 `Block[]` 依赖其字段） |
| 前端 store / hook / 渲染组件 | **基本不改** | 只依赖 `RuntimeEvent`，不感知 provider |
| IPC `RpcMap`（`startSession/sendTurn/interrupt`） | **不改签名** | 只新增 provider 相关通道 |
| `RuntimeManager` 外部行为 | **不改**（内部换实现） | 它已是天然替换边界 |
| `ClaudeRuntime.ts` / `ClaudePathResolver.ts` | **删除/重写** | CLI 专有逻辑，迁入新的 provider 目录 |
| 新增 `AgentProvider` 契约 + `ClaudeAgentSdkProvider` | **新建** | 本次核心交付 |

> 失去 Max 订阅、走 `ANTHROPIC_API_KEY`、安装包变大是已知 trade-off（调研已确认 SDK 内部仍 spawn 打包的二进制）。但换来：原生 `canUseTool`（解决 P3 审批死结）、结构化 `SDKMessage`（干掉坏行解析）、自带二进制（删除 `ClaudePathResolver` 全部跨平台 hack）、generator 语义（干掉 turn 结束判定兜底）。

---

## 二、目标架构

```
Renderer (React)
    ↕  IPC (RpcMap 不变 + 新增 provider.* 通道)
Main (Node.js)
  ┌─────────────────────────────────────────────┐
  │ RuntimeManager  (持 ProviderRegistry)        │
  │   按 session.providerId 取 provider          │
  │       ↓                                      │
  │   AgentProvider.startTurn(req, ctx)          │
  │       ↓                                      │  ← provider 中立接口
  │ ┌──────────────┐  ┌──────────────────────┐  │
  │ │ ClaudeSdk    │  │ CodexProvider (将来)  │  │
  │ │ Provider     │  │ GeminiProvider(将来)  │  │
  │ │ ↓ query()    │  │ ...                  │  │
  │ │ SDKMessage   │  │                      │  │
  │ │ →RuntimeEvent│  │                      │  │
  │ └──────────────┘  └──────────────────────┘  │
  │   SessionManager / SQLite (sql.js, 不变)     │
  └─────────────────────────────────────────────┘
```

---

## 三、新增：Provider 抽象契约层

**新文件**：`packages/contracts/src/provider.ts`

这是本次重构的核心契约，provider 中立、面向未来扩展。接口骨架：

```typescript
import type { RuntimeEvent, PermissionMode, EffortLevel } from "./runtime.js";

/** 每个 provider 声明自己的能力，供能力协商。 */
export interface ProviderCapabilities {
  supportsApproval: boolean;     // 是否能事中拦截工具审批
  supportsResume: boolean;       // 是否支持跨 turn 续传
  supportsStreaming: boolean;    // 是否支持 token 级增量
  supportsMcp: boolean;
  supportsAskUserQuestion: boolean;
}

/** 启动一轮对话的入参（等价当前 TurnRequest，但 provider 中立）。 */
export interface StartTurnRequest {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /** provider 自己的会话 id（claude 的 session_id），用于续传。null = 首次。 */
  resumeProviderSessionId?: string | null;
}

/** provider 反向调用宿主能力的回调（审批、回答、事件透传）。 */
export interface ProviderContext {
  /** 工具审批请求。provider 内部把 SDK 的 canUseTool 转译成这个调用。 */
  requestApproval?(req: {
    requestId: string;       // 由 provider 生成，用于关联决定
    toolName: string;
    input: unknown;
    description?: string;
  }): Promise<{ allow: boolean; updatedInput?: unknown; reason?: string }>;

  /** 用户输入请求（AskUserQuestion 等结构化提问）。 */
  requestUserInput?(req: {
    requestId: string;
    questions: import("./runtime.js").AskUserQuestionItem[];
  }): Promise<{ answers: string }>;  // 拼好的文本，作为下一轮 prompt

  /** 捕获 provider 自己的 session id（用于持久化 + 续传）。 */
  onProviderSessionId?(id: string): void;

  /** 透传归一化事件给 UI。provider 只管 emit RuntimeEvent。 */
  emit(e: RuntimeEvent): void;

  /** 日志通道。 */
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

/** 一轮对话的控制句柄（等价当前 runTurn 的 Promise + interrupt）。 */
export interface TurnHandle {
  /** turn 结束时 resolve（无论正常/中断/出错）。 */
  done: Promise<void>;
  interrupt(): void;
  isRunning(): boolean;
}

/** 所有 provider 实现这个接口。 */
export interface AgentProvider {
  readonly id: string;                  // "claude-sdk" | "codex" | ...
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** 启动一轮对话。返回事件流控制句柄，事件经 ctx.emit 流出。 */
  startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle>;
  /** 可选：健康检查/版本探测（给设置页用）。 */
  healthCheck?(): Promise<{ ok: boolean; version?: string; error?: string }>;
}
```

设计要点：
- **`ProviderContext` 把宿主能力反向注入** provider：审批和用户输入由宿主（经 IPC 桥到 renderer）实现，provider 不直接碰 IPC。这让 provider 可在无 Electron 环境下测试。
- **`requestApproval` / `requestUserInput` 是 async**，天然匹配 SDK 的 `canUseTool` 回调语义——provider 在回调里 `await`，宿主在另一端 emit `approval.request`/`question.ask` 事件并等用户决定。
- **`AskUserQuestion` 走 `requestUserInput` 而非 `requestApproval`**：语义不同（提问 vs 审批），分开避免 UI 混淆。

**修改**：`packages/contracts/src/index.ts` 导出新模块。

---

## 四、新增：Claude SDK Provider 实现

**新目录**：`apps/desktop/src/main/providers/claude-sdk/`

### 4.1 `SdkMessageAdapter.ts`（归一化器，纯函数，可单测）

把 `SDKMessage` → `RuntimeEvent`。**逻辑等价于当前 `ClaudeRuntime` 的 5 个 handler**（`handleSystem/handleStreamEvent/handleAssistant/handleUser/handleResult`），但输入是结构化对象而非裸 JSON 字符串。关键映射：

| SDKMessage | → RuntimeEvent | 备注 |
|-----------|----------------|------|
| `system` (subtype=init) + `session_id` | `ctx.onProviderSessionId(sid)` | 不 emit，走回调 |
| `stream_event` content_block_delta (text_delta) | `text.delta` | 按 block index 维护 messageId map（保留当前 `blockMessageIds` 机制） |
| `stream_event` content_block_delta (thinking_delta) | `thinking` | 同上 |
| `assistant` message + tool_use block | `tool.use` | `emittedToolUse` 去重 |
| `assistant` + AskUserQuestion 工具 | `ctx.requestUserInput(...)` | **不 emit question.ask**，走回调（见 §6） |
| `assistant` + TaskCreate/TaskUpdate | `todo.update` | 保留当前累积逻辑 |
| `user` + tool_result | `tool.result` | 按 tool_use_id 关联 |
| `result` + usage/total_cost_usd | `usage` | |
| `result` + stop_reason | `turn.done` | |
| generator 正常结束但无 result | 合成 `turn.done`(reason=interrupted) | 保留当前 close 兜底语义 |

> **保留当前 `messageId` 策略**：每个 content block 一个独立 UUID（前端依赖此行为做累积归属）。`SdkMessageAdapter` 持 `blockMessageIds: Map<number, string>` 状态。

### 4.2 `ClaudeAgentSdkProvider.ts`（实现 `AgentProvider`）

```typescript
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider, TurnHandle, StartTurnRequest, ProviderContext } from "@contracts/provider";
import { SdkMessageAdapter } from "./SdkMessageAdapter.js";

export class ClaudeAgentSdkProvider implements AgentProvider {
  readonly id = "claude-sdk";
  readonly displayName = "Claude (Agent SDK)";
  readonly capabilities = {
    supportsApproval: true, supportsResume: true,
    supportsStreaming: true, supportsMcp: true, supportsAskUserQuestion: true,
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const ac = new AbortController();
    const adapter = new SdkMessageAdapter(ctx, req.sessionId);

    const options: Options = {
      abortController: ac,
      cwd: req.cwd,
      model: req.model,
      permissionMode: req.permissionMode,   // SDK 接受 default|plan|acceptEdits|...
      resume: req.resumeProviderSessionId ?? undefined,
      includePartialMessages: true,         // 对应当前 --include-partial-messages
      // 审批桥：把 provider 中立的 requestApproval 转译成 SDK 的 canUseTool
      canUseTool: ctx.requestApproval
        ? async (toolName, input) => {
            const r = await ctx.requestApproval({
              requestId: crypto.randomUUID(),
              toolName, input,
            });
            return r.allow
              ? { behavior: "allow", updatedInput: r.updatedInput ?? input }
              : { behavior: "deny", message: r.reason ?? "Denied by user" };
          }
        : undefined,
      // AskUserQuestion 桥：拦截该工具，转 requestUserInput
      // （canUseTool 里识别 toolName === "AskUserQuestion" 时走 requestUserInput 分支）
    };

    const q = query({ prompt: req.prompt, options });

    const done = (async () => {
      try {
        for await (const m of q) adapter.dispatch(m);
        adapter.flushFinal();  // 兜底 turn.done
      } catch (err) {
        ctx.emit({ type: "error", sessionId: req.sessionId, message: String(err), code: "SDK_ERROR" });
        ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "error" });
      }
    })();

    return {
      done,
      interrupt: () => ac.abort(),
      isRunning: () => !ac.signal.aborted,
    };
  }

  async healthCheck() { /* 探测 SDK 版本 + 二进制可用性 */ }
}
```

### 4.3 AskUserQuestion 的处理（关键决策）

当前 `ClaudeRuntime` 用 `QuestionSentinelScanner`（约 140 行）从文本流拦截 sentinel JSON，因为环境无原生工具。迁移后：
- **主路径**：`canUseTool` 里识别 `toolName === "AskUserQuestion"`，转 `ctx.requestUserInput`，emit `question.ask` 事件 + 等用户回答。**删除 sentinel hack**。
- **兜底**：若探测到底层模型/proxy 仍不暴露该工具（capabilities 协商），保留一个**精简版** sentinel 扫描器作为 `SdkMessageAdapter` 的可选预处理。但这部分代码从 `ClaudeRuntime` 搬过来时简化，只保留最小必要逻辑，并加注释说明"仅在 AskUserQuestion 工具不可用时生效"。

---

## 五、Provider 注册表与 RuntimeManager 改造

### 5.1 **新文件**：`apps/desktop/src/main/providers/registry.ts`

```typescript
import type { AgentProvider } from "@contracts/provider";
import { ClaudeAgentSdkProvider } from "./claude-sdk/ClaudeAgentSdkProvider.js";

class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();
  register(p: AgentProvider) { this.providers.set(p.id, p); }
  get(id: string) { return this.providers.get(id) ?? this.default; }
  list() { return [...this.providers.values()]; }
  get default(): AgentProvider { return this.providers.get("claude-sdk")!; }
}
export const providerRegistry = new ProviderRegistry();
providerRegistry.register(new ClaudeAgentSdkProvider());
```

### 5.2 **改造**：`RuntimeManager.ts`

- 删除 `import { ClaudeRuntime }`，改持 `providerRegistry`。
- `SessionRuntime` 字段从 `runtime: ClaudeRuntime` 改为 `handle?: TurnHandle` + `providerId: string`。
- `bindSession`：不再 `new ClaudeRuntime(...)`，改为记录 `session.providerId`，构造一个**长期存活**的 `ProviderContext`（绑定该 session 的 `emit`、`requestApproval`、`requestUserInput`、`onProviderSessionId`）。
- `sendTurn`：`const provider = providerRegistry.get(session.providerId); const handle = await provider.startTurn(req, ctx); this.handles.set(sessionId, handle)`。
- `interrupt`：`handle.interrupt()`。
- `dispose`：`handle.interrupt()` + 清理。

> **关键**：`ProviderContext` 的 `emit` 闭包结构与现在 `RuntimeManager.bindSession` 里的完全一致（都是 `sendToRenderer(IPC.CLAUDE_EVENT, ...)`），只是多了 `requestApproval`/`requestUserInput` 两个 async 方法——它们桥接 IPC（见 §6）。

---

## 六、审批与用户输入的 IPC 桥接（P3 提前打通）

这是 SDK 迁移的最大收益，需要跨 main↔renderer 的 async 往返。

### 6.1 main 侧：pending 请求表

**新文件**：`apps/desktop/src/main/claude/ApprovalBridge.ts`

`ProviderContext.requestApproval` 的实现：生成 `requestId` → 存入 `Map<requestId, {resolve, reject}>` → emit `approval.request` 事件（带 requestId）→ `await` promise。renderer 侧 `claude.approve` IPC handler 拿到决定后 `resolve`。

```typescript
class ApprovalBridge {
  private pending = new Map<string, {resolve:(v:any)=>void; reject:(e:any)=>void}>();
  request(ctx: {emit; sessionId}): (req) => Promise<...> {
    return (req) => new Promise((resolve, reject) => {
      this.pending.set(req.requestId, {resolve, reject});
      ctx.emit({ type:"approval.request", sessionId, requestId:req.requestId,
                 toolCallId:req.requestId, toolName:req.toolName, input:req.input, description:req.description });
    });
  }
  resolve(requestId, decision) { this.pending.get(requestId)?.resolve(decision); this.pending.delete(requestId); }
  rejectAll(sessionId) { /* 中断时拒绝所有 pending */ }
}
```

`requestUserInput` 同构，复用现有 `question.ask` 事件（带 requestId 扩展）。

### 6.2 修改：`main/ipc/claude.ts` 的 `CLAUDE_APPROVE` handler

从空壳改为：`approvalBridge.resolve(input.requestId, { allow: input.granted })`。

### 6.3 contracts 微调（可选，向后兼容）

- `ApprovalRequestEvent` 已有 `requestId` 字段，**够用，不改**。
- `AskUserQuestionEvent` 加可选 `requestId?: string` 字段（用于关联回答），前端旧逻辑不受影响。
- `ApproveSchema` 已有 `requestId/granted/always`，**够用**。

---

## 七、文件改动清单

### 新增（7 个）
1. `packages/contracts/src/provider.ts` — AgentProvider 契约
2. `apps/desktop/src/main/providers/registry.ts` — ProviderRegistry
3. `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts`
4. `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts`
5. `apps/desktop/src/main/providers/claude-sdk/index.ts` — barrel
6. `apps/desktop/src/main/claude/ApprovalBridge.ts` — 审批/提问的 IPC 桥
7. `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.test.ts` — 归一化单测（可选但推荐）

### 删除（3 个）
1. `apps/desktop/src/main/claude/ClaudeRuntime.ts` — 逻辑迁入 provider
2. `apps/desktop/src/main/claude/ClaudePathResolver.ts` — SDK 自带二进制，整个删除
3. （`store/memoryStore.ts` 已不存在，无需处理）

### 改造（核心，约 6 个）
1. `packages/contracts/src/session.ts` — `Session` 加 `providerId: string` 字段（默认 `"claude-sdk"`，向后兼容）
2. `packages/contracts/src/ipc.ts` — `StartSessionSchema` 加 `providerId` 可选字段；新增 `provider.list` RPC（返回 `{id, displayName, capabilities}[]`）；`CLAUDE_PATH_SETTING_KEY` 相关可保留但标记 deprecated
3. `apps/desktop/src/main/claude/RuntimeManager.ts` — 持 registry，按 providerId 取 provider，构造 ProviderContext
4. `apps/desktop/src/main/store/repositories.ts` — sessions 表加 `provider_id` 列（`addColumnIfMissing`，向后兼容）；`Session` 映射加该字段
5. `apps/desktop/src/main/ipc/claude.ts` — `CLAUDE_START_SESSION` 写入 providerId；`CLAUDE_APPROVE` 接 ApprovalBridge；新增 `provider.list` handler；`CLAUDE_TEST_PATH` 改为调 `provider.healthCheck()`
6. `apps/desktop/src/preload/index.ts` — 暴露 `api.provider.list()`；`claudeHealthCheck`/`testClaudePath` 改语义或标记 deprecated

### 基本不动（前端）
1. `sessionStore.ts` — `ingestEvent` 完全不改（RuntimeEvent 不变）
2. `useClaudeEvents.ts` — 不改
3. `ChatPane.tsx` / `MessageBlocks.tsx` / `QuestionPrompt.tsx` — 不改
4. `App.tsx` / 布局组件 — 不改

> 前端唯一可能的小改：设置页的"claude 路径配置"区块改为"provider 状态显示"（可选，放最后）。

---

## 八、分阶段实施（每阶段可独立验证）

### 阶段 0：依赖与环境（0.5 天）
1. `pnpm add @anthropic-ai/claude-agent-sdk`（工作区根或 apps/desktop）
2. 验证 SDK 在 Electron main 进程能正常 import + spawn 其打包二进制
3. 配置 `ANTHROPIC_API_KEY`（.env 或设置项）
4. **验收**：写一个 5 行的脚本 `query({prompt:"hi"})` 能跑通

### 阶段 1：契约层（0.5 天）
1. 新建 `packages/contracts/src/provider.ts`
2. `session.ts` 加 `providerId` 字段
3. `ipc.ts` 加 `providerId` 到 StartSessionSchema、新增 `provider.list`
4. **验收**：`npx tsc --noEmit` 通过；契约层无运行时逻辑

### 阶段 2：Provider 实现层（1.5 天）— 核心
1. 写 `SdkMessageAdapter.ts`（从 `ClaudeRuntime` 搬运归一化逻辑，输入换成 SDKMessage）
2. 写 `ClaudeAgentSdkProvider.ts`
3. 写 `registry.ts`
4. **验收**：`SdkMessageAdapter.test.ts` 单测——喂几条真实 `SDKMessage` 样本，断言 emit 出正确的 `RuntimeEvent` 序列（复用 `docs/claude-stream-json.md` 里的真实 dump 作为测试数据）

### 阶段 3：RuntimeManager + ApprovalBridge 接线（1 天）
1. 改造 `RuntimeManager`：持 registry、构造 ProviderContext、`sendTurn` 调 `provider.startTurn`
2. 写 `ApprovalBridge.ts`
3. 改 `ipc/claude.ts`：`CLAUDE_APPROVE` 接桥、新增 `provider.list`
4. **验收**：`pnpm dev`，发一条消息能流式渲染 text/thinking/tool_use；`--resume` 续传生效（首 turn 后 SQLite 有 `claude_session_id`）

### 阶段 4：清理与审批 UI（1 天）
1. 删除 `ClaudeRuntime.ts`、`ClaudePathResolver.ts`
2. 删除/精简 `QuestionSentinelScanner`（若 AskUserQuestion 工具可用则全删）
3. 改 `repositories.ts` 加 `provider_id` 列
4. preload 暴露 `api.provider.list()`
5. （可选）ChatPane 加最简审批条：收到 `approval.request` 显示 [允许]/[拒绝]，点完调 `api.claude.approve`
6. **验收**：端到端——发一个需要工具的消息（如"创建文件"），审批条弹出，拒绝后 claude 收到 deny 消息；AskUserQuestion 提问正常弹出

### 阶段 5：文档与收尾（0.5 天）
1. 更新 `AGENTS.md`：进程架构图改为 provider 架构；目录地图加 `providers/`
2. 更新 `docs/tech-stack.md`：§5.1 选型决策加 SDK trade-off；第八节进度表 P3 标 ✅
3. 更新 `docs/claude-stream-json.md`：加注"SDK 模式下 SDKMessage 与此一致，但经由类型化对象传入"
4. **验收**：`npx tsc --noEmit` + `pnpm build` 全绿

**总工期预估：4-5 天**（不含前端审批 UI 打磨）

---

## 九、验收标准（Definition of Done）

1. **功能等价**：现有所有交互（发消息、流式渲染、中断、续传、持久化、AskUserQuestion）在 SDK 模式下全部正常
2. **新增能力**：工具审批可事中拦截（`canUseTool` 生效，非事后展示）
3. **扩展性达标**：新增一个 provider 只需（a）实现 `AgentProvider` 接口、（b）`registry.register()` 一行、（c）在 `provider.list` 暴露——**无需改 RuntimeManager / IPC RpcMap / 前端 store / 持久化**
4. **契约稳定**：`RuntimeEvent` 联合零改动；已落盘的 SQLite `Block[]` 历史会话可正常渲染
5. **类型安全**：`npx tsc --noEmit -p tsconfig.json` 全绿，无 `any`

---

## 十、已知风险与缓解

| 风险 | 缓解 |
|------|------|
| SDK 打包的二进制在 Electron 打包后路径异常 | 阶段 0 先验证 `pnpm build` 后 SDK 二进制能被找到；必要时用 `pathToClaudeCodeExecutable` 显式指定 |
| AskUserQuestion 工具在当前 proxy 环境仍不可用 | 保留精简版 sentinel 扫描器作为兜底，capabilities 协商后决定启用哪个路径 |
| `canUseTool` 回调在 subagent 场景有已知 caveat（issue #27203） | 主 agent 路径不受影响；subagent 审批暂不支持，文档标注 |
| sql.js 加 `provider_id` 列的迁移 | 用现有 `addColumnIfMissing` 模式（repositories.ts 已有先例），老库自动加列默认 `"claude-sdk"` |
| 失去 Max 订阅 | 文档明确标注；设置页提示用户配置 `ANTHROPIC_API_KEY` |

---

## 实施顺序确认

按 阶段 0 → 5 顺序执行。**阶段 2（Provider 实现）是核心**，会先把 `SdkMessageAdapter` 和 `ClaudeAgentSdkProvider` 写好并用真实 SDKMessage 单测验证，再去动 RuntimeManager——确保归一化逻辑正确后再接线，降低风险。

是否批准此计划？批准后我将从阶段 0（安装 SDK + 验证环境）开始执行。