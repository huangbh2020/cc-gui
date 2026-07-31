修复两个问题：移除已失效的 Claude CLI 路径配置面板，并让 SDK 原生二进制在打包后能被 spawn 执行。

## 问题1：移除「Claude CLI 路径」配置面板（含其专属的死代码管线）

路径配置在 SDK 模式下已完全失效（保存的路径运行时不被读取，测试按钮恒报弃用）。按你的选择，移除整个面板及其只服务于该面板的 IPC/schema/契约，保留独立的健康检查逻辑（`claudeHealthCheck` / `refreshClaudeHealth` / `claudeInstalled`，它们被 ChatPane/StatusBar 使用，与路径面板无关）。

1. **删除** `apps/desktop/src/renderer/components/settings/ClaudePathPanel.tsx`

2. **`apps/desktop/src/renderer/components/settings/SettingsPage.tsx`**
   - 删除 `import { ClaudePathPanel }`（第5行）
   - `SectionId` 类型去掉 `"claude-path"`（第34行）
   - `NAV_ITEMS` 去掉 `{ id: "claude-path", label: "Claude CLI 路径" }`（第43行）
   - 默认 `active` 从 `"claude-path"` 改为 `"custom-models"`（第59行，新的首项）
   - 删除 `{active === "claude-path" && <ClaudePathPanel />}`（第104行）
   - 更新顶部 docstring：去掉 "Claude CLI 路径" 条目和 `ClaudePathPanel is designed to reload...` 注释

3. **`apps/desktop/src/preload/index.ts`**
   - 删除 `pickFile`（第183行）及其 `@deprecated` 注释——仅被 ClaudePathPanel 使用
   - 删除 `testClaudePath`（第185-186行）及其 `@deprecated` 注释——仅被 ClaudePathPanel 使用

4. **`apps/desktop/src/main/ipc/claude.ts`**
   - import 块去掉 `TestClaudePathSchema,`（第18行）
   - 第20行 `import type { SaveMessagesInput, TestClaudePathResult }` 改为只导入 `SaveMessagesInput`
   - 删除 `IPC.DIALOG_PICK_FILE` handler 块（第250-261行，含 "Legacy: file picker..." 注释）
   - 删除 `IPC.CLAUDE_TEST_PATH` handler 块（第263-268行，含 `@deprecated` 注释）
   - 保留 `dialog` import（`dialog:pickFolder` 第31行仍在用）

5. **`packages/contracts/src/ipc.ts`**
   - 删除 `export const CLAUDE_PATH_SETTING_KEY = "claudePath";`（第27行）
   - 删除 `TestClaudePathSchema` / `TestClaudePathInput` / `TestClaudePathResult`（第426-436行，含注释）
   - RpcMap 删除 `"claude.testPath"` 和 `"dialog.pickFile"` 两项（第1067-1068行），section 注释 `// Settings & claude path` 改为 `// Settings`
   - 通道常量删除 `CLAUDE_TEST_PATH` 和 `DIALOG_PICK_FILE`（第1175-1176行），section 注释 `// Settings & claude path config` 改为 `// Settings`

   说明：DB `settings` 表里旧的 `claudePath` 行变成孤儿，但因无任何读取方而完全无害，不做迁移。

## 问题2：让 SDK 原生二进制脱离 asar（可被 spawn）

6. **`apps/desktop/electron-builder.yml`** — 在 `asarUnpack` 增加一条：
   ```yaml
   asarUnpack:
     - "**/*.{node,dll}"
     - "**/sql.js/**"
     # Claude Agent SDK 的平台子包(如 ...-win32-x64)内含原生 claude 二进制,
     # 必须脱离 asar 才能被 child_process.spawn 执行(asar 内的 .exe 无法被 OS 加载)。
     - "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**"
   ```
   - glob `claude-agent-sdk-*`（带尾随 `-`）只匹配平台子包（`...-win32-x64`/`...-darwin-arm64` 等），不匹配主包 `claude-agent-sdk`（无后缀，其 `sdk.mjs` 已被 Vite 打进 main chunk，留在 asar 内即可）。
   - 解包后二进制落到 `app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-*/claude.exe`，Electron 的 asar 集成会自动把 spawn 时的 `app.asar/...` 路径重写到 `.asar.unpacked/...`（与现有 node-pty/sql.js 解包同理）。
   - 当前报错证明解析路径已正确（"exists"），仅需让文件变成磁盘真实文件即可执行，无需改 provider 或传 `pathToClaudeCodeExecutable`。
   - glob 平台无关，mac 构建同样覆盖。

## 验证

7. 类型检查：`cd apps/desktop && npx tsc --noEmit -p tsconfig.json`（AGENTS.md 要求的改后首查）
8. （可选，较重）`pnpm package` 重新打包 → 启动安装产物 → 发送一条 turn，确认 SDK 不再报 "exists but failed to launch"。