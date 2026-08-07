## 问题根因

claude.exe 以项目根为 cwd 运行(`ipc/claude.ts:119`)。模型有时会生成**绝对路径**写文件,且被 WSL 训练数据"污染",在 Windows 上也会输出 `/mnt/d/...`。Windows 上 `path.resolve(cwd, "/mnt/d/...")` 会解析为 `D:\mnt\d\...`(已实测确认),文件落到项目外的垃圾目录。当前代码无任何写入路径拦截:`shouldAutoApprove` 在 `acceptEdits` 模式下**无差别静默放行**所有 Edit/Write(含这种垃圾路径),`FileSnapshot.safeResolve` 只影响"撤销本轮"记录、不阻止写入。

## 改动方案(用户已选:严格项目内)

### 1. `apps/desktop/src/main/lib/fileSnapshot.ts` — 新增共享路径助手
- `export const FILE_MUTATING_TOOLS: ReadonlySet<string>` = `{Write, Edit, MultiEdit, NotebookEdit}`
- `export function getToolFilePath(toolName, input)`:取 `file_path`(NotebookEdit 取 `notebook_path`)
- `export function normalizeToolFilePath(cwd, filePath): { absPath, insideProject } | null`
  - WSL 路径修正:`/mnt/<drive>/<rest>` → `<drive>:\<rest>`(大小写不敏感)
  - `path.resolve` 得绝对路径,复用现有 `safeResolveOk` 判定是否在项目内

### 2. `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts` — canUseTool 硬守卫
在 canUseTool 中(AskUserQuestion/ExitPlanMode 分支之后):
- 对 `FILE_MUTATING_TOOLS` 的调用:用 `normalizeToolFilePath` 修正路径,构造 `normalizedInput`
- **严格策略**:`insideProject === false` 时,除 `bypassPermissions`/`dontAsk`(用户明确跳过全部检查)外,一律 `{ behavior: "deny", message: "拒绝:路径 X 在项目工作目录之外,只允许写入项目目录内" }` + `ctx.log.info` 记录。放在 always-allowed 判断**之前**(边界守卫优先)
- 所有 allow 返回路径都带 `updatedInput: normalizedInput`,确保实际写入落在修正后的真实路径
- `acceptEdits` 不再可能静默放行项目外写入(已被上游 deny)

### 3. `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts` — 快照同步
`recordPre` 处(line ~801)用同一助手归一化路径(否则模型原始 WSL 路径被 `safeResolve` 跳过,本轮文件卡片/撤销会漏掉这个文件);同时把 Edit/Write 扩展为整个 `FILE_MUTATING_TOOLS`

### 4. 系统提示(治本,win32)
`startTurn` 中把 systemPrompt 的 `append` 统一组装:win32 时附加一句"运行在 Windows,使用原生路径或相对项目路径,绝不使用 /mnt/... 路径";保留原有 AskUserQuestion sentinel 追加逻辑(现有 `preset: "claude_code"` 结构不变)

### 5. (可选)AGENTS.md 加一条行为说明

## 验证
- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
- `pnpm dev` 手测:让模型尝试写 `/mnt/d/...` 路径,确认被拒且提示写入项目内;写项目内相对路径正常放行
- 注意:`Bash` 重定向写文件不在守卫范围内(无法可靠解析 shell 命令),靠第 4 步的系统提示缓解