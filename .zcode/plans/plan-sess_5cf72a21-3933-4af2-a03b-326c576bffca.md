# Git 面板优化

## 5 项需求与方案

### 需求 1:点击文件 → 中间面板 diff 视图打开

**当前**:点击文件在卡片内展开 inline diff。
**目标**:点击文件 → 中间面板编辑器列以 diff 模式打开该文件。

**方案**:新增 store 状态 `gitDiffByProject: Record<projectId, Record<filePath, string>>` 存储每个文件的 git diff "before" 内容(从 `git.diff` patch 解析得到)。`FileEditor` 的 `useTurnFileFor` 逻辑扩展:优先查 `gitDiffByProject`,这样 git diff 文件也能在 center editor 以 diff 打开。

点击文件时:调 `api.git.diff` 获取 patch → `parsePatchToBeforeAfter` → 存入 `gitDiffByProject` → `openFileInIde(absolutePath, { diff: true })`。

### 需求 2:右键菜单(查看源文件 / 放弃更改)

**当前**:无右键菜单。
**方案**:用 `@base-ui/react/context-menu`(已安装,导出 `Root/Trigger/Portal/Positioner/Popup/Item`)包裹每个 FileRow。菜单项:
- **查看源文件** — `openFileInIde(absolutePath)`(中间面板编辑模式)
- **放弃更改** — 打开 `Dialog` 二次确认(danger 样式,复用 `CustomModelsPanel` 的 confirm 模式),确认后调新增的 `api.git.discard`

新增 IPC:`git.discard`(`simpleGit(repoPath).checkout(filePaths)`)。

### 需求 3:显示 diff 加减数量

**当前**:只显示状态码(M/A/D)。
**方案**:每个文件行加载时异步获取 diff → `diffSummary(lineDiff(before, after))` → 行右侧显示 `+N -M` 徽章(复用 `MessageBlocks` 的 `+adds`/`−dels` 视觉模式)。为避免每行都发 IPC,用轻量缓存。

### 需求 4:一键暂存/取消全部

**当前**:手动勾选 → 暂存选中。
**方案**:
- "更改"组标题右侧加 **全部暂存** 按钮(`api.git.stage({ filePaths: allUnstagedPaths })`)
- "已暂存"组标题右侧加 **全部取消** 按钮(`api.git.unstage({ filePaths: allStagedPaths })`)

### 需求 5:布局重排 + 提交下拉

**当前**布局:更改 → 暂存按钮 → 已暂存 → 提交框。
**目标**布局:**已暂存 → 提交框(+下拉提交按钮)→ 更改**

提交按钮右侧下拉(用 `@base-ui/react/menu`):
- **提交** — `git.commit(message)`
- **提交并推送** — `git.commit(message)` → `git.push()`
- **提交并同步** — `git.commit(message)` → `git.pull()` → `git.push()`

---

## 实施步骤

### 1. IPC 新增 `git.discard`(`ipc.ts` + `git.ts` + preload)

- Schema:`GitDiscardSchema = { repoPath, filePaths: string[] }`(复用 stage 的形状)
- Handler:`simpleGit(repoPath).checkout(["--", ...filePaths])`(untracked 文件用 `git.clean`)
- IPC 常量 `GIT_DISCARD: "git:discard"` + RpcMap + preload `git.discard`

### 2. Store 新增 git diff before 内容桶(`sessionStore.ts`)

- `gitDiffByProject: Record<string, Record<string, string>>` — per-project per-file 的 diff before 内容(ephemeral,不持久化)
- `setGitDiffBefore(filePath, before)` — 设置某个文件的 diff before
- `clearGitDiffBefore(filePath)` — 清除(切换项目/刷新时)
- `deleteProject` 时清理该桶

### 3. FileEditor 支持 git diff(`FileEditor.tsx`)

- `useTurnFileFor` → 扩展为 `useDiffBeforeSource`:先查 `gitDiffByProject[pid][filePath]`,再查 `turnFilesBySession`
- 有 git diff before 时,工具栏 Diff/Edit 切换也可用

### 4. 重写 GitRepoCard(`GitRepoCard.tsx`)

**新布局**(从上到下):
```
┌─ Header: repo name + branch + ↑↓ + Pull/Push/Refresh ────┐
├─ 已暂存 (N)                          [全部取消]            │
│   ☐ file1.ts  M  +3 −1                                   │
│   ☐ file2.ts  A  +10                                     │
├─ 提交信息输入框  [提交 ▾]                                 │
├─ 更改 (N)                            [全部暂存]            │
│   ☑ file3.ts  M  +5 −2                                   │
│   ☑ file4.ts  ??                                         │
└──────────────────────────────────────────────────────────┘
```

**FileRow 改动**:
- 点击行(非 checkbox)→ 调 `api.git.diff` + `setGitDiffBefore` + `openFileInIde(absPath, {diff:true})` → 中间面板打开
- 右键 → `@base-ui/react/context-menu`(查看源文件 / 放弃更改…)
- 加载时异步获取 diff → 显示 `+N −M` 徽章
- checkbox 仍在(用于选择单个文件操作)

**FileGroup 改动**:
- 标题行加"全部暂存"/"全部取消"按钮
- 去掉旧的 inline `FileDiff`(diff 移到 center editor)

**提交区**:
- 放在已暂存下方
- 提交按钮用 `@base-ui/react/menu` 下拉(提交 / 提交并推送 / 提交并同步)

**放弃更改确认**:
- `Dialog`(复用 ui/Dialog)danger 样式

### 5. 文件路径解析

git status 返回的 `file.path` 是相对 repo root 的。center editor 的 `openFileInIde` 需要绝对路径。在 GitRepoCard 里用 `repo.path + '/' + file.path` 拼接(需 renderer-side path join,已有 `lib/path.ts`)。

---

## 文件改动清单

| 文件 | 动作 |
|------|------|
| `packages/contracts/src/ipc.ts` | 加 `GitDiscardSchema` + RpcMap + `GIT_DISCARD` 常量 |
| `apps/desktop/src/main/ipc/git.ts` | 加 `git.discard` handler(checkout + clean) |
| `apps/desktop/src/preload/index.ts` | 暴露 `git.discard` |
| `apps/desktop/src/renderer/stores/sessionStore.ts` | 加 `gitDiffByProject` 桶 + `setGitDiffBefore`/`clearGitDiffBefore` + deleteProject 清理 |
| `apps/desktop/src/renderer/components/ide/FileEditor.tsx` | diff before 来源扩展(查 gitDiffByProject) |
| `apps/desktop/src/renderer/components/ide/GitRepoCard.tsx` | 重写:布局重排 + 点击打开 + 右键菜单 + diff 徽章 + 一键暂存/取消 + 提交下拉 + 放弃确认 |
| `apps/desktop/src/renderer/lib/icons.tsx` | 补充所需图标(如 IconDotsVertical 用于下拉) |

## 注意

1. **untracked 文件放弃更改**:git checkout 不适用于 untracked(未跟踪),需用 `git clean -f -- file`。handler 里根据状态码判断用 checkout 还是 clean。
2. **gitDiffByProject 是 ephemeral**:不持久化(重启后 git 状态可能已变),切项目时不清(切回来还能用,直到刷新)。
3. **diff 徽章性能**:每个文件行异步加载 diff 可能较多 IPC 调用。用 `useEffect` + `useState` per row,只加载可见行的 diff(React 只渲染已展开组的行)。
4. **提交并同步**:commit → pull → push,如果 pull 有冲突 push 不执行,显示错误。