# Pi SDK 输出收纳到组卡片 — 实现计划

## 根因

用户反馈 pi sdk 输出的 read/grep 等操作没有收纳到组卡片，过程数据没有收纳到顶部的用时卡片。

**调研结论**：
1. **"收纳到顶部用时卡片"已经工作**：`TurnPanel`（过程收纳盒）是 provider-neutral 的，pi 的 `tool.use` 事件已经能正确进入 `panelBlocks`。**不需要改**。
2. **"组卡片"失效是真正的 bug**：renderer 层 `MessageBlocks.tsx` 的 `BATCH_TOOL_NAMES`、`ToolIcon`、`toolSummary`、`extractToolFilePath` 全部**硬编码了 Claude 的大写工具名**（`Read`/`Grep`/`Bash`...），而 **pi 的工具名是小写**（`read`/`grep`/`bash`/`find`/`ls`/`edit`/`write`）。导致：
   - `isBatchTool("read")` → false → 每个 read/grep 平铺成独立卡片，**无法折叠成「N 个操作」组卡片**
   - `TOOL_ICON_MAP["read"]` → undefined → 回退通用图标，丢失语义图标
   - `toolSummary("read", ...)` → 走 default 分支 → 摘要显示异常
   - `CurrentOpTicker`（折叠态的"当前操作"滚动条）也跟着失效（它复用 ToolIcon/toolSummary）

**pi 与 Claude 工具对照**（已核对 pi sdk v0.83.0 源码 `core/tools/*.js`）：

| 功能 | Claude 名 | Pi 名 | 输入字段差异 |
|---|---|---|---|
| 读文件 | `Read` | `read` | Claude `file_path` / pi `path` |
| 内容搜索 | `Grep` | `grep` | 均为 `pattern` ✅ |
| 文件名搜索 | `Glob` | `find` | 均为 `pattern` ✅ |
| 执行命令 | `Bash` | `bash` | 均为 `command` ✅ |
| 列目录 | (无) | `ls` | pi 独有 |
| 编辑 | `Edit` | `edit` | 不同（本次不处理 diff） |
| 写入 | `Write` | `write` | 不同（本次不处理 diff） |

## 方案：renderer 层大小写不敏感归一化（单文件改动）

按用户选择，**只改 `apps/desktop/src/renderer/components/chat/MessageBlocks.tsx` 一个文件**，让所有 provider-neutral 渲染逻辑用大小写不敏感匹配。Edit/Write 暂走通用卡片（本次范围之外）。

### 改动点（全部在 MessageBlocks.tsx）

#### 1. `BATCH_TOOL_NAMES` — 加入小写名 + pi 独有的 `find`/`ls`（line 145-151）
改为既含大写（Claude）也含小写（pi）的集合，并补充 pi 独有工具：
```ts
const BATCH_TOOL_NAMES = new Set([
  // Claude (capitalized)
  "Read", "Glob", "Grep", "Bash", "PowerShell",
  "MultiEdit", "NotebookEdit", "TodoWrite", "TaskCreate", "TaskUpdate",
  "WebSearch", "WebFetch",
  // Pi (lowercase)
  "read", "find", "grep", "bash", "ls",
]);
```
（注释说明大小写并存的原因：Claude 与 pi 命名约定不同，renderer 是 provider-neutral 层）

#### 2. `isBatchTool` — 改为大小写不敏感（line 152-154）
```ts
function isBatchTool(b: Block): b is ToolUseBlock {
  return b.kind === "tool_use" && BATCH_TOOL_NAMES.has(b.toolName);
}
```
保留集合查表（O(1)），不改成每次 `toLowerCase()`——集合已含两套大小写。这是性能与可读性的最佳折中。

#### 3. `TOOL_ICON_MAP` — 加入 pi 小写别名（line 1015-1034）
```ts
const TOOL_ICON_MAP: Record<string, ...> = {
  // ... 保留现有大写 ...
  // Pi lowercase aliases
  read: IconFileSearch,
  find: IconFileSearch,
  ls: IconFileSearch,
  bash: IconTerminal,
  grep: IconSearch,
  edit: IconReplace,
  write: IconFilePlus,
};
```

#### 4. `toolSummary` — 加入 pi 小写分支（line 1047-1079）
在现有 `switch (name)` 中补充 pi 的小写 case，处理字段差异：
```ts
case "read":   // pi: path
case "write":
case "edit":
  return String(obj.file_path ?? obj.path ?? "");
case "bash":
  return String(obj.command ?? obj.description ?? "");
case "find":   // pi 的 glob 等价
  return String(obj.pattern ?? "");
case "grep":
  return String(obj.pattern ?? "");
case "ls":
  return String(obj.path ?? "");
```
（注意 pi 的 read 用 `path` 不是 `file_path`，所以用 `obj.file_path ?? obj.path` 兼容两者）

#### 5. `extractToolFilePath` — 加入 pi 小写分支（line 1125-1134）
让 pi 的 `read`/`write`/`edit` 的文件路径也能被提取成可点击链接：
```ts
function extractToolFilePath(toolName: string, input: unknown): string | null {
  const name = toolName;
  if ((name === "Edit" || name === "edit") && isEditOrPiEditInput(input)) return input.file_path ?? input.path;
  if ((name === "Write" || name === "write") && isWriteOrPiWriteInput(input)) return input.file_path ?? input.path;
  if (name === "Read" || name === "read") {
    // ... 提取 file_path ?? path ...
  }
  return null;
}
```

#### 6. 新增 pi 字段的类型守卫（在 line 1100-1118 附近）
pi 的 edit/write 用 `path` 字段，补充宽松的类型守卫（复用于 extractToolFilePath）：
```ts
/** Pi write input: { path, content } (pi 用 path 而非 file_path)。 */
function isPiWriteInput(i: unknown): i is { path: string; content: string } { ... }
```
（注意：本次**不**让 pi 的 edit 走 EditToolCard diff——因为 pi 的 edit 结构是 `{path, edits:[{oldText,newText}]}`，与 Claude `{file_path, old_string, new_string}` 差异大，需要单独适配，超出本次范围。所以 `BlockView` 的 `Edit`/`Write` 分发 line 687/700 保持只匹配大写，pi 的 edit/write 走 GenericToolCard，但 extractToolFilePath 仍能提取路径做链接）

### 不需要改的部分（已确认 provider-neutral）
- `TurnPanel` / `groupMessagesForRender`（ChatPane.tsx）— 过程数据收纳盒，pi 已自动工作
- `TurnStatRow` — "开始用时"卡片，pi 已自动工作
- `sessionStore.ts` ingest — block 装配 provider-neutral
- `PiMessageAdapter.ts` — 事件归一化正确，无需改
- `CurrentOpTicker.tsx` — 复用 ToolIcon/toolSummary，自动受益

## 验证

```bash
cd apps/desktop && npx tsc --noEmit -p tsconfig.json
```
类型检查通过即视为完成。运行时验证由用户在 dev 模式下用 pi 会话触发一次 read/grep 多次调用来确认组卡片折叠。

## 影响面
- **单文件改动**：仅 `MessageBlocks.tsx`
- **零持久化影响**：不改 store/adapter，历史 session 数据不变
- **Claude 会话零影响**：大写名仍在集合里，行为不变
- **向后兼容**：未来若 pi 改用大写或新增工具，只需往集合/map 里加一行