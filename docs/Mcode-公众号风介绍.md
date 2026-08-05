# Mcode:我用三周,把 Claude Code 装进了一个真正的 IDE

> 一句话:**Mcode**(*my* Code)是一个基于 Claude Agent SDK 打造的桌面端三栏 IDE。它不重新实现 agent,只把 Claude 该有的"工作面"全部补齐——文件能看能 diff、Git 能管多仓、终端能跨项目 keep-alive、浏览器能拾元素丢进对话。

---

## 写在前面:为什么又造一个 IDE?

Claude Code 的 CLI 已经很强,但你用着用着就会发现:它输出的 diff 你要在 VS Code 里看,`git diff` 你要在终端里再敲一遍,网页上有 bug 你得 `Cmd+Tab` 切到 Chrome 复制 HTML……

所以就有了 Mcode。**Mcode = 三栏布局 + Claude Agent SDK + Monaco + xterm.js + WebContentsView**,把"AI × IDE"从口号落到产品默认值:每一步都**可观察、可审查、可逆**。

下面这组数字,是写这篇介绍前我跑了一遍 `find` + `wc` 拿到的真实数据——

---

## 一、先看代码量:这个 IDE 到底"重"不重

| 指标 | 数量 |
|---|---|
| TS / TSX 源文件 | **164** 个 |
| TS / TSX 代码总行数 | **52,136** 行 |
| CSS / HTML 模板 | 11,214 行 |
| React 组件(`.tsx`) | **74** 个,分布在 6 个目录 |
| 主进程 TS 文件 | 49 个 |
| IPC handler(`ipcMain.handle/on`) | **96** 个 |
| 跨进程 zod schema | **278** 条 |
| 共享类型/接口(`packages/contracts`) | 203 条 / 3,047 行 |
| 生产依赖(`apps/desktop`) | 39 个 |

各模块的"份量"也很直观:

| 模块 | 行数 | 关键文件 |
|---|---:|---|
| IDE 右栏(文件/Git/终端/Search/OpenTabs) | **6,638** | `GitRepoCard.tsx` 1,568 行(全场最重) |
| Chat(对话/TipTap/卡片/Markdown) | 8,805 | – |
| Browser(浏览器面板) | 895 | – |
| Layout(三栏/状态栏/标题栏) | – | – |

> 几个"全场第一":
> - **GitRepoCard.tsx**(1,568 行)——单仓的 stage/unstage/discard、commit、push/pull/refresh、分支选择器、tag 切换、AI 提交信息全部塞在了一张卡片里;
> - **FileEditor.tsx**(942 行)——Monaco + 三态视图 + Diff 数据源路由都在它身上;
> - **FileTree.tsx**(564 行)——把"reveal 跳转 + 拖拽到对话 + 上下文菜单"三件套全做了。

数字背后的故事:**Mcode 没有用 monorepo 重型脚手架**(没有 Nx,只有 Turbo;没有 effect-ts、没有 bun),但**显式做了"跨进程契约"**(一个独立的 `@mcode/contracts` 包,96 个 IPC 全部走 zod 校验)。**这是这个项目能"小而完整"的关键——下面你会看到这条主线反复出现**。

---

## 二、文件编辑器:不是把 VS Code 抄一遍

右栏"文件"面板打开后,你会看到一棵文件树 + Monaco 编辑区。这一节我想重点聊三件事:**多语言、三态视图、LSP 集成**。

### 2.1 多语言识别:30+ 种,fallback 不让你看黑屏

`FileEditor.languageForExt()` 维护了一张后缀→Monaco languageId 的映射表,覆盖了:

- **TS/JS 全家桶**:`.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` `.mts` `.cts`
- **静态类型**:`.py` `.go` `.rs` `.java` `.kt` `.swift`
- **系统/后端**:`.c` `.cpp` `.cs` `.php` `.rb`
- **前端**:`.html` `.css` `.scss` `.less` `.xml` `.svg` `.vue`(当 HTML 处理)
- **配置/数据**:`.json` `.yaml` `.toml` `.ini` `.sql` `.dockerfile`
- **Shell / 文档**:`.sh` `.bash` `.zsh` `.md`

**没匹配上?** 自动 fallback 到 `plaintext`,Monaco 不会拒绝渲染——很多 IDE 看到 `.xyz` 就甩你一脸空白,Mcode 不干这事。

### 2.2 三态视图:同一个文件,在不同场景下"该以什么形态出现"是个真问题

文件编辑器最容易被忽视的设计,就是"**当前这个文件,你到底想看什么?**"Mcode 用一个三态机解决:

| 状态 | 触发 | 作用 |
|---|---|---|
| **Edit** | 默认;`Ctrl/Cmd + S` 保存 | 普通可编辑 Monaco,tab 上有脏标记圆点 |
| **Diff** | agent 改完文件后点「审查」;Git 面板点击文件 | 并排对比 `before/after`,关掉"折叠方向"避免双行号栏错乱 |
| **Preview** | `.md` / 图片 / 二进制文件 | Markdown 走 Shiki 高亮 + GFM + KaTeX;透明 PNG 用棋盘背景;Office/zip/pdf 等给"无法预览"提示 |

实现上有个细节我比较喜欢:**Diff 视图的 dispose 顺序是"先 widget 再 models"**,绕开了 Monaco 经典的 `TextModel got disposed before DiffEditorWidget` 报错——这种 BUG 你不踩一次根本写不出来。

### 2.3 LSP 集成:把语言服务器真的接进来

文件编辑器**不是只能看**,内置了四种语言服务:

| 语言 | 用的什么 |
|---|---|
| TypeScript / JavaScript | `typescript-language-server`(npm) |
| Python | `basedpyright-langserver`(活跃 pyright fork)→ fallback 到 `pyright-langserver` |
| Go | `gopls`(`go install`) |
| Java | `jdtls`(macOS brew;Win/Linux 直接下 Eclipse Milestones 解压) |

接入流程是教科书级别的:

1. `ensureLspProviders` 在 Monaco 注册 `definition` / `references` / `hover` provider;
2. 文件改动 → `didChange`,保存 → `didSave` 通知 LSP;
3. 服务端 `publishDiagnostics` 推回 → 转成 Monaco `setModelMarkers` → 红色波浪线直接画在编辑器里;
4. TS LSP 启用时,**主动关掉 Monaco 内置的 tsWorker**,避免双份波浪线打架。

安装是"一条命令到位"的:LSP 设置面板按平台给出 `npm install -g` / `pip install` / `go install` / `brew install` / 直链下载,日志流式回吐,PATH 检测不到还会高亮提示,附"手动下载页"链接。

> 安全:任何 `workspacePath` / `filePath` 进入 LSP 之前都过 `isKnownProjectPath` / `findContainingProject` 守卫——被入侵的渲染层也指不动语言服务去读任意文件。

### 2.4 文件树的小巧思

- **Reveal 跨文件跳转**:在树里点文件,自动展开父目录链 + `scrollIntoView`(用 rAF 轮询,容忍目录懒加载的延迟);
- **右键菜单**:「在资源管理器中显示 / 复制绝对路径 / 复制相对路径 / 添加到聊天 / 打开」一应俱全,操作后弹"已复制"气泡;
- **拖拽到对话**:文件节点 `draggable` 写自定义 MIME,Composer 接收后直接成附件;
- **小圆点标记**:本轮 agent **新建**的文件显示 accent 圆点,**改动**的显示 info 圆点——一眼看出 Claude 干了啥。

---

## 三、Git 面板:多仓 + AI 写 message + AI 解冲突

`GitPanel.tsx` 只有 169 行,但它"挂"着一张 **1,568 行的 `GitRepoCard.tsx`**——这是全场最重的单文件,也是 Mcode 在 Git 模块下功夫最多的地方。

### 3.1 多仓库自动发现

一个项目根目录下经常是 monorepo + 子模块 + 嵌套工程,传统的 Git 工具只盯着根 `.git` 显然不够。

Mcode 的做法是:

- `findGitRepos` 从项目根向下扫 3 层,自动跳过 `node_modules` / `dist` / `build` / `.next` / `.cache` / `.turbo` / `coverage` / `__pycache__` / `.venv` / `target` / `out`……
- 每仓渲染成一张独立的 `GitRepoCard`,**多仓并存、互不干扰**;
- 走的是 `simple-git` 包装的系统 `git` CLI,**认证完全交给用户现有配置**(SSH Key / 凭据管理器 / GCM),Mcode 自己不碰任何凭据;
- 右上角"重新扫描"按钮,clone 新仓后一键拉起。

### 3.2 单仓工作流:五层信息一目了然

一张 `GitRepoCard` 从上到下分五层:

1. **Header**——仓库名 + 当前分支徽章(点击弹分支选择器)+ 领先/落后指示(↑N / ↓N)+ Pull / Push / Refresh 三个远程操作;
2. **已暂存 / 更改 / 操作日志**——分两组折叠展示,**单行 +/- diff 计数异步加载**,hover 出现 Stage / Unstage / Discard 按钮;
3. **提交信息输入框**——自带"提交 / 提交并推送 / 提交并同步"三分支按钮(右键触发下拉);
4. **分支选择器**——按"本地 / 远程 / 标签"分组、带搜索过滤,远端分支若有同名本地则 `git checkout`,否则 `git checkout -b` 建追踪分支;tag 切到 detached HEAD;
5. **新建分支对话框**——从 HEAD 拉新分支,Enter 提交。

### 3.3 行级 Diff & 历史

点文件 → 调 `git diff` 拿 patch → 转回 `before/after` 文本 → 写进 store 的 `gitDiffByProject` 桶 → **中央编辑器以 Monaco DiffEditor 并排展示**。用户可在"以 diff tab 弹窗"和"直接覆盖中央编辑器"两种模式之间切换,stash 化的 `before` 可以回放。

`GitHistoryView`(`历史`子标签)展示 commit log,点 commit 看其文件列表,选中文件进入纯 blob 对比——回看老代码不用离开 IDE。

### 3.4 AI 生成提交信息

提交框右上角那个 ✨ 按钮,**`commitGenModel` 在设置里配置**(可以用 Claude,也可以走 OpenAI 协议端点):

- 从已配置的"模型 + 角色"里取一个可用的 LLM,直接读 `git diff` 输出;
- **生成符合 conventional commit 风格的 message** 写回输入框;
- OpenAI 协议的配置会**自动获取本地 bridge 改写 `baseUrl`**,避免 Claude 二进制把 Anthropic 格式的 `/v1/messages` 打到原 OpenAI 端点 404;
- 提交框支持"最大化"弹窗编辑,Ctrl/Cmd+Enter 直接提交。

> **设计上的克制**:AI 只是"起草",commit 按钮还是要你自己点。

### 3.5 AI 解决合并冲突

`git pull` 返回 `conflict + conflictedFiles` 时,会弹一个**带文件名列表的确认对话框**,而不是干瘪的红 banner:

1. 用户点「用 AI 解决」;
2. 后端读所有冲突文件的 `<<<<<<<` / `=======` / `>>>>>>>` 标记,构造多文件并发解决任务;
3. 解决完成后:**写回文件 → `git add` 暂存 → 保留 merge 状态**;
4. **自动预填一条 `Merge: conflicts auto-resolved by AI (N files)` 的提交信息**,你检查完手动 `commit` 收尾。

同样走 `conflictResolveModel` 配置(支持 OpenAI 协议桥接);失败的话,继续保留红 banner + 可读的 error 详情。

### 3.6 操作日志(诊断信息不丢)

每张卡片底部都有一个 `操作日志` 折叠区,记录最近 20 条 pull / push / commit / sync / stage 操作,**失败条目可点开展示完整错误**——非常适合排查网络/认证问题。

---

## 四、终端:多 Tab + 跨项目 Keep-Alive + 自定义命令

底部 Terminal 面板用的是 **xterm.js + node-pty**。`TerminalView.tsx` 558 行 + `TerminalPanel.tsx` 414 行,虽然体量不是最大,但有几个"看起来无聊但缺它就崩"的细节非常值得说。

### 4.1 多 Tab + 状态指示灯

同一项目内可一键新建任意多终端,标签上带状态指示灯:

- 🟢 **运行**(running)
- 🟡 **启动中**(starting)
- ⚪ **已退出**(exited)
- 🔴 **错误**(error)

**关闭最后一个会自动开一个新 tab**——保证当前项目永远有一个可用终端。这条规则看似 trivial,实际上很多 IDE 让你"关完最后一个才发现我要用")。

### 4.2 跨项目 Keep-Alive:切换项目,后台 PTY 不死

这一条是 Mcode 的**关键技术决策**:

> Terminal 的 state 存在 `useRef` 而**不是 React state**。

为什么?React state 一变,组件就 re-render;`useRef` 不变,组件就不 unmount。结果就是:

- 切换项目时,**不卸载**其他项目的 `TerminalView`;
- 后台 PTY 进程不杀、scrollback 完整保留;
- 切回去看到的就是走之前的样子;
- 只有项目删除/归档时才真正销毁。

更狠的是:TerminalPanel 是被外层 `BottomTerminalBar` keep-alive 的——**折叠只是把高度设为 0**,真正"占内存"的 PTY 一直在跑。这跟 VS Code 把折叠的终端直接 unmount 行为是反着来的,代价是内存占用,但收益是"切回即用"。

### 4.3 pnpm 解包 + spawn-helper 权限坑

`node-pty` 是懒加载的,主进程还修了一个隐藏坑:**pnpm 解包后,`spawn-helper` 二进制会丢 `+x` 权限**。如果不主动 `chmod 0o755`,每次 `pty.spawn` 都会神秘失败。

我以前没踩过这个坑,但凡用 pnpm 打包 Electron 原生模块的同学,都应该知道这事儿。

### 4.4 行尾归一化(修了 PowerShell 的隐藏 Bug)

自定义命令 → 点执行的时候,代码里有一条细节:

```ts
// runCommand: 把 \n / \r\n 全替成 \r 再写入 PTY
const normalized = raw.replace(/\r\n|\n/g, "\r");
pty.write(normalized);
```

这条修了 **PowerShell PSReadLine 把多行命令乱序执行**的隐藏 Bug——`\n` 单独写到 PTY 会被 PSReadLine 当成两次回车,而 `\r` 才是 PTY 的"行尾"。单行命令也保持原行为不变,所以这条归一化是无损的。

### 4.5 自定义命令(项目级)

工具栏右侧的 🔖 书签按钮,点开是当前项目的「自定义命令」面板:

- **所有命令按项目维度存储在 `customCommandsByProject`**,跨项目隔离;
- 弹窗内填名称 + 命令,保存后立刻出现在菜单里;
- 编辑/删除在 `设置 → 终端` 面板,工具栏菜单只承担"执行 + 快速新增"两个高频动作;
- 工具栏:`+` / `清屏` / `终止进程` / `重开` / `🔖 自定义命令`,所有按钮在 PTY 不可用时自动 disabled。

---

## 五、写在最后:把"AI × IDE"做对到底有多难

Mcode 想表达的事情其实很简单:

> **AI 不应该住在终端里**,它应该住在和编辑器、文件、Git、终端、浏览器同一层 UI 里,而且每一步都**可观察、可审查、可逆**。

文件改了能 diff、提交信息可以让 AI 起草但仍要你确认、冲突可以让 AI 解但文件仍由你审、终端可以让快捷命令一键复用但跑的还是你 shell、网页元素可以一键交给 Claude 但选择权在你手上。

为了把这个原则做到底,Mcode 在表面下还做了不少"看起来无聊但缺它就崩"的事:

- **IPC 全部 zod 校验**——96 个 handler 在主进程入口先 parse,所有错误以 `{ ok: false, error }` 形态返回,**绝不把异常抛进渲染进程**;
- **Path 守卫**——`isKnownProjectPath` / `findContainingProject` 在 file / git / lsp / browser 四个域共用,被入侵的渲染层也指不动进程去读任意目录;
- **OpenAI 协议桥接**——`BridgeRegistry` 用引用计数共享同一个本地代理进程,多任务并行不重复起桥;
- **Tab 索引与 bounds 缓存**——`lastBoundsRef` 记忆上次同步的坐标,相同值直接跳过 IPC,缩放/移动窗口时不会抖动。

---

## 六、快速开始

```bash
# 1. 环境要求
node -v    # >= 22.13 (pnpm 11 要求)
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

预编译二进制发布在 [GitHub Releases](https://github.com/huangbh2020/mcode/releases)(macOS `.dmg` arm64+x64、Windows `.exe` x64)。因未做付费代码签名,首次启动会有 Gatekeeper / SmartScreen 拦截,README 中给了完整处理方式(macOS 右键打开、macOS 26+ 系统设置放行、`xattr -dr com.apple.quarantine` 终端命令、`brew install --cask mcode`)。

---

> 如果你认同"AI 应该住在 IDE 里"这个方向,欢迎下载体验、提 Issue、贡献代码。这是一次把"AI × IDE"从口号落到产品默认值的尝试,我会一直做下去。


