# Per-project 文件编辑器状态隔离

## 问题

当前 IDE 文件编辑器状态(`ideOpenFiles` / `ideActiveFile` / `ideFileViewMode`)是全局的——不分项目。切换线程/项目时:
- 编辑器仍显示旧项目的文件
- `replace` 模式下打开新项目文件会丢弃旧项目的(切回去就没了)
- `tabs` 模式下不同项目的文件会混在一起

## 方案:per-project 分桶

将全局的编辑器状态改为 **以 `projectId` 为 key 的 Record 桶**,完全镜像 `messagesBySession` / `todosBySession` 的模式。

### 具体改动

#### 1. State 字段重构(`sessionStore.ts`)

```
// 之前(全局):
ideOpenFiles: string[]
ideActiveFile: string | null
ideFileViewMode: Record<filePath, "edit" | "diff">

// 之后(per-project):
ideOpenFilesByProject: Record<projectId, string[]>
ideActiveFileByProject: Record<projectId, string | null>
ideFileViewModeByProject: Record<projectId, Record<filePath, "edit" | "diff">>
```

**保留全局的字段**(不分桶,它们是用户偏好而非项目状态):
- `ideEditorMode`("tabs" | "replace")— 全局偏好,和 displayMode 同级
- `ideExpandedDirs` — 文件树展开状态(文件树在右栏,也是 per-project 的,但先保持全局简化范围;实际上它也应分桶,因为切项目后展开的旧目录无意义)
- `ideFocusNonce` — 全局 UI 信号
- `rightPanelTab` — 全局偏好

**`ideExpandedDirs` 也改为分桶** — 同理,切项目后文件树应恢复该项目的展开状态。

#### 2. 派生当前值的选择器

组件不直接读全局字段,而是通过 `activeProjectId` 派生当前项目的值:
- `ideOpenFiles` → `ideOpenFilesByProject[activeProjectId] ?? []`
- `ideActiveFile` → `ideActiveFileByProject[activeProjectId] ?? null`

在 store 内部,所有 action(`openFileInIde` / `closeFileInIde` / `setIdeActiveFile` 等)操作的都是**当前活动项目的桶**。

#### 3. 切换项目时的行为

`selectProject` / `syncConfigFromSession`(切线程时同步 activeProjectId)不需要额外逻辑——因为编辑器读的是 `ideOpenFilesByProject[新projectId]`,自动显示新项目的文件(或空,如果是首次打开)。切回去时读旧桶,自动恢复。

#### 4. 持久化

`ideOpenFiles` / `ideActiveFile` / `ideExpandedDirs` 的持久化 key 从存单个值改为存**整个 per-project 对象**(JSON):
- `ui.ideOpenFiles` → `JSON.stringify({ "proj_a": [...], "proj_b": [...] })`
- `ui.ideActiveFile` → `JSON.stringify({ "proj_a": "/path", ... })`
- `ui.ideExpandedDirs` → `JSON.stringify({ "proj_a": [...], ... })`

`init()` hydration 改为解析对象而非数组,并按 project root 过滤每个桶的路径。

#### 5. 组件改动

- `App.tsx` `EditorColumn` — 读 `ideActiveFileByProject[activeProjectId]` 而非 `ideActiveFile`
- `App.tsx` `EditorColumn` — 读 `ideOpenFilesByProject[activeProjectId]` 决定是否渲染 OpenTabsBar
- `OpenTabsBar` — 读 `ideOpenFilesByProject[activeProjectId]`
- `FileTree` — `useAgentTouchedFile` 不变(已 per-session);`ideExpandedDirs` 改读 per-project 桶
- `FileEditor` — `ideFileViewMode` 改读 per-project 桶

### 文件改动清单

| 文件 | 动作 |
|------|------|
| `sessionStore.ts` | 字段重构 + action 改为操作当前项目桶 + init hydration 改为对象解析 + 选择器派生 |
| `App.tsx` | EditorColumn 改读 per-project 桶 |
| `OpenTabsBar.tsx` | 改读 per-project 桶 |
| `FileTree.tsx` | expandedDirs 改读 per-project 桶 |
| `FileEditor.tsx` | viewMode 改读 per-project 桶 |

### 注意

1. **向后兼容**:旧的持久化值(扁平数组/字符串)在 hydration 时若解析为非对象,视为空(降级)。不写迁移脚本——用户最多丢失"上次打开的文件"这个轻量状态。
2. **删除项目时清理桶**:`deleteProject` 要把该 project 的桶条目删掉(镜像 `deleteSession` 清理 per-session 桶的模式)。
3. `ideEditorMode` 保持全局(用户偏好,不分项目)。