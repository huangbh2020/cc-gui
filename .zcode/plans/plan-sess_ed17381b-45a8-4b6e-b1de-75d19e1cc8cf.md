## 目标

把"过程数据(thinking + tool_use)"和"展示数据(text)"在视觉上彻底分开。每个 turn 的过程数据折叠进一个 header 为"开始 HH:MM:SS · 用时 NN.Ns"的面板;text reply 始终可见,渲染在面板之外。点击面板可展开查看过程细节。

## 当前问题(为什么过程数据会"漏出来")

当前 `groupMessagesForRender`(ChatPane.tsx:258-269)只能聚合**整条 message 都是过程性**的消息(`isProceduralMessage`,blocks 全是 thinking/tool_use)。一旦一条 message 里**既有 thinking/tool_use 又有 text**(模型常见模式:边思考边说话、或 text 与 tool 交错),它就被判为非过程性 → 单独成 `single` item → 内部的 thinking/tool_use 经 `MessageBlocks` → `groupBlocks` 在 message 内做段落折叠,但**不会被外层 turn 面板捕获**,过程数据就漏到了主流里,与 text 视觉上没分开。

## 方案:turn 级聚合(在 ChatPane 渲染层重组)

**改动范围**:`ChatPane.tsx`(渲染聚合)+ `MessageBlocks.tsx`(折叠面板组件)。**不改 store、不改 contract、不改数据持久化** —— 纯渲染层重构。改动小、可回退。

### 1. 重新设计 `RenderItem` 类型(ChatPane.tsx:162-184)

引入新的 **`turnGroup`** item 类型,取代当前的 `proceduralCluster`。一个 turnGroup 携带整个 turn 的拆分结果:

```ts
type RenderItem =
  | { kind: "single"; msg: ChatMessage; ... }      // 用户消息、错误气泡(不变)
  | {
      kind: "turnGroup";                            // 一个完整 turn 的重组视图
      procedural: ProceduralBlock[];                // 本 turn 全部 thinking+tool_use(扁平化自所有 message)
      textMsgs: ChatMessage[];                      // 含 text reply 的 message(可见部分)
      turnMeta?: TurnMeta;
      isStreamingTail: boolean;
      isTurnTail: boolean;
    }
  | { kind: "pendingTurn"; turnMeta: TurnMeta };   // 不变
```

### 2. 重写 `groupMessagesForRender`(ChatPane.tsx:225-293)

新算法按 **turn 边界**(而非 message 边界)聚合:

```
遍历 messages:
  - 用户消息 → flush 当前 turn,emit 为 single
  - assistant 消息:
      - 若带 turnMeta(open 的 opener)→ 开启新 turn 桶
      - 把该消息的 thinking/tool_use block 抽进 procedural[]
      - 把该消息的 text/plan/turn-files/error block 保留,但记录这个 message 为 textMsg(连同它剩余的可见 blocks)
  - turnMeta.endedAt 存在或遇到下一条 opener → flush turn 桶为 turnGroup
flush 末尾 turn 桶
```

关键点:
- `procedural[]` 跨 turn 内所有 message 收集(`flattenCluster` 的 turn 级版本)
- text/plan/turn-files 等展示性 block 留在原 message 里,作为 `textMsgs[]` 顺序排列
- Edit 工具(当前特例,内联)纳入 procedural,展开时仍以特殊渲染,但**默认在面板内**

### 3. 渲染 `turnGroup`(ChatPane.tsx:981-999 替换)

```
<div>
  <TurnPanel
    procedural={item.procedural}
    turnMeta={item.turnMeta}
    turnActive={item.isStreamingTail && item.textMsgs.length === 0}
    beforeMap={beforeMap}
    onOpenPlan={...}
  />
  {item.textMsgs.map(msg => <MessageRow msg={msg} ... />)}   // text reply 始终可见
  {item.isStreamingTail && <tail spinner>}
</div>
```

`turnActive` 只在"还在流式且还没出 text"时为 true —— 此时面板默认展开显示实时进度;一旦 text reply 出现,面板转为"已完成"视觉态(即便 turn 还没 done,过程数据已收起,因为用户焦点该转到 text 了)。

### 4. 新增 `TurnPanel` 组件(MessageBlocks.tsx,取代/重构 `ProceduralGroup`)

这是用户要的"开始 xxx 用时 xxx"面板。基于现有 `ProceduralGroup` 改造:

**折叠态 header(单行)**:
```
[状态图标] 开始 14:32:05 · 用时 12.3s  [▾]
```
- 进行中:`IconLoader2` 转 + 实时跳动用时(`useNow`)
- 完成:`IconCheck` + 冻结用时
- 出错:`IconX`
- **header 不再显示步数/工具统计**(用户选择),保持极简

**展开态**:
```
开始 14:32:05 · 用时 12.3s                       [▴]
─────────────────────────────────────────────
  [思考] (collapsible)
  [Bash ×2 · Read ×1] 工具卡(各自可折叠)
  ...
```
- 流式时(`turnActive`)默认展开
- 出现 text reply / turn 完成时自动收起(沿用现有 `useEffect` on `completed` 逻辑,扩展触发条件为 `!turnActive`)
- 内部子 block 渲染复用现有 `BlockView`(thinking → Collapsible,tool → ToolCard)

### 5. 处理边界情况

- **turn 无 text reply**(纯工具调用 turn,如 plan mode / 中断):`textMsgs` 为空,只有 TurnPanel;不额外渲染空消息。
- **turn 内多条 text message**(罕见,模型多次说话):全部保留可见,顺序渲染在面板下方。
- **pendingTurn**(发送后未到 token):不变,仍显示 TurnStatRow + spinner;首个 token 到达后无缝过渡到 turnGroup(共用 `startedAt` 锚点)。
- **plan / turn-files block**:它们是过程产物但需可见审阅,归入 `textMsgs` 阵营,渲染在面板外(与当前行为一致)。
- **历史会话(resume)**:`turnMeta` 已持久化,历史 turn 的面板正确显示冻结用时。

### 6. 清理

- `TurnStatRow`(ChatPane.tsx:118-138)的渲染逻辑合并进 TurnPanel header,不再单独渲染在 turnGroup 上方(否则时间会显示两次)。`pendingTurn` 仍用它。
- `ProceduralGroup` 重构为 `TurnPanel`;`flattenCluster` 升级为 turn 级收集(逻辑几乎相同,只是入参从"连续过程性 message"变成"一个 turn 的所有 message")。
- `isProceduralMessage` 不再需要(不再按整条 message 是否纯过程性来聚合);可删除或保留用于兼容。

## 不做的事

- **不改 store / contract / 持久化**:数据流原样,纯渲染层重组。turn 边界判定复用现有 `turnMeta` 启发式,零风险。
- **不改 Edit 内联特例**:Edit 仍在面板内以 diff 卡渲染(展开时可见),只是不再"破开"面板。
- **不改子 agent 显示**:子 agent 的 SubagentSnapshot 摘要维持现状(那是另一个独立话题)。
- **不引入新的持久化折叠状态**:面板开/合仍是组件局部 `useState`(与当前一致)。

## 验证

- `npx tsc --noEmit -p apps/desktop/tsconfig.json` 类型检查
- 手动测试:发起一个会读文件 + 改文件 + 给文字解释的 turn,确认:进行中面板展开显示工具进度 → 出 text 后自动收起为"开始 xxx 用时 xxx" → 点击展开能看到全部 thinking + tool_use → text reply 始终可见在面板下方
- 历史 turn(resume)面板正确显示冻结用时
- 纯工具 turn(无 text)不显示空消息

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `apps/desktop/src/renderer/components/chat/ChatPane.tsx` | 重写 `groupMessagesForRender` 为 turn 级聚合;新增 `turnGroup` RenderItem;渲染分发;TurnStatRow 仅保留给 pendingTurn |
| `apps/desktop/src/renderer/components/chat/MessageBlocks.tsx` | `ProceduralGroup` 重构为 `TurnPanel`(header 显示开始时间+用时,含展开/收起逻辑) |

预计 ~200-300 行净改动(替换为主,非新增),集中在两个文件。