# my-claude-gui

**English** | [中文](#中文)

---

## English

A desktop GUI for [Claude Code](https://code.claude.com/) — a three-pane IDE built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). This app does **not** reimplement the agent; it provides the interaction surface: session management, real-time streaming, tool approvals, and IDE affordances (files, git, terminal).

> Architecture inspired by [Synara](https://github.com/Emanuele-web04/synara) — a multi-provider agent harness. This project reuses its layered design (provider adapter, normalized runtime events, IPC boundary) but is written in plain TypeScript (no effect-ts, no bun) and currently targets a single provider (Claude).

### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ TopBar: [project ▼] [model] [effort] [⚡Plan] [⚙ settings]         │
├──────────┬───────────────────────────────┬────────────────────────┤
│ LeftBar  │  ChatPane (tabs)              │  RightPanel            │
│ projects │  message stream               │  [files][git]          │
│ sessions │  tool cards / approvals       │  tab body              │
│ tasks    │  input box                    │                        │
│          │                               ├────────────────────────┤
│          │                               │  Bottom Terminal       │
├──────────┴───────────────────────────────┴────────────────────────┤
│ StatusBar: claude version · context tokens · status               │
└──────────────────────────────────────────────────────────────────┘
```

### Architecture

Three Electron processes:

- **Renderer** (React 19 + Vite) — UI only, `contextIsolation: true`, `nodeIntegration: false`.
- **Preload** — `contextBridge` exposes a typed, whitelisted `window.api`. The only bridge into Node; all messages are validated with zod.
- **Main** (Node.js) — owns the `RuntimeManager` (holds a `ProviderRegistry`), `SessionManager` (SQLite via sql.js), and IDE services (terminal, git, files).

Provider integration lives behind an `AgentProvider` interface; today only `ClaudeAgentSdkProvider` exists (wraps the Agent SDK's `query()`). The SDK bundles its own `claude` binary — the project does not spawn a user-installed CLI.

```
Renderer (React 19, contextIsolation)
        ↕  Electron IPC (preload contextBridge + zod validation)
Main (Node.js)
  ├── RuntimeManager      holds ProviderRegistry, builds ProviderContext
  │     └── AgentProvider  ClaudeAgentSdkProvider (-> query() -> SDKMessage -> RuntimeEvent)
  ├── SessionManager      session lifecycle (SQLite via sql.js)
  └── IDE Services        terminal / git / files
        ↕  @anthropic-ai/claude-agent-sdk (query)
     claude binary (bundled by the SDK)
```

### Requirements

- Node.js ≥ 22.13 (pnpm 11 requires it)
- pnpm ≥ 9 (`corepack enable && corepack prepare pnpm@latest --activate`)
- An Anthropic API key (`ANTHROPIC_API_KEY`) — the Agent SDK bills per API key, not via a Max/Pro subscription.

> **Note:** The Claude Agent SDK bundles its own `claude` binary. You no longer need to install the Claude Code CLI separately.

### Getting started

```bash
pnpm install
pnpm dev
```

### Build & package

```bash
# Type-check
pnpm typecheck

# Build (electron-vite)
pnpm build

# Package installers (macOS dmg/zip + Windows nsis) -> apps/desktop/release/
pnpm package
```

### Download

Pre-built binaries are published on [GitHub Releases](https://github.com/huangbh2020/cc-gui/releases):

- **macOS**: `.dmg` (arm64 + x64) — unsigned; right-click → Open on first launch.
- **Windows**: `.exe` NSIS installer (x64) — unsigned; SmartScreen will warn.

The app checks for updates automatically (via `electron-updater` pulling `latest*.yml` from GitHub Releases). You can also check manually in **Settings → About → 检查更新**.

### Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| P0 | Scaffold: three processes, three-pane layout, IPC contract | ✅ |
| P1 | End-to-end: Agent SDK + live streaming + input box | ✅ |
| P2 | Persistence: SQLite (sql.js), `--resume`, session list | ✅ |
| P2.5 | SDK migration: AgentProvider abstraction + ProviderRegistry | ✅ |
| P3 | Tool approvals: canUseTool bridge → approval IPC | ✅ basic |
| P3.5 | Center-pane tab mode: multi-thread tabs, background turns | ✅ |
| P4 | IDE right panel: file tree, git, terminal (xterm + node-pty) | 🟡 files/git/terminal done; browser preview pending |
| P5 | Polish: browser preview, checkpoint timeline, Cmd+K, approval UI | ⬜ |
| P6 | Release: electron-builder, auto-update, CI | ✅ basic |

### Tech stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 33, electron-vite, electron-builder 25 |
| Frontend | React 19, Zustand 5, Tailwind CSS 3, @base-ui/react, @tabler/icons |
| Editor / Terminal | Monaco Editor, xterm.js + node-pty |
| Agent | @anthropic-ai/claude-agent-sdk, electron-updater |
| Persistence | sql.js (SQLite in pure WASM) |
| Contracts | zod (cross-process IPC validation) |
| Tooling | pnpm 11, Turbo, TypeScript 5 (strict) |

### License

MIT. This project does not redistribute or bundle a standalone `claude` binary — the Agent SDK manages its own bundled binary internally.

---

## 中文

基于 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) 构建的 [Claude Code](https://code.claude.com/) 桌面端 GUI——一个三栏 IDE。本应用**不重新实现 agent**,只提供交互界面:会话管理、实时流式渲染、工具审批、IDE 能力(文件、git、终端)。

> 架构受 [Synara](https://github.com/Emanuele-web04/synara) 启发——一个多 provider 的 agent 框架。本项目复用了它的分层设计(provider adapter、归一化 runtime 事件、IPC 边界),但用主流 TypeScript 重写(无 effect-ts、无 bun),目前只接 claude 一个 provider。

### 布局

```
┌──────────────────────────────────────────────────────────────────┐
│ 顶栏:[项目 ▼] [模型] [思考力度] [⚡Plan] [⚙ 设置]                   │
├──────────┬───────────────────────────────┬────────────────────────┤
│ 左栏     │  中栏(聊天,支持 Tab 多开)      │  右栏                  │
│ 项目     │  消息流                        │  [文件][Git]           │
│ 会话     │  工具卡片 / 审批               │  标签内容              │
│ 任务     │  输入框                        │                        │
│          │                               ├────────────────────────┤
│          │                               │  底部终端              │
├──────────┴───────────────────────────────┴────────────────────────┤
│ 状态栏:claude 版本 · 上下文 token · 运行状态                       │
└──────────────────────────────────────────────────────────────────┘
```

### 架构

三个 Electron 进程:

- **Renderer**(React 19 + Vite)——纯 UI,`contextIsolation: true`、`nodeIntegration: false`。
- **Preload**——`contextBridge` 暴露类型化白名单 `window.api`。通往 Node 的唯一桥梁,所有消息经 zod 校验。
- **Main**(Node.js)——持有 `RuntimeManager`(内含 `ProviderRegistry`)、`SessionManager`(SQLite,基于 sql.js)和 IDE 服务(终端、git、文件)。

Provider 集成藏在 `AgentProvider` 接口背后;目前只有 `ClaudeAgentSdkProvider`(包装 Agent SDK 的 `query()`)。SDK 自带 `claude` 二进制——项目不 spawn 用户安装的 CLI。

```
Renderer (React 19, contextIsolation)
        ↕  Electron IPC(preload contextBridge + zod 校验)
Main (Node.js)
  ├── RuntimeManager      持 ProviderRegistry,构造 ProviderContext
  │     └── AgentProvider  ClaudeAgentSdkProvider(-> query() -> SDKMessage -> RuntimeEvent)
  ├── SessionManager      会话生命周期(SQLite via sql.js)
  └── IDE Services        terminal / git / files
        ↕  @anthropic-ai/claude-agent-sdk (query)
     claude 二进制(SDK 内打包)
```

### 环境要求

- Node.js ≥ 22.13 (pnpm 11 requires it)
- pnpm ≥ 9(`corepack enable && corepack prepare pnpm@latest --activate`)
- Anthropic API key(`ANTHROPIC_API_KEY`)——Agent SDK 按 API key 计费,不能使用 Max/Pro 订阅。

> **注意**:Claude Agent SDK 自带 `claude` 二进制,不再需要单独安装 Claude Code CLI。

### 快速开始

```bash
pnpm install
pnpm dev
```

### 构建与打包

```bash
# 类型检查
pnpm typecheck

# 构建(electron-vite)
pnpm build

# 打包安装包(macOS dmg/zip + Windows nsis)-> apps/desktop/release/
pnpm package
```

### 下载

预编译二进制发布在 [GitHub Releases](https://github.com/huangbh2020/cc-gui/releases):

- **macOS**:`.dmg`(arm64 + x64)——未签名,首次打开需右键 → 打开。
- **Windows**:`.exe` NSIS 安装包(x64)——未签名,SmartScreen 会提示。

应用会自动检查更新(通过 `electron-updater` 从 GitHub Releases 拉 `latest*.yml`)。也可在**设置 → 关于 → 检查更新**手动检查。

### 路线图

| 阶段 | 目标 | 状态 |
|------|------|------|
| P0 | 脚手架:三进程、三栏布局、IPC 契约 | ✅ |
| P1 | 端到端:Agent SDK + 流式渲染 + 输入框 | ✅ |
| P2 | 持久化:SQLite(sql.js)、`--resume` 续传、会话列表 | ✅ |
| P2.5 | SDK 迁移:AgentProvider 抽象层 + ProviderRegistry | ✅ |
| P3 | 工具审批:canUseTool 桥 → approval IPC | ✅ 基础 |
| P3.5 | 中间面板 Tab 模式:多线程 tab、后台 turn 继续运行 | ✅ |
| P4 | IDE 右栏:文件树、git、终端(xterm + node-pty) | 🟡 文件/Git/终端已完成;浏览器预览待 P5 |
| P5 | 体验打磨:浏览器预览、checkpoint 时间线、Cmd+K、审批 UI | ⬜ |
| P6 | 发布:electron-builder、自动更新、CI | ✅ 基础 |

### 技术栈

| 层 | 技术 |
|----|------|
| 壳层 | Electron 33、electron-vite、electron-builder 25 |
| 前端 | React 19、Zustand 5、Tailwind CSS 3、@base-ui/react、@tabler/icons |
| 编辑器/终端 | Monaco Editor、xterm.js + node-pty |
| Agent | @anthropic-ai/claude-agent-sdk、electron-updater |
| 持久化 | sql.js(纯 WASM 的 SQLite) |
| 契约 | zod(跨进程 IPC 校验) |
| 工具链 | pnpm 11、Turbo、TypeScript 5(strict) |

### 许可证

MIT。本项目不重新分发或内嵌独立的 `claude` 二进制——Agent SDK 内部管理其自带二进制。
