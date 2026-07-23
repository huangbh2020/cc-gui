# AGENTS.md

本文件指导 AI agent(含本项目自身用 Claude Code 开发时)如何理解并参与 my-claude-gui 的开发。先读本文,再动手。

---

## 项目是什么

**my-claude-gui** — 基于 `claude` CLI 的 stream-json 协议构建的**桌面端 GUI**(Electron 三栏 IDE)。

核心理念:**不重新实现 agent,只做 claude 的交互界面**。claude 作为黑盒子进程被 spawn,经其官方流式协议驱动;本应用负责会话管理、实时渲染、工具审批、IDE 能力(文件/git/终端)。

- **不打包** `claude.exe`,只调用用户系统已装的 Claude Code
- 项目 MIT,可独立开源
- 架构受 [Synara](https://github.com/Emanuele-web04/synara) 启发,但用主流 TS 重写(无 effect-ts、无 bun)

---

## 权威文档(动手前必读)

| 主题 | 文档 |
|------|------|
| 技术栈、架构、踩坑记录 | [`docs/tech-stack.md`](docs/tech-stack.md) |
| claude stream-json 数据格式(解析器依据) | [`docs/claude-stream-json.md`](docs/claude-stream-json.md) |

改 `ClaudeRuntime` 或涉及 claude 输出解析时,**必须**先读 stream-json 文档——那里每个字段都来自真实 dump,不要凭记忆。

---

## 进程架构(三进程)

```
Renderer (React 19, contextIsolation:true, nodeIntegration:false)
        ↕  Electron IPC(preload contextBridge + zod 校验)
Main (Node.js)
  ├── ClaudeRuntime       spawn claude, 解析 stream-json → RuntimeEvent
  ├── SessionManager      会话生命周期(P2: SQLite)
  └── IDE Services        terminal / git / checkpoint(P4)
        ↕  child_process.spawn(claude CLI, --output-format stream-json)
     claude(用户系统已装,不打包)
```

**安全边界**:renderer 不能 `require()` 任何 Node 模块。通往 Node 的唯一桥梁是 preload 暴露的 `window.api`,所有消息经 zod 校验后才放行。新增 IPC 通道时,必须在 `packages/contracts/src/ipc.ts` 定义 schema + 通道常量,并在 preload 白名单注册。

---

## 目录地图

```
packages/contracts/src/        # 跨进程共享(无运行时逻辑)
  runtime.ts                   # RuntimeEvent 联合 — claude 流事件的归一化目标
  session.ts                   # Project / Session / Message 领域类型
  ipc.ts                       # zod schema + IPC 通道常量 + RPC 类型表

apps/desktop/src/
  main/                        # 主进程
    claude/
      ClaudePathResolver.ts    # 跨平台定位 claude 入口(本机: cli-wrapper.cjs)
      ClaudeRuntime.ts         # ★ spawn + NDJSON 解析(改前读 stream-json 文档)
      RuntimeManager.ts        # 会话↔runtime 映射
    ipc/{claude,projects}.ts   # IPC handler
    lib/logger.ts              # 文件+stderr 日志(userData/logs/main.log)
    store/memoryStore.ts       # 内存存储(P2 换 SQLite)
  preload/index.ts             # contextBridge 白名单 API
  renderer/                    # 前端(React)
    stores/sessionStore.ts     # ★ Zustand store,ingest RuntimeEvent → ChatMessage
    hooks/useClaudeEvents.ts   # 订阅 IPC 事件流
    components/{layout,chat}/  # UI
```

---

## 开发命令

```bash
# 启动开发(electron-vite,HMR)
cd D:\00-huangbh-project\my-claude-gui
pnpm dev

# 类型检查(改完代码先跑这个,最快定位问题)
cd apps/desktop && npx tsc --noEmit -p tsconfig.json

# 构建
pnpm build
```

### ⚠️ 启动前注意
异常退出后,5173 端口可能残留(TIME_WAIT)。若窗口没弹出,先在任务管理器结束所有 `electron.exe`,或等约 30 秒端口释放。

---

## 环境

- Node.js ≥ 20(本机 v25.9.0)
- pnpm ≥ 9(经 `corepack enable` 启用,本机 11.16.0)
- Claude Code CLI(本机装在 `D:\soft\nodejs\node_global`,非默认路径——`ClaudePathResolver` 已处理)
- `.npmrc` 配了国内 electron 镜像(直连 GitHub 会超时),任何人重装不会踩

---

## 编码约定

### TypeScript
- **strict 模式**,全量类型,禁 `any`(必要时用 `unknown` + 收窄)
- 工作区包用别名导入:`@contracts/*`、`@main/*`、`@renderer/*`
- 文件间用 `.js` 扩展名的相对导入(nodeNext 兼容):`import { x } from "./y.js"`
- 改完代码**先 typecheck**:`npx tsc --noEmit -p tsconfig.json`

### Zustand(renderer 状态)
- 选择器**必须返回稳定引用**。禁止 `useStore((s) => arr ?? [])`——每次渲染返回新 `[]` 会触发无限循环(已踩过)。用模块级常量:`const EMPTY: T[] = []`
- 动作(actions)放 store 内,组件只读 + 调用

### IPC
- 新通道:先在 `contracts/ipc.ts` 加 zod schema + `IPC` 常量 → preload 白名单注册 → main handler 用 `Schema.parse(raw)` 校验入参
- main→renderer 推送用 `sendToRenderer(IPC.XXX, msg)`,renderer 用 `api.on.xxx` 订阅

### claude 解析(ClaudeRuntime)
- readline 逐行 parse,**坏行只 warn 不中断**
- 未知 `type` 静默忽略(向前兼容 CLI 升级)
- stream_event 的 text/thinking 增量**只在 delta 渲染**;assistant 完整消息只补全 tool_use,不重发 text(避免重复)
- turn 结束判定:收到 `result` 行发 `turn.done`;若 claude 异常退出无 result,`close` 事件兜底补发

---

## 当前进度

| 阶段 | 状态 | 说明 |
|------|------|------|
| P0 脚手架 | ✅ | 三进程、三栏布局、IPC 契约 |
| P1 端到端 | ✅ | spawn claude + 流式渲染 + 输入框 |
| P2 会话持久化 | ⬜ | better-sqlite3、`--resume` 续传、会话列表 |
| P3 工具审批 | ⬜ | tool 卡片、审批内联条、权限模式 |
| P4 IDE 右栏 | ⬜ | 文件树、git、终端(xterm+node-pty)、Monaco diff |
| P5 体验打磨 | ⬜ | 浏览器预览、checkpoint 时间线、Cmd+K |
| P6 发布 | ⬜ | electron-builder、自动更新、CI |

详见 `docs/tech-stack.md` 第八节。

---

## 关键提醒

1. **改 ClaudeRuntime 前先读 stream-json 文档**。schema 来自真实 dump,字段名不要猜。
2. **不要打包 claude.exe**。License 合规:只调用用户已装的,不内嵌二进制。
3. **新增 IPC 必走 zod 校验**。这是 renderer→Node 的唯一安全边界。
4. **本机的 superpowers 插件 hook 是坏的**(SessionStart 报 ParserError),与本项目无关——claude 会跳过它,日志里看到不要当成我们的 bug。
5. **空白屏调试**:main 进程已把 renderer 的 `console-message` 转发到 stderr,不用开 DevTools 就能从启动日志看渲染层报错。
