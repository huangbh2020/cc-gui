## 目标

每轮 turn 结束后,在消息流底部插入一张"本轮文件"卡片,列出本轮被 `Edit` / `Write` 工具改过的文件,每个文件显示 diff(老→新),并提供**一键撤销本轮**按钮——把那些文件从主进程持有的"轮开始前"快照中恢复。参考 Claude Code 的 `/rewind`,但只做最简的"本轮"粒度,不做完整 checkpoint 时间线。

## 关键事实(从代码里确认)

- `Block.tool_use.input` 在 `Edit` 时是 `{ file_path, old_string, new_string }`,`Write` 时是 `{ file_path, content }`(已在前几轮 type-narrow 过,有 `isEditInput` / `isWriteInput` helpers)。
- `tool.result` 事件携带 toolCallId + result(SDK 的 result 折进 `tool_use.result`)。
- `SdkMessageAdapter` 当前在 `tool.use` 事件处直接转发到 renderer,**没有**任何 fs 行为。
- `ClaudeAgentSdkProvider.startTurn` 持有 `req.cwd`,但传给 SDK 的 `Options.cwd`,adapter 自己不知道 cwd。**需要**把 cwd 注入 adapter(新 ctor 参数,或通过 ctx)。
- 已有 `turn.done` event 在 `flushFinal()` 或 `handleResult` 里 emit;**这里**是 hook "本轮结束" 的天然位置。
- `pendingApprovals` 队列已有,但那只是 "等用户批准的工具",与"已执行完成、想撤销"是两件事。本轮是新增的"已批准工具可撤销"维度。
- `node:fs/promises` 还没在 main 进程用过,需引入做 read/write/unlink。

## 数据流

```
[每轮开始] SDK 启动 query()
[轮中] tool.use(Edit) ─┐
       tool.use(Write)─┤  → SdkMessageAdapter 拦截,先 fs.readFile(cwd+file_path),
                         │    存进 per-turn Map<file_path, originalContent>;
                         │    然后照常 emit tool.use 给 renderer
[轮结束] result 事件 → SdkMessageAdapter 冻结 snapshot,emit `turn.files` 给 renderer
[renderer] 收到 turn.files,set turnFilesBySession[sid] = [...]

[用户点 "撤销本轮"]
  renderer → claude.rewindTurn({ sessionId })
  main:  对每个 file_path:
           - if snapshot was "existed" → fs.writeFile(cwd+file_path, originalContent)
           - if snapshot was "didn't exist" → fs.unlink(cwd+file_path)
         emit `turn.rewound` event
  renderer: 收到 turn.rewound,清空 turnFilesBySession[sid]

[新轮开始] 清掉上一轮的 snapshot(每个新 adapter 实例自带空 Map)
```

## 改动清单

### 1. `packages/contracts/src/runtime.ts` — 新 event 类型

```ts
/** Emitted at end of a turn listing the files Edit/Write touched in that
 *  turn, with the pre-turn existence flag so renderer can decide how to
 *  show "created" vs "modified" and so main knows whether to unlink vs
 *  write on restore. The actual original content lives only in main
 *  (never crosses the IPC boundary) — renderer only needs the paths. */
export interface TurnFilesEvent {
  type: "turn.files";
  sessionId: string;
  files: Array<{ filePath: string; kind: "modified" | "created" }>;
}

/** Emitted after the renderer-initiated rewind completes; renderer
 *  clears its local turnFilesBySession on receipt. */
export interface TurnRewoundEvent {
  type: "turn.rewound";
  sessionId: string;
  files: string[]; // paths that were restored
}
```
- 加到 `RuntimeEvent` 联合。

### 2. `packages/contracts/src/ipc.ts` — 新 IPC

- `RewindTurnSchema = z.object({ sessionId: z.string() })`
- 加到 `IPC` 常量:`CLAUDE_REWIND_TURN`
- 加到 RPC 类型表

### 3. `apps/desktop/src/main/lib/fileSnapshot.ts` — **新文件**

**用途**:per-turn 的 file snapshot 容器 + fs 操作。`FileSnapshot` 类:
```ts
class FileSnapshot {
  // file_path (cwd-relative, 用 SDK 传来的 path,不 normalize) → 原始内容
  // 缺失表示文件原本不存在(Write 创建);snapshotTaken: true 表示已读到
  private originals = new Map<string, { exists: boolean; content: string }>();

  /** Read the file BEFORE the model touches it. Called by SdkMessageAdapter
   *  when it sees Edit/Write tool_use. If the read fails (file missing),
   *  record { exists: false }; this signals "created" so rewind can unlink. */
  async recordPre(cwd: string, filePath: string): Promise<void> { ... }

  /** Freeze + return the set of paths that were recorded. */
  freeze(): Array<{ filePath: string; kind: "modified" | "created" }> { ... }

  /** Restore all snapshotted files. Returns the list of restored paths. */
  async restore(cwd: string): Promise<string[]> { ... }

  clear(): void { ... }
}
```
- 走 `node:fs/promises`(`readFile` / `writeFile` / `unlink`)。
- cwd-relative path resolution:`path.resolve(cwd, filePath)` 兜底(防止 Claude 传绝对路径时双重拼接)。
- `recordPre` 静默吞 read 错误(ENOENT → `exists: false`;其他错误 → log + 跳过该文件,不当 crash)。
- `restore` 写回时父目录不存在则 mkdir -p 兜底(防止用户在 Edit 之间删了目录)。
- 一个 adapter 一个实例,`flushFinal` 之前调用 freeze + emit,freeze 后清空 `originals` 防止内存泄漏(本轮结束不再需要)。

### 4. `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts` — 改

- ctor 加 `cwd: string` 参数(从 `req.cwd` 传)。
- ctor 加 `snapshots: FileSnapshot` 实例。
- `handleAssistant` 里 tool_use 分支,遇到 `b.name === "Edit" || b.name === "Write"`:
  - 提取 `file_path`(已知 string)
  - 调 `this.snapshots.recordPre(this.cwd, filePath)`(fire-and-forget — 失败不影响事件流)
  - 然后照常 emit `tool.use`
- `flushFinal` (turn 结束) 里:
  - `const files = this.snapshots.freeze()`
  - 如果 `files.length > 0`,emit `turn.files` 事件
  - 已有 `turn.done` emit 保持不变
- `handleResult` 不需要改(result 走 flushFinal 的兜底已经会触发)。

### 5. `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts` — 改

- `new SdkMessageAdapter(...)` 调用处多传一个 `cwd: req.cwd`。
- 不持有 snapshot 本体(adapter 内部管)。

### 6. `apps/desktop/src/main/ipc/claude.ts` — 加 handler

```ts
ipcMain.handle(IPC.CLAUDE_REWIND_TURN, async (_evt, raw) => {
  const input = RewindTurnSchema.parse(raw);
  const restored = runtimeManager.rewindTurn(input.sessionId);
  // 返回 path 列表(同步,fs 操作在 main 里 promise + await),renderer 等到结果再清 store
  return { restored };
});
```

### 7. `apps/desktop/src/main/claude/RuntimeManager.ts` — 加 `rewindTurn` 方法

- 维护一个 `sessionId → FileSnapshot` 映射(每个 session 一个,跨 turn 复用)
- `bindSession(session)` 时如果还没建,新建一个
- `sendTurn(...)` 之前把 session 当前的 snapshot **clear**()——新轮从干净 snapshot 开始
- 增 `rewindTurn(sessionId)`:找到该 session 的 snapshot,调 restore,返回 paths
- `disposeSession(sessionId)` 时 delete 该 entry(防泄漏)

### 8. `apps/desktop/src/renderer/stores/sessionStore.ts` — 改

**a. 加 state 字段**:
```ts
turnFiles: TurnFileEntry[]; // per active session — most recent turn only
type TurnFileEntry = { filePath: string; kind: "modified" | "created" };
```

**b. `ingestEvent` 加两个 case**:
- `turn.files`: set `turnFiles = e.files`(新轮覆盖旧的——single-slot 模式)
- `turn.rewound`: set `turnFiles = []`,并 push 一条 system message "{N} 个文件已恢复" 给消息流留痕

**c. `selectSession` 里清**:`turnFiles: []`(切 session 不串)

**d. 新增 action**:
```ts
rewindTurn: () => Promise<void>;
```
- 调 `api.claude.rewindTurn({ sessionId: get().activeSessionId! })`
- 失败 console.error,不动 store(让用户重试)

### 9. `apps/desktop/src/renderer/components/chat/TurnFilesCard.tsx` — **新文件**

- props:`{ files: TurnFileEntry[], onRewind: () => void }`
- amber 主题(与 ApprovalPrompt 区分:ApprovalPrompt 是 `border-warning`,TurnFilesCard 是 `border-accent/40`,因为"已完成"≠"待批准")
- 顶行:`📝 本轮修改了 N 个文件` + `▸ 展开/▾ 收起`
- 展开后:
  - 每个文件一行:`✎/🆕` icon + `file_path`(`🆕` 表示 `kind === 'created'`)
  - 点单文件 → **复用** `EditToolCard` / `WriteToolCard` 的 diff 渲染——但**这里的 diff 需要 old content**,从哪儿来?**没有**跨 IPC,所以此处只显示文件名 + `kind`,**不**显示 diff。
  - 实际 diff 用户已经在消息流里那张 EditToolCard / WriteToolCard 看过,不需要重复
  - 底部右侧:`撤销本轮` 按钮(主操作)+ 收起按钮
- 默认**展开**(用户刚点完 turn,想立刻看到结果),再次打开会保持收起(本地 state)
- 关键:在 ChatPane 消息流底部 `<MessageRow>` 之后渲染 `<TurnFilesCard>`,只在 `turnFiles.length > 0` 时显示

### 10. `apps/desktop/src/renderer/components/chat/ChatPane.tsx` — 改

- 拿 `turnFiles` + `rewindTurn` + `rewinding` loading state
- 消息流列表下方:
```tsx
{messages.map(m => <MessageRow ... />)}
{turnFiles.length > 0 && (
  <TurnFilesCard files={turnFiles} onRewind={rewindTurn} />
)}
```
- rewind 时按钮 disabled + 显示"撤销中…"

### 11. `apps/desktop/src/preload/index.ts` + `apps/desktop/src/renderer/lib/api.ts` — 加 `claude.rewindTurn`

- 与现有 `claude.approve` 同款:`ipcRenderer.invoke(IPC.CLAUDE_REWIND_TURN, input)`

## 不做(刻意不做)

- **不**做完整 checkpoint timeline(那属于 P5 roadmap 的"checkpoint 时间线",需要 store snapshots per turn,UX 完全不同)。本轮就是"最近一轮可撤销"最小可用版。
- **不**做跨轮撤销(撤销完上一轮不能回到倒数第二轮)。需要时再扩展。
- **不**做 partial 撤销(只撤销部分文件)。用户选了"一键恢复本轮所有文件"。
- **不**在 TurnFilesCard 里显示 diff。`EditToolCard` 已经在消息流里显示了那个 diff,TurnFilesCard 只是入口和"撤销"动作。
- **不**撤销 Bash 工具对文件的副作用(Mkdir/Rm 等通过 Bash 走的)。理由:这些走的不是 Edit/Write 工具,我们的快照机制不覆盖。属于"超出 Edit/Write 工具模型"的范围。
- **不**做 git 集成检查(不调 `git status` / 不读 .git)。Roadmap 上 P4 有 git,本轮先纯 fs 快照。
- **不**做 atomic restore(restore 中途失败不回滚)。失败时 console.error 让用户知道哪些成功哪些没成功(IPC 返回值带每个 file 的成功/失败状态)。

## 边界处理

- **file_path 是绝对路径**:`path.resolve(cwd, filePath)` 兜底,避免双重根
- **路径穿越**(`../../etc/passwd`):用 `path.resolve` 后白名单必须以 `cwd` 开头,否则拒绝 restore(防恶意 prompt 让 claude 改系统文件)
- **Read-only 文件**:`writeFile` 仍会成功(我们有 fs 权限),不挡
- **文件被 claude 创建(原不存在)**:`unlink` 即可
- **连续 turn 改同一文件**:turn 2 起点已经是 turn 1 改后的内容;snapshot 在 `sendTurn` 前 clear,所以 turn 2 看到的是 turn 1 结束时的内容。**符合预期**。
- **用户点撤销,正在新 turn 中**:renderer 端 `inputBlocked = isRunning || !!headApproval || rewinding` 期间,turnFilesCard 仍可点(不属于 "block input"),但 rewind 期间 disabled 防双击。
- **new file → 撤销 → 用户在外部 git 重新创建同名文件**:我们 unlink 会删用户的版本。属于 race,用户操作优先级低,可接受。

## 验证

1. `cd apps/desktop && npx tsc --noEmit` — 0 错
2. 视觉代码层验证:
   - turn 改了 0 个文件 → 没卡片
   - turn 改了 1 个文件 → 还是没卡片(单文件不入卡,避免 noise;消息流里 EditToolCard 已经是入口)
   - turn 改了 ≥ 2 个文件 → 出现卡片,默认展开
   - 卡片底部"撤销本轮"按钮 → click 后文件恢复,卡片消失,消息流末尾出现 "N 个文件已恢复" system 提示
3. 边界:
   - 跨 session 切:turnFiles 清零
   - turn 1 改 → turn 2 改 → 撤销:撤销的是 turn 2 的 snapshot
   - 改一个文件两次(Edit 同一 file_path 两次):snapshot 只有一份(用 cwd-relative key 去重)
   - 路径绝对/相对/穿越:resolve 后白名单检查生效

## 文件改动清单

| 文件 | 性质 |
|---|---|
| `packages/contracts/src/runtime.ts` | 改(加 `TurnFilesEvent` / `TurnRewoundEvent`) |
| `packages/contracts/src/ipc.ts` | 改(加 `RewindTurnSchema` + IPC 常量 + RPC) |
| `apps/desktop/src/main/lib/fileSnapshot.ts` | **新文件** |
| `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts` | 改(加 cwd + snapshot 拦截 Edit/Write,flushFinal emit turn.files) |
| `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts` | 改(传 cwd 给 adapter) |
| `apps/desktop/src/main/claude/RuntimeManager.ts` | 改(per-session FileSnapshot 映射 + rewindTurn 方法 + sendTurn 前 clear) |
| `apps/desktop/src/main/ipc/claude.ts` | 改(CLAUDE_REWIND_TURN handler) |
| `apps/desktop/src/preload/index.ts` | 改(白名单 rewindTurn) |
| `apps/desktop/src/renderer/lib/api.ts` | 改(加 claude.rewindTurn) |
| `apps/desktop/src/renderer/stores/sessionStore.ts` | 改(state + ingestEvent cases + action) |
| `apps/desktop/src/renderer/components/chat/TurnFilesCard.tsx` | **新文件** |
| `apps/desktop/src/renderer/components/chat/ChatPane.tsx` | 改(挂载 TurnFilesCard) |
