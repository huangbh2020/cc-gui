# 技术栈文档

> my-claude-gui — 基于 `claude` CLI stream-json 协议的桌面端 GUI
>
> 本文档记录项目**实际使用**的技术栈与依赖,以及关键的技术决策与踩坑记录。所有版本号来自 `package.json`,与实际安装一致。

---

## 一、整体定位

| 维度 | 选型 |
|------|------|
| 应用形态 | Electron 桌面应用(三栏 IDE 布局) |
| 核心理念 | **不重新实现 agent,只做 claude 的交互界面**。claude 作为黑盒子进程,经官方 stream-json 协议驱动 |
| 与 Claude Code 的关系 | 本应用**不打包** `claude.exe`,只调用用户系统已装的 Claude Code;项目自身 MIT,可独立开源 |
| 架构参考 | [Synara](https://github.com/Emanuele-web04/synara) 的分层设计(provider adapter、归一化 runtime 事件、IPC 边界),但用**主流 TS**重写(无 effect-ts、无 bun) |

---

## 二、进程架构(三进程分层)

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer 进程 (React 19 + Vite)                            │
│  contextIsolation: true, nodeIntegration: false             │
│  ┌──────────┬───────────────────┬────────────────────────┐  │
│  │ 左栏     │  中栏(聊天)       │  右栏(IDE)             │  │
│  │ 项目/会话│  消息流/输入框     │  文件/git/终端/浏览器   │  │
│  └──────────┴───────────────────┴────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  Preload (contextBridge.exposeInMainWorld)                  │
│  只暴露白名单 RPC 句柄,所有消息经 zod 校验                  │
├─────────────────────────────────────────────────────────────┤
│  Main 进程 (Node.js)                                        │
│  ┌───────────────┬────────────────┬─────────────────────┐   │
│  │ ClaudeRuntime │ SessionManager │  IDE Services        │   │
│  │ (spawn 二进制)│ (会话生命周期) │  terminal/git/diff   │   │
│  └───────┬───────┴────────────────┴─────────────────────┘   │
│          │ child_process.spawn(claude, stream-json)          │
└──────────┼──────────────────────────────────────────────────┘
           ▼
      claude CLI(用户系统已装)
```

**为什么三进程而非像 Synara 那样再拆出独立 server 进程**:Synara 拆独立 server 是为了支持 9 个 provider 和多客户端。本项目只需 claude 一个 provider,Electron 主进程内直接持有 `ClaudeRuntime` 即可——少一层进程边界 = 少一层 WebSocket = 更简单更快。架构上预留了"可拆出独立 server"的接口,但默认不拆。

---

## 三、技术栈总览

### 3.1 工具链

| 工具 | 版本 | 用途 |
|------|------|------|
| **Node.js** | ≥ 20(本机 v25.9.0) | 运行时 |
| **pnpm** | ≥ 9(本机 11.16.0,经 corepack 启用) | 包管理 + workspace |
| **Turbo** | ^2.9 | monorepo 任务编排(dev/build/test/typecheck 并行) |
| **TypeScript** | ^5.7 | 全量 TS,strict 模式 |

### 3.2 桌面壳层(apps/desktop)

| 依赖 | 版本 | 角色 |
|------|------|------|
| **Electron** | ^33 | 跨平台桌面运行时 |
| **electron-vite** | ^2.3 | 统一 main/preload/renderer 三路构建,HMR |
| **electron-builder** | ^25 | 打包成安装包(P6) |

### 3.3 前端(apps/desktop/src/renderer)

| 依赖 | 版本 | 角色 |
|------|------|------|
| **React** | ^19 | UI 框架 |
| **react-dom** | ^19 | React 渲染器 |
| **Zustand** | ^5.0 | 本地状态管理(会话、消息流、UI 状态) |
| **Vite** | ^6 | 构建 + HMR |
| **@vitejs/plugin-react** | ^4.3 | Vite 的 React 支持(Fast Refresh) |
| **Tailwind CSS** | ^3.4 | 原子化 CSS |
| **autoprefixer** / **postcss** | ^10.4 / ^8.4 | Tailwind 配套 |

> **TanStack Router / Query、Lexical、Monaco、xterm、react-markdown** 等在总体方案中规划,但**当前(P0–P1)尚未安装**。按阶段引入:P2(TanStack)、P4(xterm/Monaco)、P5(浏览器)。文档会随安装更新。

### 3.4 共享契约(packages/contracts)

| 依赖 | 版本 | 角色 |
|------|------|------|
| **zod** | ^3.24 | 跨进程 IPC 消息的运行时 schema 校验(安全边界) |

`contracts` 是 **source-only workspace 包**(无构建产物),main 和 renderer 都通过 `@contracts/*` 别名直接引源码,类型零漂移。

---

## 四、目录结构

```
my-claude-gui/
├── package.json              # workspace 根(turbo + pnpm)
├── pnpm-workspace.yaml       # workspace 包定义 + onlyBuiltDependencies
├── turbo.json                # 任务编排
├── tsconfig.base.json        # 共享 TS 配置(strict, ESNext, bundler)
├── .npmrc                    # 国内 electron 镜像(关键,见踩坑)
├── docs/                     # ← 本文档所在
├── packages/
│   └── contracts/            # 共享类型 + zod schema(无运行时逻辑)
│       └── src/
│           ├── runtime.ts    # RuntimeEvent 联合(claude 流事件归一化)
│           ├── session.ts    # Project / Session / Message 领域类型
│           ├── ipc.ts        # zod schema + IPC 通道常量 + RPC 类型表
│           └── index.ts
└── apps/
    └── desktop/
        ├── electron.vite.config.ts   # 三路构建配置
        ├── tailwind.config.js
        ├── postcss.config.js
        └── src/
            ├── main/                 # 主进程(Node.js)
            │   ├── index.ts          # app 生命周期 + 单实例锁 + CSP(prod)
            │   ├── window.ts         # 窗口创建 + 控制台转发
            │   ├── utils.ts          # is.dev / uid()
            │   ├── lib/logger.ts     # 文件+stderr 日志
            │   ├── claude/
            │   │   ├── ClaudePathResolver.ts   # 跨平台定位 claude 入口
            │   │   ├── ClaudeRuntime.ts        # spawn + NDJSON 解析
            │   │   └── RuntimeManager.ts       # 会话↔runtime 映射
            │   ├── ipc/
            │   │   ├── index.ts      # 注册所有 handler
            │   │   ├── claude.ts     # 会话/turn/interrupt + healthCheck
            │   │   └── projects.ts   # 项目 CRUD
            │   └── store/memoryStore.ts  # 内存存储(P2 换 SQLite)
            ├── preload/
            │   └── index.ts          # contextBridge 白名单 API
            └── renderer/             # 前端(React)
                ├── App.tsx
                ├── stores/sessionStore.ts   # Zustand 核心 store
                ├── hooks/useClaudeEvents.ts # 订阅 IPC 事件流
                ├── lib/api.ts               # window.api 类型封装
                └── components/
                    ├── layout/   # ThreePaneLayout/TopBar/LeftBar/RightPanel/StatusBar
                    └── chat/     # ChatPane/MessageBlocks
```

---

## 五、关键技术决策

### 5.1 为什么 spawn 二进制而非用 Agent SDK?

| 维度 | spawn claude.exe | Agent SDK |
|------|------------------|-----------|
| 出活速度 | ⚡ 最快 | 中 |
| 能改 agent 行为 | ✗ 黑盒 | ✅ 完全控制 |
| 能用 Max 订阅 | ✅ **能**(走订阅不按 token 付费) | ✗ 走 API key |
| 维护成本 | 🔴 高(追 CLI 变动) | 🟡 中 |

本项目优先**出活快 + 能用现有订阅**,选 spawn。代价是 stream-json schema 不稳定,故解析层做了容错(见 `ClaudeRuntime`)。

### 5.2 为什么不用 Synara 的 effect-ts?

Synara 全栈用 effect-ts(Layer/Service 函数式框架)且依赖**预发布版本**(pkg.pr.new 构建)。这带来高代码质量,但二开门槛陡峭——改任何后端逻辑都要懂 effect。本项目定位"主流、易维护、可协作",坚持用普通 async/await + 事件发射器。

### 5.3 为什么 IPC 用 Electron IPC 而非独立 WebSocket?

Synara 拆独立 server 后用 WebSocket 通信(为多客户端/多 provider)。本项目单 provider + 单窗口,用 Electron 原生 `ipcMain.handle` / `webContents.send` 足矣,少一层协议。所有 IPC 消息经 zod 校验后才放行,防渲染层被攻破后任意 spawn。

---

## 六、踩坑记录(实战)

### 6.1 pnpm 11 忽略构建脚本 → Electron 二进制不下载
**现象**:`pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS: electron, esbuild`,Electron 的 postinstall 不执行,`dist/electron.exe` 缺失,dev 起不来。
**根因**:pnpm 11 默认禁止依赖跑 install 脚本(供应链安全)。
**解决**:在 `pnpm-workspace.yaml` 配 `onlyBuiltDependencies: [electron, esbuild]`。注意 pnpm 11 不再读 package.json 的 `pnpm` 字段,必须放 workspace yaml。

### 6.2 Electron 二进制下载超时(GitHub 被墙)
**现象**:手动跑 `install.js` 报 `connect ETIMEDOUT 20.205.243.166:443`(GitHub releases IP)。
**根因**:Electron postinstall 从 GitHub 下载二进制,国内网络直连超时。
**解决**:`.npmrc` 配 `electron_mirror=https://registry.npmmirror.com/-/binary/electron/`。**已固化**,任何人重装不会踩。

### 6.3 electron-vite 入口路径不匹配
**现象**:`No electron app entry file found: dist-electron/main.js`。
**根因**:electron-vite 默认输出到 `out/main/index.js`,而 package.json `main` 字段写的是 `dist-electron/main.js`。
**解决**:`package.json` 的 `main` 改成 `./out/main/index.js`。

### 6.4 空白屏之一:Zustand 无限渲染循环
**现象**:界面一片空白,控制台 `Maximum update depth exceeded`。
**根因**:ChatPane 的 messages 选择器 `useSessionStore((s) => ... ? s.x ?? [] : [])` 每次渲染返回**新的字面量 `[]`**,Zustand 用 `Object.is` 比较发现引用变化 → 重渲染 → 又返回新 `[]` → 死循环。
**解决**:用模块级常量 `const EMPTY_MESSAGES: ChatMessage[] = []` 保证空数组引用稳定。

### 6.5 空白屏之二:CSP 拦截 Vite HMR
**现象**:React 根本不挂载,`<div id="root">` 永远空。
**根因**:index.html 的严格 CSP `script-src 'self'` 在 dev 模式拦截了 Vite 注入的 inline HMR 脚本。
**解决**:CSP 从 index.html 移到 main 进程,**仅生产模式**用 `onHeadersReceived` 注入;dev 无 CSP。

### 6.6 Windows 上 spawn claude 的 ENOENT 陷阱
**现象**:`spawn claude ENOENT`。
**根因**:Node 的 `child_process.spawn` 在 Windows 不走 PATH 解析 `.cmd` shim。
**解决**:`ClaudePathResolver` 不依赖 PATH,而是定位到真实入口 `cli-wrapper.cjs` 并用 `node` 启动;若只能用 `.cmd` 则 `shell: true`。

---

## 七、版本与升级注意

- **Electron 主版本锁定** ^33(非 latest)。升级时注意原生模块(node-pty 等,P4 引入)需 `electron-rebuild`。
- **Zustand v5** 的 `create` API 与 v4 一致,但选择器必须返回稳定引用(见 6.4)。
- **React 19** 的 `react-dom/client` `createRoot` + StrictMode;注意 StrictMode 下 effect 执行两次,订阅需保证幂等。
- **Tailwind v3** 而非 v4(v4 配置语法不同,本项目用 `tailwind.config.js` + postcss,属 v3 范式)。

---

## 八、各阶段引入计划(路线图)

| 阶段 | 引入的技术 | 状态 |
|------|-----------|------|
| P0 脚手架 | Electron / React / TS / Tailwind / Vite / Turbo / pnpm | ✅ 完成 |
| P1 端到端 | Zustand / zod IPC | ✅ 完成 |
| P2 会话持久化 | better-sqlite3 | ⬜ 待开始 |
| P3 工具审批 | (复用现有 zod) | ⬜ |
| P4 IDE 右栏 | xterm.js + node-pty / isomorphic-git / Monaco | ⬜ |
| P5 体验打磨 | react-markdown + remark / KaTeX / Cmd+K | ⬜ |
| P6 发布 | electron-builder / electron-updater / Vitest / Playwright | ⬜ |
