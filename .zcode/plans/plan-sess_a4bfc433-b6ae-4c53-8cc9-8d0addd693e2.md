## 问题描述

线程 A 正在运行时,用户手动点击停止按钮,`interrupt()` 正确地把 `runningBySession[A]` 置为 `false`、把 running 子代理降级为 `killed`,发送按钮变回"发送"。但随后:

1. 主进程 `ac.abort()` 展开 generator,触发 `flushFinal()`,它**故意保留** `isBackgrounded` 的 running 子代理,并通过 `flushSubagents()` 发出一个 `subagent.update` 事件(REPLACE 语义),其 roster 里仍含 `status: "running"` 的后台子代理。
2. 这个迟到的事件到达 renderer,`sessionStore.ts:3005` 用 REPLACE 语义直接覆盖,把刚刚被 `interrupt()` 标成 `killed` 的子代理又"复活"成 `running` → `hasRunningSubagents` 再次为 `true`。
3. 紧跟着的 `turn.done`(`reason: "interrupted"`)里有 `hasRunning` 检查(3288 行),看到 running 子代理就**保留** roster 而非清空,把卡死状态固化。
4. 用户切到线程 B 再切回 A,`ChatPaneForSession` 重新挂载、重读 store,`sessionBusy = isRunning || hasRunningSubagents` 为 `true` → 发送按钮又变成"运行中/停止"。

核心问题:**用户的 interrupt 是权威意图,但后续的终端事件(`subagent.update` / `turn.done` interrupt 分支)没有尊重它,反而用 REPLACE 语义覆盖了中断后的状态。**

## 修复方案(最小改动,renderer 层防护)

核心思路:让 `interrupt()` 设置一个 per-session 的"已中断"哨兵,后续到达的 `subagent.update` 和 `turn.done` 在这个哨兵存活期间遵守中断意图——不复活 running 子代理、不保留 running roster。

### 改动文件:`apps/desktop/src/renderer/stores/sessionStore.ts`

#### 1. 新增 per-session 中断哨兵状态

在 State 接口里(`runningTurnStartedAt` 附近,~300 行)新增:
```ts
/** Per-session "user 已手动停止"哨兵。interrupt() 置位,下一个真正启动的
 *  turn (sendPrompt/editAndResendMessage) 清除。存活期间,迟到的
 *  subagent.update / turn.done 不得复活 running 子代理或保留 running roster
 *  —— 用户的中断是权威意图。 */
interruptedBySession: Record<string, boolean>;
```
初始值 `interruptedBySession: {}`(在 ~1750 行的初始化块,挨着 `runningBySession: {}`)。
`deleteSession` 里 delete 该 session 的条目(挨着 `delete runningBySession[id]`,~2508 行)。

#### 2. `interrupt()` 设置哨兵(~2926 行的 set 块)

在 `interrupt()` 的 `set()` 返回对象里增加 `interruptedBySession: { ...s.interruptedBySession, [sessionId]: true }`。其余逻辑(置 `runningBySession=false`、降级 running→killed)不变。

#### 3. 新 turn 启动时清除哨兵

`sendPrompt`(~2762 行)和 `editAndResendMessage`(~2866 行)的 set 块里,在置 `runningBySession[sessionId]=true` 的同时清除 `interruptedBySession[sessionId]`(新 turn 开始,旧中断不再有效)。

#### 4. `subagent.update` 处理尊重中断意图(~3005 行)

将纯 REPLACE 改为:若该 session 已被中断,过滤掉 incoming roster 里的 `running` 条目(降级为 `killed`),避免复活;否则照常 REPLACE。即:
```ts
if (e.type === "subagent.update") {
  set((s) => {
    const agents = s.interruptedBySession[sid]
      ? e.agents.map((a) => (a.status === "running" ? { ...a, status: "killed" as const } : a))
      : e.agents;
    return { subagentsBySession: { ...s.subagentsBySession, [sid]: agents } };
  });
  return;
}
```

#### 5. `turn.done` 的 `hasRunning` 保留分支尊重中断意图(~3282-3340 行)

当前逻辑:`hasRunning` 为真就**保留** roster(`s.subagentsBySession`)。改为:被中断的 session 一律清空 roster(不保留 running 子代理);非中断路径保持原逻辑。即把
```ts
subagentsBySession: hasRunning
  ? s.subagentsBySession
  : { ...s.subagentsBySession, [sid]: [] },
```
改为
```ts
subagentsBySession:
  hasRunning && !s.interruptedBySession[sid]
    ? s.subagentsBySession
    : { ...s.subagentsBySession, [sid]: [] },
```
这样 `reason: "interrupted"` 的 turn.done 会清空 roster,卡死状态不再固化。

> 不在 `turn.done` 里清除哨兵本身——保持它存活到下一个真正 turn 启动时被清掉,这样 `flushFinal` 之后任何更晚到达的 `subagent.update` 也会被同样过滤,彻底堵住"复活"路径。

## 为什么不改主进程 / adapter

- adapter 的"保留 backgrounded running 子代理"行为是有意设计(非中断场景下保持 busy 信号),不能一刀切改掉。
- 在 renderer 层用哨兵收敛,既覆盖 `flushFinal` 的迟到 `subagent.update`,也覆盖 turn 进行中其他 `flushSubagents()` 站点(435/469/492/700/715 行)在中断后竞态到达的情况——单一防护点,语义最清晰。

## 验证

- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 通过(新增字段在 State 接口、初始化、deleteSession、interrupt、sendPrompt、editAndResendMessage、subagent.update、turn.done 八处都要对齐类型)。
- 手动复现:启动一个会 spawn 后台子代理的 turn → 点停止 → 切到别的线程 → 切回来,确认发送按钮是"发送"态、输入框可编辑、tasks capsule 不再有 running 动画。
- 回归:正常 turn 结束(非中断)的子代理完成动画/roster 清理行为不变(哨兵在非中断路径为 false,所有新分支走原逻辑)。
