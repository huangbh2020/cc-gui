# Mcode —— 把 Claude Agent 装进一个真正可用的 IDE

> **一句话定位**：基于 Claude Agent SDK 构建的桌面端三栏 IDE，**不重新实现 agent**，只提供完整的交互表面：多会话实时对话、Monaco 文件编辑器、多仓库 Git 管理、可深度定制的集成终端，以及内置可拾取元素的浏览器。把"AI × IDE"从口号落到产品默认值。

---

## 一、项目概览

Mcode 是一个面向开发者的 Electron 桌面应用，目标是让 Claude Code 不再只是命令行里的流式输出，而是拥有和现代 IDE 等价的操作体验：看得见的文件、调得出的 diff、跑得动的终端、验得了的网页。

**技术栈一览**：

| 层级 | 技术 |
| --- | --- |
| 外壳 | Electron 33、electron-vite、electron-builder 25 |
| 前端 | React 19、Zustand 5、Tailwind CSS 3、@base-ui/react、@tabler/icons |
| 编辑器/终端 | Monaco Editor、xterm.js + node-pty |
| Agent | @anthropic-ai/claude-agent-sdk、electron-updater |
| 持久化 | sql.js（纯 WASM 的 SQLite） |
| 契约 | zod（跨进程 IPC 校验） |
| 工具链 | pnpm 11、Turbo、TypeScript 5（strict） |

> Mcode 已发布 macOS（arm64 / x64 `.dmg`）与 Windows（NSIS `.exe`）预编译版本，源码遵循 MIT 协议。

---

## 二、实时对话（贯穿所有功能的中枢）

虽然本篇重点是四大核心模块，但所有"编辑器/Git/终端/浏览器"动作最终都要汇入 Claude 对话流。

- **按 token 流式渲染**：通过 Agent SDK 驱动 Claude agent loop，消息以 token 为单位实时推送到 UI；assistant 消息、工具调用、工具结果以**结构化卡片**展示，而不是一大坨原始文本。
- **工具审批**：每个会话独立维护一个"待审批队列"，工具调用以 allow / allow-once / deny 三档处理，避免 agent 在后台"放飞自我"。
- **多会话 Tab**：中栏以标签页形式同时打开多个会话，每个 tab 独立持有正在运行的 turn。**关闭 tab 不会取消后台 turn** —— 事件流继续推送，重新打开 tab 时看到的是最新状态。
- **会话持久化**：会话写入 SQLite（基于 sql.js 的纯 WASM SQLite），重启后可"续传"（`--resume` 语义），做到真正不丢上下文。
- **输入体验**：输入框支持附加文件、粘贴图片、斜杠命令；从文件树或浏览器拾取元素**拖拽到对话**或一键附入上下文。

---

## 三、文件编辑器（多语言 + LSP + Diff 全打通）

Mcode 的右栏"文件"面板不是把 VS Code 抄一遍，而是把 Monaco 嵌进了 IDE 必要的工作流里。

### 3.1 多语言智能识别

`FileEditor.languageForExt()` 覆盖了 30+ 常见语言，包括：

- **TypeScript / JavaScript**（`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.mts`/`.cts`）
- **Python、Go、Rust、Java、Kotlin、Swift**
- **C / C++ / C#、PHP、Ruby**
- **HTML / CSS / SCSS / Less / XML / SVG**
- **JSON、YAML、TOML、INI、SQL、Dockerfile**
- **Shell（bash / zsh / sh）、Markdown**
- **Vue**（以 HTML 处理）
- 未知后缀自动 fallback 到 plaintext，不会让 Monaco 拒绝渲染。

### 3.2 三态文件视图

- **Edit**：正常可编辑 Monaco 实例，Ctrl/Cmd + S 保存。
- **Diff**：Monaco DiffEditor 左右并排对比，关闭"折叠方向"在窄列下仍保持真正的 side-by-side，避免双行号栏的视觉错乱。
- **Preview**：
  - Markdown 渲染（Shiki 代码高亮 + GFM + 数学公式）
  - 图片预览（透明 PNG 用棋盘背景展示，点击切换 1:1 缩放）
  - 二进制文件（Office / 压缩包 / 字体 / PDF 等）给出友好的"无法预览，可在系统中打开"提示。

### 3.3 脏标记 + 保存指示

- 文件改动时，tab 上显示圆点
- 保存过程中底部弹出"保存中 / 已保存 / 保存失败"轻量 toast
- `OpenTabsBar` 支持"多标签页"与"单文件替换"两种编辑器打开模式，任意时点都能切回 tabs

### 3.4 Reveal 跨文件跳转 + 上下文菜单

- 在文件树中选中一个文件时，自动展开父目录链、`scrollIntoView` 该节点（用 rAF 轮询，容忍目录懒加载的延迟）。
- 右键文件/目录统一提供「在资源管理器中显示」「复制绝对路径」「复制相对路径」「添加到聊天」「打开」等动作，操作后还会浮出一个 "已复制" 提示气泡。
- 文件节点 `draggable` 写入自定义 MIME，Composer 接收后直接作为附件加入当前会话。
- 本轮 agent 新建的文件显示 **accent 圆点**，改动的文件显示 **info 圆点**，一眼看出 Claude 干了啥。

### 3.5 LSP 集成（把语言服务器跑起来）

文件编辑器不只是"能看"，还把主流语言服务真正接进了 Monaco。

- **四种内置语言服务**（`languageSpecs.ts`）：
  - **TypeScript / JavaScript**：`typescript-language-server`（npm 全局安装）
  - **Python**：`basedpyright-langserver`（基于活跃维护的 pyright fork，优先匹配；无则回退 `pyright-langserver`）
  - **Go**：`gopls`（`go install` 安装）
  - **Java**：`jdtls`（macOS 通过 brew；Win/Linux 由管理器直接下载 Eclipse Milestones 解压，需要本机 JDK 17+）
- **完整 LSP 能力**：在 Monaco 里注册 `definition` / `references` / `hover` 等 provider，文件改动走 `didChange`、保存走 `didSave` 通知给服务器，并把 `publishDiagnostics` 标记为 Monaco model 上的 markers，语法/类型错误会直接画在编辑器里。
- **TS worker 去重**：TS LSP 启用时，关掉 Monaco 内置 tsWorker 诊断，避免双份波浪线。
- **一键安装/卸载**：LSP 面板按平台给出安装命令（npm / pip / go / brew / 直链下载），安装日志流式回吐；若 PATH 检测不到二进制，UI 会高亮提示并附"手动下载页"链接。
- **路径安全**：任何 `workspacePath` / `filePath` 进入 LSP 之前都过 `isKnownProjectPath` / `findContainingProject` 守卫，被入侵的渲染进程也指不动语言服务去读任意文件。
- **崩溃恢复**：子进程非主动关闭时从 Map 移除 + 推 `stateChanged{running:false}`；下次 `request` 自动 `ensureServer` 重启。

### 3.6 文档级 Diff 整合

`FileEditor` 同时监听三种 diff 来源，优先级如下：

1. **turn-files 卡片覆盖**：用户点「审查」时，卡片里冻结的 `before` 快照（对历史 turn 仍然有效）
2. **Git 面板**：项目维度的 `gitDiffByProject` 桶，工作区或历史 commit 任一来源
3. **本轮 turn-files**：最近一次 agent 改动后冻结的文件快照

Diff 模型自己管理生命周期，Dispose 顺序为"先 widget 再 models"，绕过了 `TextModel got disposed before DiffEditorWidget` 那个经典 Monaco 报错。

---

## 四、Git（多仓库管理、生成提交信息、AI 处理冲突）

Git 面板不是单一仓库的"git status"，它直接把一个项目目录里**多个仓库**（monorepo、子模块、嵌套工程）**同时呈现**。

### 4.1 多仓库自动发现

- **递归扫描**：`findGitRepos` 在项目根向下 3 层（可配置）扫描 `.git` 目录，自动跳过 `node_modules` / `dist` / `build` / `.next` / `.cache` / `.turbo` / `coverage` / `__pycache__` / `.venv` / `venv` / `target` / `out` 等无关注目录，既保证 monorepo 内各包能被识别，又避免慢扫描。
- **每仓一张卡**：`GitPanel` 把发现到的每个 repo 都渲染成独立的 `GitRepoCard`，多仓并存、互不干扰；右上角有"重新扫描"按钮，clone 新仓后一键拉起。
- **走系统 Git**：`simple-git` 包装系统 `git` CLI，**认证完全交给用户现有配置**（SSH Key / 凭据管理器 / GCM），Mcode 自身不接触任何凭据。

### 4.2 单仓的完整工作流

每张 `GitRepoCard` 从上到下分为五层：

1. **Header**：仓库名 + 当前分支徽章（点击弹出分支选择器）+ 领先/落后指示（↑N / ↓N）+ Pull / Push / Refresh 三个远程操作。
2. **已暂存 / 更改 / 操作日志**：分两组折叠展示，**单行 +/- diff 计数**异步加载，hover 出现单文件 Stage / Unstage / Discard 操作按钮。
3. **提交信息输入框**：自带"提交 / 提交并推送 / 提交并同步"三分支按钮（右键触发下拉）。
4. **分支选择器（Menu）**：按"本地 / 远程 / 标签"分组，带搜索过滤，远端分支若有同名本地则 `git checkout`，否则 `git checkout -b` 建追踪分支；tag 进入 detached HEAD。
5. **新建分支对话框**：从 HEAD 拉新分支并切过去，支持 Enter 提交。

### 4.3 行级 Diff 与历史

- 点击文件 → 调 `git diff` 拿到 patch → 转回 `before` / `after` 文本 → 写进 store 的 `gitDiffByProject` 桶 → 在**中央编辑器**以 Monaco DiffEditor 并排展示（`useInlineViewWhenSpaceIsLimited: false`，避免窄列下变成双行号栏）。
- 用户可在"以 diff tab 弹窗"和"直接覆盖中央编辑器"两种模式之间切换，stash 化的 `before` 可以回放。
- **GitHistoryView**（`历史`子标签）：展示 commit log，点击 commit 看其文件列表，选中文件进入纯 blob 对比。

### 4.4 AI 生成提交信息

提交框右上角带一个 ✨ 按钮（`commitGenModel` 在设置中配置）：

- 从已配置的"模型 + 角色"里取一个可用的 LLM，直接读 `git diff` 输出，**生成符合 conventional commit 风格的 message** 写回输入框。
- **OpenAI 协议端点桥接**：`resolveModelForGitOp` 会判断协议，OpenAI 协议的配置会**自动获取本地 bridge 改写 `baseUrl`**，避免 Claude 二进制把 Anthropic 格式的 `/v1/messages` 打到原 OpenAI 端点 404。
- 提交后 AI 文字支持"最大化"弹窗编辑，Ctrl/Cmd+Enter 直接提交。

### 4.5 AI 解决合并冲突

`git pull` 返回 `conflict + conflictedFiles` 时，会弹出一个**带文件名列表的确认对话框**，而不是干瘪的红 banner：

- 用户点击"用 AI 解决"后，后端读取每一个冲突文件的 `<<<<<<<` / `=======` / `>>>>>>>` 标记，构造多文件并发解决任务。
- 解决完成后：**写回文件、`git add` 暂存、保留 merge 状态**，并**自动预填一条 `Merge: conflicts auto-resolved by AI (N files)` 的提交信息**，让用户检查后手动 `commit` 收尾。
- 同样走 `conflictResolveModel` 配置（支持 OpenAI 协议桥接）；若失败，继续保留红 banner 与可读的 error 详情。

### 4.6 操作日志（诊断信息不丢）

每个仓的卡片底部都有一个 `操作日志` 折叠区，记录最近 20 条 pull / push / commit / sync / stage / unstage / discard 操作，**失败条目可点开展示完整错误信息**，非常便于排查网络/认证问题。

---

## 五、终端（多 Tab + 跨项目 Keep-Alive + 自定义命令）

底部 Terminal 面板（xterm.js + node-pty）也是 Mcode 的高完成度模块。

### 5.1 多 Tab + 跨项目 Keep-Alive

- **多 Tab**：同一项目内可一键新建任意多终端，标签带状态指示灯（运行 / 启动中 / 已退出 / 错误），关闭最后一个会自动开一个新 tab，保证当前项目永远有一个可用终端。
- **跨项目 Keep-Alive**：state 存在 `useRef` 而非 React state，切换项目时**不卸载**其他项目的 TerminalView，后台 PTY 不被杀，scrollback 完整保留，切回去看到的是走之前的样子。只有项目删除/归档时才真正销毁。
- **关掉面板 PTY 也不死**：TerminalPanel 是被外层 BottomTerminalBar keep-alive 的，折叠只是把高度设为 0，真正"占内存"的 PTY 一直在跑。
- **权限校验**：`node-pty` 懒加载，主进程还修了一个 pnpm 解包后 `spawn-helper` 缺 +x 的坑（主动 `chmod 0o755`），否则每次 `pty.spawn` 都会神秘失败。
- **行尾归一化**：`runCommand` 里把 `\n` / `\r\n` 全替成 `\r`，修了 PowerShell 把多行命令乱序执行的隐藏 Bug。

### 5.2 自定义命令（项目级）

- 工具栏右侧带一个 🔖 书签按钮，点开是当前项目的「自定义命令」面板，**所有命令按项目维度存储在 `customCommandsByProject`**，跨项目隔离。
- **快速添加**：弹窗内填名称 + 命令即可，保存后立刻出现在菜单里，下次直接点。
- **执行回显**：点击命令后，**统一归一化 `\n` / `\r\n` 为 `\r` 再写入 PTY**——这条细节修了 PowerShell PSReadLine 把多行命令乱序执行的 Bug，单行命令也保持原行为不变。
- **编辑/删除**：完整的增删改查在 `设置 → 终端` 面板，工具栏菜单只承担"执行 + 快速新增"两个高频动作。

### 5.3 终端工具栏

`+ 清屏 / 终止进程 / 重开 / 自定义命令` 一应俱全，所有按钮在 PTY 不可用时自动 disabled，操作反馈以小图标 / 文字按钮呈现。

---

## 六、浏览器（多 Tab + 移动端尺寸适配 + 元素拾取）

Mcode 在主窗口之上叠了一个**完整浏览器面板**，由主进程通过 `WebContentsView` 在 OS 层覆盖渲染层之上，渲染层只负责测量占位 div 的 `getBoundingClientRect` 推回主进程 `setBounds`。

### 6.1 多 Tab

- **创建/关闭 tab**：`BrowserManager.create()` 创建一个独立 view（自带 contextIsolation + 受限 preload，外部链接走系统浏览器，绝不内嵌），Renderer 端 `BrowserTabs` 负责条带 UI。
- **保持浏览状态**：关闭面板只 `view.hide()` 而不销毁，重新打开恢复；`disposeAll()` 仅在 App 退出时调用。
- **路由机制**：所有 `browser:event` 推送（导航/loading/pickResult）都带 `browserId`，Renderer 通过 ref 镜像的 `tabsRef` 找到对应 tab 并更新。
- **标题栏徽章**：`setBrowserTabCount` 把 tab 数量推到 store，顶栏 Browser 按钮实时显示角标。

### 6.2 移动端尺寸适配

工具栏右侧提供 **桌面 / iPhone / Android** 三档切换（`BrowserDevicePreset`）：

- `desktop` → 满 stage 宽
- `iphone` → 视口缩到 390px，水平居中，两侧留白
- `android` → 视口缩到 412px，水平居中

主进程同步调 Chromium 的 device emulation（视口 + 触摸 + UA），Renderer 端把 view 的 bounds 收窄到对应设备宽度，**叠加一个真正的移动端渲染环境**，而不只是把窗口变窄。`syncBounds` 用 `ResizeObserver` + window `resize` 双监听，所有变化走 rAF 节流；切换设备时还会清空 `lastBoundsRef` 让新尺寸穿透去重检查。

### 6.3 元素拾取（把网页元素交给 Claude）

工具栏上的 🎯 按钮开启 **拾取模式**：

- 主进程通过 `webContents.executeJavaScript` 把 `pickerScript.ts` 注入到页面主世界。
- 注入脚本会：
  - 给页面盖一个 pointer-events:none 的高亮框，hover 元素实时跟随
  - hover 时**生成稳定 CSS 选择器**（优先 `#id`、次选 `class` 链，必要时回退到 `:nth-child` 路径，深度上限 5 层）
  - 读取元素 `outerHTML`（截断到 2000 字符，防止巨型子树把 prompt 撑爆）
  - 点击 → 通过 `window.mcodeBridge.pickElement`（preload 暴露）→ `ipcRenderer.send` → 主进程 → 推回渲染层 `pickResult` 事件

**多选 + 暂存**：`BrowserPanel` 不立刻把元素丢进对话，而是**先进入 PickedElementsBar**（Chrome 风格底部下载条），用户可以连点多个、随时删错、最后再统一「添加」。`pickMode` 不跨 tab（切 tab 时自动关闭）。

**浮窗预览**：每次拾取还会在屏幕底部弹出一个"已拾取到列表"的绿色提示卡（带 selector 文本），1800ms 自动消失，提供即时反馈。

**送入对话**：点「添加」 → `enqueueChatElement` 把所有暂存元素入队 composer → 自动关闭浏览器面板回到主工作区，用户可以马上 @ 给 Claude 描述问题。

### 6.4 安全模型

- 每个 view：`contextIsolation: true`、`nodeIntegration: false`、最小 preload，只暴露 `mcodeBridge.pickElement`。
- `setWindowOpenHandler` 拦截 `target=_blank` / `window.open`，**直接转交系统浏览器**，不在内嵌视图里开新窗口。
- 拾取脚本对原页面**只读**：只挂监听、加一个 overlay 元素，绝不修改用户页面 DOM。

---

## 七、为什么把"AI × IDE"这件事做对不容易

Mcode 在表面下做了不少"看起来无聊但缺它就崩"的事情，举几个例子：

- **IPC 全部 zod 校验**：跨进程 schema（`@contracts/ipc`）用 zod 在主进程入口先 parse，所有错误以 `{ ok: false, error }` 形态返回，**绝不把异常抛进渲染进程**。
- **Path 守卫**：`isKnownProjectPath` / `findContainingProject` 在 file / git / lsp / browser 四个域共用，**避免被入侵的渲染层把进程指到任意目录**。
- **PTY 行尾归一化**：在 `runCommand` 里把 `\n` / `\r\n` 全替成 `\r`，修了 PowerShell 把多行命令乱序执行的隐藏 Bug。
- **DiffEditor Dispose 顺序**：`keepCurrentOriginalModel` + 手动 `editor.dispose()` 先 widget 再 models，绕开 Monaco 的 dispose race。
- **跨项目 Keep-Alive** 用 `useRef` 而非 React state，避免误以为"切换项目"会卸载其他终端。
- **OpenAI 协议桥接**：`BridgeRegistry` 用引用计数共享同一个本地代理进程，多任务并行不重复起桥。
- **Tab 索引与 bounds 缓存**：`lastBoundsRef` 记忆上次同步的坐标，相同值直接跳过 IPC，缩放/移动窗口时不会抖动。

---

## 八、配套能力一览

虽然不在主标题里，但这些能力直接决定了"Mcode 到底能不能干活"：

- **多模型 / 自定义模型**：`@anthropic-ai/claude-agent-sdk` 主线 + 自定义 `ApiConfig`，支持 **OpenAI 协议端点**（通过本地 Bridge 改写 `/v1/messages` 到 Anthropic 格式）；支持 per-role 选定不同模型（普通对话 / 提交信息生成 / 冲突解决可分别配）。
- **LSP 设置面板**：可视化启用/禁用语言服务、查看安装日志、一键跳到手动下载页。
- **快捷键面板**：可视化录制快捷键，直接持久化。
- **主题 / 密度 / 字体 / 终端 Shell**：全部可在设置中切换，主题通过 `<html class="dark">` + Monaco `setTheme` 双向同步。
- **自动更新**：`electron-updater` 拉 GitHub Releases 的 `latest*.yml`；**设置 → 关于** 里可手动检查。
- **Provider 抽象层**：`AgentProvider` 已经为未来接入其他 agent 平台留好接口。

---

## 九、快速开始

```bash
# 1. 环境要求
node -v    # >= 22.13（pnpm 11 要求）
pnpm -v    # >= 9
export ANTHROPIC_API_KEY=sk-ant-...

# 2. 安装 + 启动
pnpm install
pnpm dev

# 3. 类型检查 / 构建 / 打包
pnpm typecheck
pnpm build                  # electron-vite
pnpm package                # macOS dmg/zip + Windows nsis -> apps/desktop/release/
```

预编译二进制发布在 [GitHub Releases](https://github.com/huangbh2020/mcode/releases)（macOS `.dmg` arm64+x64、Windows `.exe` x64）。因未做付费代码签名，首次启动会有 Gatekeeper / SmartScreen 拦截，README 中给出了 macOS 右键打开、macOS 26+ 系统设置放行、`xattr -dr com.apple.quarantine` 终端命令、`brew install --cask mcode` 等完整处理方式。

---

## 十、结语

Mcode 想表达的事情其实很简单：**AI 不应该住在终端里**，它应该住在和编辑器、文件、Git、终端、浏览器同一层 UI 里，而且每一步都**可观察、可审查、可逆**。文件改了能 diff、提交信息可以让 AI 起草但仍要你确认、冲突可以让 AI 解但文件仍由你审、终端可以让快捷命令一键复用但跑的还是你 shell、网页元素可以一键交给 Claude 但选择权在你手上。

这是一次把"AI × IDE"从口号落到产品默认值的尝试。如果你也认同这个方向，欢迎下载体验 / 提 Issue / 贡献代码。
