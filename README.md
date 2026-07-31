# my-claude-gui

**English** | [中文](#中文)

---

## English

A desktop GUI for [Claude Code](https://code.claude.com/) — a three-pane IDE built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). It does **not** reimplement the agent; it provides the interaction surface: session management, real-time streaming, tool approvals, and IDE affordances (files, git, terminal).

![Home](docs/iamges/首页分栏效果.png)

### Features

#### 💬 Real-time conversation
- Drives the Claude agent loop through the Agent SDK; messages stream in live, token by token.
- Assistant messages, tool calls, and tool results are rendered as structured cards.
- Tool-use approvals: allow / allow-once / deny, with a per-session pending queue.
- Attach files, paste images, and use slash commands from the composer.

#### 🗂 Multi-session tabs
- Open multiple sessions as tabs in the center pane; each tab keeps its own running turn.
- Closing a tab does **not** cancel the background turn — the event stream keeps flowing, and reopening the tab shows the latest state.
- Sessions persist to SQLite (via sql.js) and can be resumed later (`--resume` semantics).

#### 🧰 IDE right panel
- **Files**: a file tree of the current project with Monaco-backed diff viewing.
- **Git**: view changed files, inspect line-by-line diffs, and configure git identity.
- **Terminal**: a built-in terminal (xterm.js + node-pty) at the bottom of the right panel.

![Git diff](docs/iamges/git差异预览.png)

#### ⚙️ Rich settings
- **Model**: pick the model, set the reasoning effort, choose a permission mode, or specify a custom model id (for OpenAI-compatible endpoints).
- **Appearance**: theme and density preferences.
- **Terminal**: shell and font configuration.
- **Git**: author name / email, and diff-related options.

| Model settings | Appearance | Terminal | Git |
|---|---|---|---|
| ![Model](docs/iamges/模型设置.png) | ![Appearance](docs/iamges/外观设置.png) | ![Terminal](docs/iamges/终端设置.png) | ![Git](docs/iamges/git设置.png) |

#### 🔄 Other
- Auto-update via `electron-updater` (pulls `latest*.yml` from GitHub Releases); manual check in **Settings → About**.
- Provider abstraction layer (`AgentProvider`) — designed to extend to other agent platforms later.

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

![首页](docs/iamges/首页分栏效果.png)

### 功能特性

#### 💬 实时对话
- 通过 Agent SDK 驱动 Claude agent loop,消息按 token 实时流式渲染。
- assistant 消息、工具调用、工具结果以结构化卡片展示。
- 工具审批:允许 / 允许一次 / 拒绝,每个会话独立维护待审批队列。
- 输入框支持附加文件、粘贴图片、斜杠命令。

#### 🗂 多会话 Tab
- 中栏以标签页形式多开会话,每个 tab 独立保持运行中的 turn。
- 关闭 tab **不会**取消后台 turn——事件流继续推送,重新打开 tab 即可看到最新状态。
- 会话持久化到 SQLite(基于 sql.js),支持后续续传(`--resume` 语义)。

#### 🧰 IDE 右栏
- **文件**:当前项目的文件树,基于 Monaco 的差异查看。
- **Git**:查看改动文件、逐行 diff 预览、配置 git 身份。
- **终端**:右栏底部的内置终端(xterm.js + node-pty)。

![Git 差异预览](docs/iamges/git差异预览.png)

#### ⚙️ 丰富的设置
- **模型**:选择模型、设置思考力度、选择权限模式,或填写自定义模型 id(兼容 OpenAI 协议端点)。
- **外观**:主题与密度偏好。
- **终端**:Shell 与字体配置。
- **Git**:作者名 / 邮箱,以及 diff 相关选项。

| 模型设置 | 外观设置 | 终端设置 | Git 设置 |
|---|---|---|---|
| ![模型设置](docs/iamges/模型设置.png) | ![外观设置](docs/iamges/外观设置.png) | ![终端设置](docs/iamges/终端设置.png) | ![Git 设置](docs/iamges/git设置.png) |

#### 🔄 其他
- 自动更新:通过 `electron-updater` 从 GitHub Releases 拉 `latest*.yml`;也可在**设置 → 关于**手动检查。
- Provider 抽象层(`AgentProvider`)——为后续接入其他 agent 平台预留。

### 环境要求

- Node.js ≥ 22.13(pnpm 11 要求)
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
