# Claude Code stream-json 数据类型文档

> 本文档记录 `claude` CLI 在 `--output-format stream-json` 模式下的**真实输出格式**。
>
> ⚠️ **所有字段均来自真实 dump,非凭记忆或推测。** 通过对 `claude -p "..." --output-format stream-json --verbose --include-partial-messages` 的实际输出做归类分析得出(测试环境:Windows,Claude Code 2.1.186)。
>
> 这是 my-claude-gui 的 `ClaudeRuntime` 解析器(`apps/desktop/src/main/claude/ClaudeRuntime.ts`)的权威依据。

---

## 一、输出总览

claude 以 **NDJSON**(Newline-Delimited JSON)格式输出:**每行一个完整的 JSON 对象**。

```bash
claude -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages
```

每一行的顶层结构都由 `type` 字段区分种类:

| 顶层 `type` | 含义 | 频率 |
|-------------|------|------|
| `system` | 系统事件(hook / init / status / thinking_tokens / notification) | 多次 |
| `stream_event` | Anthropic 原生 SSE 流式增量(token 级) | **最多** |
| `assistant` | 完整的 assistant 消息(块结束后的快照) | 每轮 1~N |
| `user` | tool_result,包在 user 消息内 | 每次工具调用后 |
| `result` | turn 终结(含 usage / cost) | **每 turn 最后 1 条** |

> **关键认知**:`system` 和 `stream_event` 都带 `subtype` 或内嵌 `event.type`,需要二分。下面分类型详述。

### 一个真实 turn 的消息序列(37 行样例)

```
system/hook_started     ← SessionStart hook 触发
system/hook_response    ← hook 执行结果
system/init             ← 会话元信息(cwd / tools / model)
system/status: requesting   ← claude 正在请求 API
stream_event (message_start)            ┐
stream_event (content_block_start)      │
stream_event (content_block_delta ×N)   │ 思考块流式
stream_event (content_block_stop)       ┘
system/thinking_tokens   ← 思考 token 计数更新
stream_event (content_block_start)      ┐
stream_event (input_json_delta ×N)      │ tool_use 输入流式
stream_event (content_block_stop)       ┘
assistant [content: tool_use]   ← 完整 tool_use 块(读取文件)
user [content: tool_result]     ← 工具返回结果
stream_event (message_start)            ┐
stream_event (content_block_start)      │
stream_event (content_block_delta ×N)   │ 最终文本回答流式
stream_event (content_block_stop)       │
stream_event (message_delta)            │
stream_event (message_stop)             ┘
assistant [content: text]       ← 完整文本消息
system/notification             ← UI 通知(如 stop-hook-error)
result/success                  ← ★ turn 终结
```

---

## 二、`system` 类型(系统事件)

顶层 `type: "system"`,靠 `subtype` 二分。所有 system 行都带 `session_id` 和 `uuid`。

### 2.1 `system/init` — 会话初始化(重要)

turn 开始时发出,携带会话的完整能力描述。

```jsonc
{
  "type": "system",
  "subtype": "init",
  "cwd": "D:\\00-huangbh-project\\my-claude-gui",
  "session_id": "20c51c9e-881f-4370-a0a8-e33d39f4e6cc",  // ★ 用于 --resume
  "tools": ["Task", "Read", "Edit", "Write", "Bash", "Grep", "Glob", ...],
  "mcp_servers": [],                  // 已挂载的 MCP server
  "model": "claude-fable-5[1M]",      // 当前模型
  "permissionMode": "bypassPermissions", // 权限模式
  "slash_commands": ["clear", "config", "verify", ...],
  "agents": ["claude", "Explore", "general-purpose", ...],  // 可用 subagent
  "skills": [...],
  "plugins": [{ "name": "superpowers", "path": "...", "source": "..." }],
  "apiKeySource": "none",
  "claude_code_version": "2.1.186",
  "output_style": "learning",
  "analytics_disabled": true,
  "fast_mode_state": "off",
  "memory_paths": { "auto": "C:\\...\\memory\\" },
  "uuid": "012a1432-..."
}
```

**用途**:
- `session_id`:**续传的关键**。下一次 turn 用 `--resume <session_id>` 接续对话。
- `tools` / `slash_commands` / `agents`:可用于动态生成 UI(工具列表、斜杠命令菜单)。

### 2.2 `system/status` — 状态变更

```jsonc
{ "type": "system", "subtype": "status", "status": "requesting", "session_id": "...", "uuid": "..." }
```

`status` 观察到的值:`"requesting"`(正在请求 API)。可用于 UI 显示"思考中"。

### 2.3 `system/thinking_tokens` — 思考 token 计数

```jsonc
{
  "type": "system",
  "subtype": "thinking_tokens",
  "estimated_tokens": 26,
  "estimated_tokens_delta": 17,   // 较上次的增量
  "session_id": "...",
  "uuid": "..."
}
```

随思考进行,`estimated_tokens` 单调递增。可用于 UI 显示"思考中… N tokens"。

### 2.4 `system/hook_started` / `system/hook_response` — Hook 执行

```jsonc
// hook 开始
{ "type": "system", "subtype": "hook_started",
  "hook_id": "679f...", "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart", "uuid": "...", "session_id": "..." }

// hook 返回(含 stdout/stderr/exit_code/outcome)
{ "type": "system", "subtype": "hook_response",
  "hook_id": "679f...", "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "output": "...", "stdout": "", "stderr": "...",
  "exit_code": 1, "outcome": "error",
  "uuid": "...", "session_id": "..." }
```

> ⚠️ **本机观察到一个坏 hook**:superpowers 插件的 `SessionStart:startup` hook 报 `ParserError: Unexpected token 'session-start'`。这是该插件的 bug,**与 my-claude-gui 无关**——claude 会跳过出错的 hook 继续。UI 可忽略这类 `outcome: "error"` 的 hook_response。

### 2.5 `system/notification` — UI 通知

```jsonc
{
  "type": "system", "subtype": "notification",
  "key": "stop-hook-error",
  "text": "Stop hook error occurred · ctrl+o to see",
  "priority": "immediate",
  "uuid": "...", "session_id": "..."
}
```

可用于在界面弹 toast。`priority` 观察到 `"immediate"`。

---

## 三、`stream_event` 类型(Anthropic 原生 SSE,流式增量)

顶层 `type: "stream_event"`。**这是 token 级流式渲染的核心**,只有加 `--include-partial-messages` 才会出现。

```jsonc
{
  "type": "stream_event",
  "event": { /* Anthropic 原生 SSE 事件,见下 */ },
  "session_id": "...",
  "parent_tool_use_id": null,   // subagent 调用时非 null
  "uuid": "...",
  "ttft_ms": 1771               // 仅 message_start 带,首 token 时间
}
```

`event.type` 的 6 种取值(按一次 turn 的出现顺序):

| `event.type` | 出现次数 | 含义 |
|--------------|---------|------|
| `message_start` | 每消息 1 | 消息开始 |
| `content_block_start` | 每块 1 | 一个内容块开始(thinking/text/tool_use) |
| `content_block_delta` | **多次** | 块内增量(真正的 token 流) |
| `content_block_stop` | 每块 1 | 内容块结束 |
| `message_delta` | 每消息 1 | 消息级增量(stop_reason / usage) |
| `message_stop` | 每消息 1 | 消息结束 |

### 3.1 `message_start`

```jsonc
{
  "type": "message_start",
  "message": {
    "id": "06b160fb83605671a3b651dac13d32d7",
    "type": "message", "role": "assistant",
    "model": "MiniMax-M3",
    "usage": { "input_tokens": 0, "output_tokens": 0 }
  }
}
```

### 3.2 `content_block_start` — 块类型由这里宣告

```jsonc
// thinking 块
{ "type": "content_block_start", "index": 0,
  "content_block": { "type": "thinking", "thinking": "" } }

// text 块
{ "type": "content_block_start", "index": 1,
  "content_block": { "type": "text", "text": "" } }

// tool_use 块
{ "type": "content_block_start", "index": 2,
  "content_block": { "type": "tool_use", "id": "call_function_...", "name": "Read", "input": {} } }
```

> `index` 是块在 `message.content` 数组里的序号,**后续 delta 用它定位累积目标**。

### 3.3 `content_block_delta` — ★ token 流(最重要)

`delta.type` 有 3 种变体(实测):

```jsonc
// ① 思考增量
{ "type": "content_block_delta", "index": 0,
  "delta": { "type": "thinking_delta", "thinking": "The user wants me to read package.json" } }

// ② 文本增量(渲染到聊天的主力)
{ "type": "content_block_delta", "index": 1,
  "delta": { "type": "text_delta", "text": "my-claude-gui" } }

// ③ 工具输入增量(tool_use 的 input JSON 片段)
{ "type": "content_block_delta", "index": 2,
  "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":\"D:\\\\..." } }
```

**渲染策略**:
- `text_delta` → 累积到对应 message 的文本块,逐字渲染。
- `thinking_delta` → 累积到思考块,可折叠展示。
- `input_json_delta` → 是 JSON 字符串片段,**不要单独渲染**,等完整 `assistant` 消息拿到完整 `input` 再展示。

### 3.4 `content_block_stop`

```jsonc
{ "type": "content_block_stop", "index": 0 }
```

仅宣告某 index 的块结束,无 payload。

### 3.5 `message_delta` — 含 stop_reason

```jsonc
{
  "type": "message_delta",
  "delta": { "stop_reason": "tool_use", "stop_sequence": null },
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

`stop_reason` 观察到的值:`"tool_use"`(模型要调工具)、`"end_turn"`(正常结束)、`"max_tokens"` 等。

### 3.6 `message_stop`

```jsonc
{ "type": "message_stop" }
```

---

## 四、`assistant` 类型(完整消息快照)

顶层 `type: "assistant"`。**块结束后** claude 发出完整消息,含所有 content 块的最终态。

```jsonc
{
  "type": "assistant",
  "message": {
    "id": "06b16112964affb76593b521bff25f0f",
    "type": "message", "role": "assistant",
    "model": "MiniMax-M3",
    "usage": { "input_tokens": 0, "output_tokens": 0 },
    "content": [
      // content 块的三种形态(见 4.1~4.3)
    ],
    "context_management": null
  },
  "parent_tool_use_id": null,   // subagent 场景下指向父 tool_use
  "session_id": "...",
  "uuid": "..."
}
```

### 4.1 content 块:`text`

```jsonc
{ "type": "text", "text": "my-claude-gui 是一个...的 GUI。" }
```

### 4.2 content 块:`thinking`

```jsonc
{ "type": "thinking", "thinking": "The user wants me to read package.json", "signature": "" }
```

### 4.3 content 块:`tool_use`(★ 工具调用)

```jsonc
{
  "type": "tool_use",
  "id": "call_function_uc0k5d920344_1",   // ★ 对应 tool_result 的 tool_use_id
  "name": "Read",                          // 工具名
  "input": {                               // 工具入参(因工具而异)
    "file_path": "D:\\00-huangbh-project\\my-claude-gui\\package.json"
  }
}
```

常见工具及其 `input` 形态(实测):

| `name` | `input` 关键字段 |
|--------|------------------|
| `Read` | `{ file_path }` |
| `Write` | `{ file_path, content }` |
| `Edit` | `{ file_path, old_string, new_string }` |
| `Bash` / `PowerShell` | `{ command, description }` |
| `Glob` | `{ pattern }` |
| `Grep` | `{ pattern, path, include }` |
| `TodoWrite` | `{ todos: [{ content, status, priority }] }` |

> ⚠️ **任务工具的实际形态取决于模型/配置**(实测踩坑):上表 `TodoWrite` 是 Claude Code **默认模型** 的工具。但本机 GUI 跑的是 **MiniMax-M3** 模型,它暴露的任务工具是 **`TaskCreate` / `TaskUpdate`**(不是 TodoWrite),且数据结构完全不同:
>
> | `name` | `input` | 说明 |
> |--------|---------|------|
> | `TaskCreate` | `{ subject, description, activeForm }` | **单个**任务(input 里无 id;id 由创建顺序隐式决定,tool_result 回 `"Task #N created"`) |
> | `TaskUpdate` | `{ taskId, status }` | `taskId` 是 1-based 数字,对应 TaskCreate 的创建顺序;`status` 如 `completed` |
> | `TaskList` / `TaskGet` | — | 列出/查询(本机未触发) |
>
> **关键差异**:TodoWrite 是**全量快照**(一次给整个 todos 数组);TaskCreate/TaskUpdate 是**增量**操作(逐个建、逐个改)。所以解析器必须在 turn 内**累积**任务状态(TaskCreate 追加、TaskUpdate 按 taskId 改状态),再 emit 归一化的全量列表给 UI。本仓库 `ClaudeRuntime` 即按此模型实现。
>
> **教训**:任务工具的形态随模型/MCP 而变,文档的 TodoWrite 形态不能假设通用。做任务相关 UI 前先 dump 当前模型的实际工具。

> **渲染提示**:`id` 是连接 `tool_use` ↔ `tool_result` 的纽带,UI 用它配对卡片的状态(进行→完成)。

---

## 五、`user` 类型(tool_result 的载体)

顶层 `type: "user"`。**tool_result 不独立成行,而是包在 user 消息的 content 里**——这是 schema 里最容易踩的坑。

```jsonc
{
  "type": "user",
  "message": {
    "type": "message", "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "call_function_uc0k5d920344_1",  // ★ 关联 tool_use
        "content": "1\t{\n2\t  \"name\": \"my-claude-gui\"...",  // 工具返回内容
        "is_error": false                                 // 是否出错
      }
    ]
  },
  "session_id": "...",
  "uuid": "..."
}
```

**渲染提示**:`content` 可能是 string(纯文本)或结构化数组(如 `[{type:"text",...}]`),解析时需兼容。

---

## 六、`result` 类型(★ turn 终结,每 turn 最后一条)

顶层 `type: "result"`。携带 usage、cost、最终文本、统计信息。**`ClaudeRuntime` 用它判定 turn 结束**。

```jsonc
{
  "type": "result",
  "subtype": "success",          // success / error
  "is_error": false,
  "api_error_status": null,

  // ── 性能指标 ──
  "duration_ms": 5953,           // 总耗时
  "duration_api_ms": 3005,       // API 耗时
  "ttft_ms": 2297,               // 首字节时间
  "ttft_stream_ms": 2286,        // 首流字节时间
  "time_to_request_ms": 784,
  "num_turns": 2,                // 本 turn 内的 agent 循环次数

  // ── 结果 ──
  "result": "my-claude-gui 是一个...的 GUI。",   // 最终文本
  "stop_reason": "end_turn",     // end_turn / tool_use / max_tokens / ...
  "session_id": "...",           // ★ 与 init 的 session_id 一致,用于 --resume

  // ── 用量与成本 ──
  "total_cost_usd": 0,
  "usage": {
    "input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 0,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": { "ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0 },
    "inference_geo": "",
    "iterations": [],
    "speed": "standard"
  },
  "modelUsage": {                // 分模型的用量明细
    "claude-fable-5[1M]": {
      "inputTokens": 0, "outputTokens": 0,
      "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0,
      "webSearchRequests": 0, "costUSD": 0,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000
    }
  },

  "permission_denials": [],      // 被拒绝的工具调用
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "..."
}
```

**关键字段**:
- `result`:最终回答文本(若无需展示流式,可直接用它)。
- `usage` / `total_cost_usd` / `modelUsage`:底部状态栏的 token/cost 展示。
- `stop_reason`:`end_turn`(正常结束)、`tool_use`(还要调工具,继续循环)、`max_tokens`(截断)。
- `permission_denials`:P3 工具审批功能的依据。

---

## 七、my-claude-gui 的归一化映射

`ClaudeRuntime` 把上述原始格式归一化为 `RuntimeEvent` 联合(定义在 `packages/contracts/src/runtime.ts`),供 renderer 统一渲染:

| 原始来源 | 归一化为 | 用途 |
|---------|---------|------|
| `stream_event` + `content_block_delta(text_delta)` | `TextDeltaEvent` | 流式逐字渲染 |
| `stream_event` + `content_block_delta(thinking_delta)` | `ThinkingEvent` | 折叠思考块 |
| `assistant` + content `tool_use` | `ToolUseEvent` | 工具卡片 |
| `user` + content `tool_result` | `ToolResultEvent` | 卡片状态→完成 |
| `system/status` | (内部日志,不发事件) | "思考中"指示 |
| `result` | `UsageEvent` + `TurnDoneEvent` | 状态栏 + 解锁输入框 |

**不归一化的**(P1 暂忽略):
- `system/init` 的 `session_id` → P2 用于 `--resume`(当前 `RuntimeManager.rememberClaudeSession` 已留接口)。
- `system/notification` → P3 弹 toast。
- `TodoWrite` 工具的 `input.todos` → P2 渲染左栏任务列表。

---

## 八、解析器实现要点(ClaudeRuntime)

1. **逐行 readline**:每行一个 JSON,`JSON.parse` 包 try/catch,坏行只 warn 不中断。
2. **按 `type` 分发**:`system` / `stream_event` / `assistant` / `user` / `result` 各有 handler,未知 type 静默忽略(向前兼容)。
3. **stream_event 与 assistant 不重复**:text/thinking 增量只在 `stream_event` 渲染;`assistant` 消息只用于补全 tool_use(完整 input),不重发 text(避免重复)。
4. **turn 结束判定**:收到 `result` 行即发 `turn.done`;若 claude 异常退出无 result 行,`close` 事件兜底补发 `turn.done`(否则 UI 永远转圈)。
5. **session_id 续传**:从 `system/init` 或 `result` 的 `session_id` 捕获,存入 `RuntimeManager`,下次 turn 加 `--resume`。

---

## 九、复现方法(可自行验证)

```bash
# 找到 claude 入口(本机路径)
CLAUDE_ENTRY="D:/soft/nodejs/node_global/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs"

# 跑一次带完整 partial 的查询,dump 到文件
node "$CLAUDE_ENTRY" -p "read package.json then say what this is in one sentence" \
  --output-format stream-json --verbose --include-partial-messages > dump.jsonl

# 统计所有 (type, subtype) 组合
node -e "const l=require('fs').readFileSync('dump.jsonl','utf8').split('\n').filter(Boolean);const s={};for(const x of l){try{const o=JSON.parse(x);const k=o.subtype?\`\${o.type}/\${o.subtype}\`:o.type;s[k]=(s[k]||0)+1;}catch{}}console.log(s);"
```

> claude 升级后 schema 可能变化。本文档对应 Claude Code **2.1.186**;升级后建议重跑上述命令复核。

---

## 十、工具审批:控制协议在 2.1.186 不可用(P3 踩坑记录)

> ⚠️ **本节是 P3 工具审批功能的调研结论,避免后人重复踩坑。** 以下结论基于本机 Claude Code **2.1.186** 的真实 dump 验证,非推测。

### 结论:无法做"事中交互式审批"

P3 原计划用 claude 的**控制协议**(`control_request` / `control_response`)实现工具执行前的弹审批条。但 4 轮真实 dump 验证证明:**该机制在 2.1.186 的 `-p` 非交互模式下完全不生效**——所有工具一律直接执行,无法事中拦截。

| 测试 | 配置 | 结果 |
|------|------|------|
| 双向 stream-json + `--permission-prompt-tool`(指向不存在的工具) | `--permission-mode default` | Bash 直接执行,无 control_request |
| 纯 default 模式(传统 `-p`) | 无 prompt-tool | PowerShell 直接执行,`permission_denials:[]` |
| **真实 MCP server 提供 approve 工具 + `--permission-prompt-tool` 指向它** | default 模式,MCP 已 connected | Bash 直接执行,**approve 工具从未被调用** |
| 危险命令(`rm -rf`)+ approve MCP 工具 | default 模式 | PowerShell Remove-Item **直接执行**,denials=[] |

### 根因

- `--permission-prompt-tool` 这个 flag 在 2.1.186 **存在但不生效**(`--help` 未列出;给不存在的工具名也不报错)。
- 调研得知:该 flag 的强制生效(`requiresUserInteraction` 机制)是 **v2.1.199+** 才引入的。本机 2.1.186 早于此版本。
- 在 `-p`(print / 非交互)模式下,claude 对所有工具一律直接执行,根本不触发审批流程。审批**只在 TTY 交互模式**(终端弹 y/n)发生,而 GUI 是 spawn 管道,非 TTY。

### 控制协议的设计意图(供未来 claude 升级后参考)

如果将来 claude ≥ 2.1.199 且该机制启用,交互式审批的设计路径是(来自 Agent SDK 逆向,Anthropic 未官方文档化,issues #24594/#24595):

1. spawn 加 `--permission-prompt-tool <mcp_tool_name>` + `--input-format stream-json`(双向)+ **保持 stdin 开启**。
2. claude 把审批请求作为对该 MCP 工具的调用,在 stdout 发 `type:"control_request"` 行:
   ```jsonc
   { "type":"control_request", "request_id":"<id>",
     "request":{ "subtype":"can_use_tool", "tool_name":"Bash", "input":{...} } }
   ```
3. 决策通过 stdin 写 `control_response`(注意:`keepOpen` —— 不能在发完 prompt 后关 stdin,否则 claude 永远收不到决策而挂起):
   ```jsonc
   { "type":"control_response",
     "response":{ "subtype":"success", "request_id":"<id>",
       "response":{ "behavior":"allow", "updatedInput":{...} } } }   // 或 "behavior":"deny","message":"..."
   ```

### P3 的实际落地(基于本机现状)

既然事中审批不可行,P3 改为:

1. **权限模式开关接入**:`--permission-mode default|plan|acceptEdits`(TopBar 的 toggle 真正生效,传给 startSession → spawn)。这是 claude **已支持且生效**的 flag(实测 default 模式确实放行,plan/acceptEdits 会改变工具执行策略)。
2. **事后展示**:解析 `result` 行的 `permission_denials[]` 字段(见 §六),在工具卡片上标记被拒的工具。
3. `--permission-mode` 的完整取值(本机实测):`acceptEdits` / `auto` / `bypassPermissions` / `default` / `dontAsk` / `plan`。

### 复现验证方法

```bash
# 验证 --permission-prompt-tool 是否生效(2.1.186 应观察不到 approve 工具被调用)
claude -p "run echo hello in bash" --output-format stream-json --verbose \
  --include-partial-messages --permission-mode default \
  --mcp-config <提供approve工具的mcp-config.json> \
  --permission-prompt-tool mcp__mygui__approve
# 若 stdout 无 control_request 行、MCP server 日志无 tools/call,则该版本不支持。
```

> claude 升级后 schema 可能变化。本文档对应 Claude Code **2.1.186**;升级后建议重跑上述命令复核。
