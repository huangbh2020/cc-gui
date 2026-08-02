## 右栏文件树搜索交互改造:内联搜索 → 搜索弹框

### 目标
将右侧栏 Files 面板顶部的**常驻内联搜索框**改为一个**搜索按钮**;点击按钮打开**搜索弹框**,弹框支持**文件名搜索**(`api.file.search`)和**文件内容搜索**(`api.file.grep`)两种模式。打开结果文件后弹框保持打开(VS Code 全局搜索风格),按 Esc 或关闭按钮关闭。

### 设计依据(复用现有模式)
- 弹框开关状态走 store 标志位,模式同 `commandPaletteOpen` / `setCommandPaletteOpen`(`sessionStore.ts:313, 3459`)。
- 弹框组件在 App 根挂载一次,模式同 `CommandPalette`(顶层挂载)和 `GitDiffDialog`(App.tsx:104, 166)。
- 搜索逻辑(防抖 + `reqIdRef` 防竞态 + 模式切换 + 键盘导航 + 结果高亮)直接搬迁自现有 `FilesPanel.tsx` 的成熟实现——后端 IPC(`file.search` / `file.grep`)已就绪,无需改后端或契约。
- 复用 `ui/dialog.tsx` 的 `Dialog` 组件 + `cn()` + 语义 token + `@tabler/icons-react`。

### 改动清单(6 个文件)

#### 1. 新建 `apps/desktop/src/renderer/components/ide/SearchDialog.tsx`(核心)
弹框组件,包含:
- **头部**:搜索输入框(autoFocus)+ 模式切换按钮(`name` ↔ `content`,图标 `IconFileSearch` / `IconTextScan2`)+ 内容模式下额外的大小写敏感切换按钮(图标 `IconLetterCase`,对接 `FileGrepSchema` 已有但未暴露的 `caseSensitive` 字段)+ 清除/加载指示。
- **结果区**:`name` 模式渲染 `NameSearchResults`(文件名 + 相对路径);`content` 模式渲染 `ContentSearchResults`(按文件分组 + 行号 + `<mark>` 高亮匹配)。这两块及 `groupByFile` / `HighlightedLine` 从 `FilesPanel.tsx` 迁移过来。
- **键盘导航**:↑/↓ 移动 activeIdx、Enter 打开当前项(`openFileInIde`)、Esc 清空(已聚焦时)或关闭弹框。
- **底部**:键位提示(↑↓ 导航 / ↵ 打开 / esc 关闭)+ 结果计数,样式对齐 CommandPalette。
- 弹框规格:`w-[min(92vw,640px)]`、结果区 `max-h-[70vh] overflow-y-auto`,居中(复用 `Dialog.Popup`)。`Dialog.Backdrop` 已自带从标题栏下方开始的遮罩。
- 打开文件用 `useSessionStore` 的 `openFileInIde(path)`,文件在中间栏编辑器打开(与原行为一致)。
- `projectPath` 取自当前活动项目;无项目时弹框内显示空态提示(复用 `EmptyState` 思路)。
- 点击结果打开文件后**不关闭弹框**(保持打开,便于连续查看多个结果)。

#### 2. 改 `apps/desktop/src/renderer/components/ide/FilesPanel.tsx`(瘦身)
- **移除**:内联搜索行、`mode/query/nameResults/grepResults/loading/activeIdx` 等全部搜索状态、防抖搜索 `useEffect`、`onSearchKeyDown`、`toggleMode`、`NameSearchResults` / `ContentSearchResults` / `groupByFile` / `HighlightedLine`(全部迁到 SearchDialog)。
- **新增**:一个紧凑头部——左侧 "文件" 标题、右侧一个搜索按钮(`IconSearch`),点击调用 `setSearchDialogOpen(true)`。
- 主体直接挂 `<FileTree key={projectPath} projectPath={projectPath} />`(不再有搜索/树切换)。文件树获得完整高度。
- 保留无项目的 `EmptyState`。
- 清理不再使用的 import(`api`、`FileSearchEntry`/`FileGrepEntry`、`IconSearch` 等)。

#### 3. 改 `apps/desktop/src/renderer/stores/sessionStore.ts`(加状态)
- 接口加 `searchDialogOpen: boolean;`(紧跟 `commandPaletteOpen`)。
- 初始值加 `searchDialogOpen: false,`(紧跟 `commandPaletteOpen: false,` 行 1796)。
- 加 action `setSearchDialogOpen: (open) => set({ searchDialogOpen: open })`(紧跟 `setCommandPaletteOpen` 行 3459)。
- 接口里声明 `setSearchDialogOpen: (open: boolean) => void;`(紧跟 `setCommandPaletteOpen` 声明)。
- **不持久化**(与 `commandPaletteOpen` 一致,纯内存态)。

#### 4. 改 `apps/desktop/src/renderer/App.tsx`(挂载 + 全局快捷键)
- import `SearchDialog`,在顶层(与 `<CommandPalette />` 并列,行 104 附近)挂载一次:`<SearchDialog />`。
- 新增全局 `Cmd/Ctrl+Shift+F` 快捷键打开搜索弹框(模式照搬现有 `Cmd+K` 逻辑,行 90-99):handler 内 `setSearchDialogOpen(!useSessionStore.getState().searchDialogOpen)`,`preventDefault`。与 `Cmd+K` 互不冲突。

#### 5. 改 `apps/desktop/src/renderer/lib/commands.ts`(命令面板入口)
- 加一条静态命令(放进 "视图" 组,紧随 `view.right-panel.files`):
  - `id: "files.search"`、`label: "搜索文件"`、`group: "视图"`、`keywords: ["search","files","grep","搜索","查找","文件"]`、`icon: IconSearch`、`shortcutHint: "⌘⇧F"`、`perform: (s) => s.setSearchDialogOpen(true)`、`available: (s) => s.activeProjectId !== null`。
- import `IconSearch`。

#### 6. 改 `apps/desktop/src/renderer/lib/icons.tsx`(补图标)
- 在 Tabler re-export 块补 `IconLetterCase`(大小写敏感切换按钮用)。`IconSearch`/`IconFileSearch`/`IconTextScan2`/`IconFile`/`IconChevronDown`/`IconX`/`IconLoader2`/`IconFolderPlus` 已导出,无需再加。**不加 regex**(后端 grep 是子串匹配,不做正则,避免改契约)。

### 不改动的部分
- 后端 IPC / `packages/contracts`(现有 `file.search`、`file.grep` 完全够用)。
- `FileTree.tsx`(行为不变,只是拿到更大展示区)。
- preload(无新通道)。

### 验证
- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`(按 AGENTS.md 约定,改完先跑类型检查)。
- 手动验证:点 Files 面板搜索按钮 → 弹框打开、输入即时搜索、切模式、大小写开关、↑↓ 键盘导航、Enter 打开文件(中间栏)、Esc 关闭、`Cmd+Shift+F` 打开、命令面板 "搜索文件" 打开。