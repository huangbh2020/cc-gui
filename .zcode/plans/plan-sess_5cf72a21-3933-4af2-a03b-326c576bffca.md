# P4 Git 面板

## 需求

右栏 Git tab:支持项目文件夹下多个 git 仓库,每个仓库独立查看状态、暂存、提交、拉取、推送。

## 决策(已确认)

- **库**:`simple-git`(封装系统 git CLI,复用系统认证)
- **多仓库发现**:递归扫描项目根目录子目录(限深 3 层),找出所有含 `.git` 的目录
- **提交**:面板内勾选文件暂存 + 输入 commit message + 提交
- **认证**:复用系统 git 认证(SSH key / credential helper),失败显示错误

## 架构

```
GitPanel (renderer)
  ├─ 扫描: api.git.discoverRepos(projectPath) → GitRepo[]
  ├─ 每个 repo 一个 GitRepoCard:
  │    ├─ 分支名 + ahead/behind
  │    ├─ 文件列表(modified/staged/untracked)带勾选
  │    ├─ commit message 输入框 + 提交按钮
  │    ├─ Push / Pull 按钮
  │    └─ 展开 diff:api.git.diffFile(repoPath, filePath)
  └─ IPC:
       git.discoverRepos  — 扫描 .git 目录
       git.status         — 单仓库状态
       git.stage / unstage
       git.commit
       git.push / pull
       git.diffFile       — 单文件 diff(patch 文本)
```

## 实施步骤

### 1. 依赖安装

`apps/desktop/package.json` 加 `simple-git` (^3.36.0) 到 dependencies。纯 JS,无原生模块,无打包复杂度。

### 2. IPC 契约(`packages/contracts/src/ipc.ts`)

新增 schema + type + RpcMap + IPC 常量:

```ts
// 输入
GitReposInput    { projectPath: string }
GitRepoPathInput { repoPath: string }
GitStageInput    { repoPath, filePaths: string[] }
GitUnstageInput  { repoPath, filePaths: string[] }
GitCommitInput   { repoPath, message: string }
GitPushInput     { repoPath }
GitPullInput     { repoPath }
GitDiffInput     { repoPath, filePath: string }

// 结果类型
GitRepo          { path, name, isRepo: true }
GitStatusResult  { branch, ahead, behind, files: GitFileStatus[] }
GitFileStatus    { path, index: "unmodified"|"modified"|"added"|..., workingTree: ... }
GitDiffResult    { patch: string }
```

IPC 常量:`GIT_DISCOVER_REPOS`, `GIT_STATUS`, `GIT_STAGE`, `GIT_UNSTAGE`, `GIT_COMMIT`, `GIT_PUSH`, `GIT_PULL`, `GIT_DIFF`

### 3. Main handler(`apps/desktop/src/main/ipc/git.ts`)

新文件,镜像 `files.ts` 模式(zod parse → pathWithin 校验 → 操作 → 降级)。

**`git.discoverRepos`**:递归扫描 `projectPath` 子目录(限深 3 层),找含 `.git` 的目录。返回 `GitRepo[]`。复用 `node:fs/promises` 的 `readdir` + `stat`。过滤 node_modules 等。

**`git.status`**:`simpleGit(repoPath).status()` → 映射为 `GitStatusResult`。

**`git.stage`/`git.unstage`**:`.add(filePaths)` / `.reset(filePaths)`。

**`git.commit`**:`.commit(message)`。

**`git.push`/`git.pull`**:`.push()` / `.pull()`。捕获错误(认证失败、无 upstream)返回 `{ ok: false, error }`。

**`git.diff`**:`.diff([filePath])` 或 unstaged diff。返回 patch 文本。

**路径安全**:每个操作校验 `repoPath` 在某 project root 内(`pathWithin`)。

**注册**:`index.ts` 加 `registerGitHandlers(ipcMain)`。

### 4. Preload(`apps/desktop/src/preload/index.ts`)

加 `git: { discoverRepos, status, stage, unstage, commit, push, pull, diff }` 方法组。

### 5. GitPanel 组件(renderer)

**`components/ide/GitPanel.tsx`** — 顶层容器:
- 读 activeProjectId → projectPath
- mount 时调 `api.git.discoverRepos(projectPath)` 找仓库
- 无仓库 → 空态("未找到 git 仓库")
- 有仓库 → 渲染 `GitRepoCard[]`(可折叠,每个独立)

**`components/ide/GitRepoCard.tsx`** — 单仓库卡片:
- 头部:仓库名(相对项目根的路径)+ 分支 + ahead/behind 徽章 + Push/Pull 按钮 + 刷新
- 文件列表:每个文件一行(状态图标 M/A/?? + 路径 + 勾选框)。已暂存/未暂存分组。
- commit 输入框 + 提交按钮(暂存勾选的文件 → commit)
- 点击文件 → 展开 diff(`api.git.diff`)→ 用现有 `DiffView` 组件渲染

### 6. RightPanel 接入

`RightPanel.tsx` 的 `tab === "git"` 分支:占位 → `<GitPanel />`。

## 文件改动清单

| 文件 | 动作 |
|------|------|
| `apps/desktop/package.json` | 加 simple-git 依赖 |
| `packages/contracts/src/ipc.ts` | Git schema + type + RpcMap + IPC 常量 |
| `apps/desktop/src/main/ipc/git.ts` | 新建:git handler |
| `apps/desktop/src/main/ipc/index.ts` | 注册 registerGitHandlers |
| `apps/desktop/src/preload/index.ts` | 暴露 git.* 方法 |
| `apps/desktop/src/renderer/components/ide/GitPanel.tsx` | 新建:顶层容器 |
| `apps/desktop/src/renderer/components/ide/GitRepoCard.tsx` | 新建:单仓库卡片 |
| `apps/desktop/src/renderer/components/layout/RightPanel.tsx` | Git tab 接入 |

## 注意

1. **simple-git 在 Electron main 进程运行**(非 renderer),通过 `externalizeDepsPlugin` 自动外部化(已是 dependency)。
2. **push/pull 可能阻塞**(网络操作)— handler 是 async,renderer 显示 loading 态。
3. **认证错误处理**:push/pull 失败返回 `{ ok: false, error: string }`,面板显示错误提示(如"认证失败,请检查 SSH key 或 git credential 配置")。
4. **diff 渲染**:复用现有 `DiffView` + `lineDiff`(parse patch 或用 simple-git 的 diffSumary)。先用 patch 文本,简单可靠。