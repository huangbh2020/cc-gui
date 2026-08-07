# 修复：claude 线程中途 UI 误判为"已停止"（中间 result 提前触发 turn.done）

## 根因

CLI v2.1.198+ 子代理默认后台运行。主 agent 回合结束时，SDK 先发一条**中间 `result`**（usage 全 0），随后再次 `init` 恢复流式。日志铁证：
```
14:50:08.669  SDK init
14:50:08.669  result: success usage全0   ← 中间 result（与 init 同毫秒）
14:50:08.681  SDK init                    ← 12ms 后流式恢复
```

`SdkMessageAdapter.handleResult()` 对这条中间 result 调用 `maybeEmitTurnDone()`。其 gate 检查 `subagents`/`backgroundTaskIds` 是否为空——但中间 result 到达时子代理的 `task_started` 事件还没到，两个集合都是空 → gate 通过 → **提前发出 `turn.done`** → 前端 `runningBySession[sid]=false` → UI 显示停止，但 generator 还在继续（后台仍跑）。

## 修复方案：统一由 `flushFinal()` 发 turn.done

`flushFinal()` 只在 generator 真正结束时调用（`ClaudeAgentSdkProvider.ts:445`），是 turn 结束的唯一可靠信号。中间 result 无论多少条，都不会触发它。

### 改动点（1 个文件）

**`apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts`**

1. **`handleResult()`（约 :1107 / :1116）**：移除对 `maybeEmitTurnDone()` 的调用，只保留 `lastResultReason` 的捕获。result 不再直接结束 turn。
   - success 分支：删掉 `this.maybeEmitTurnDone(reason)`，改为 `this.state.lastResultReason = reason`
   - error 分支：保留 `error` 事件 emit（前端要显示错误），但移除 `maybeEmitTurnDone("error")`，改为 `this.state.lastResultReason = "error"`

2. **`maybeEmitTurnDone()`（约 :1140-1148）**：整个方法删除——不再有"立即发"路径，gate 逻辑（subagents/backgroundTaskIds 判定）随之废弃。

3. **`flushFinal()`（约 :463-465）**：保持不变。它已经用 `lastResultReason ?? "interrupted"` 在 generator 结束时发 turn.done，`emitTurnDone` 内部的 `turnDoneEmitted` guard 保证只发一次。

### 关键属性验证
- **正常 turn（无子代理）**：result → generator 结束 → flushFinal 发 turn.done。延迟 = generator 关闭时间（几十 ms），用户无感。
- **中间 result 场景**：中间 result 只更新 `lastResultReason`，不发 turn.done；流式恢复继续；最终 result 更新 reason；generator 结束 → flushFinal 用最终 reason 发 turn.done。✅
- **用户主动停止（abort）**：generator 抛 AbortError → provider catch → `flushFinal()`（已实现，`:456-457`）→ 用 `lastResultReason ?? "interrupted"` 发 turn.done。✅
- **SDK 错误**：error result 仍 emit `error` 事件（前端显示错误）；generator 结束 → flushFinal 发 turn.done{reason:"error"}。✅
- **双重发送防护**：`emitTurnDone` 的 `turnDoneEmitted` guard 仍在，flushFinal 不会重发。✅

### 不改动
- `background_tasks_changed` / `task_started` 等子代理事件处理逻辑保留（它们仍驱动 `subagent.update` 给前端展示子代理状态胶囊，只是不再用于 turn.done gate）。
- `flushFinal()` 里的子代理 killed/completed 收尾逻辑保留。
- pi provider 无此问题（它的 `turn.done` 只在 `agent_end` 或 catch 里发，不依赖 result），不动。

## 影响面
- 仅改 1 个文件，核心是删代码（移除提前发 turn.done 的路径）。
- 行为变化：turn.done 统一在 generator 结束时发，比原来晚几十 ms（正常场景）/ 修复提前发（中间 result 场景）。
- 类型检查：`npx tsc --noEmit -p tsconfig.json`（删 `maybeEmitTurnDone` 后确认无悬空引用）。

## 验证方式
1. 复现场景：配置 `CLAUDE_CODE_SUBAGENT_MODEL` 的 claude session 发送会触发子代理的任务，观察 UI 是否保持 running 直到真正结束（不再中途解锁）。
2. 正常场景：普通对话 turn 结束后 composer 正常解锁、spinner 消失。
3. 停止按钮：点击停止后 UI 立即解锁、子代理显示"已终止"。