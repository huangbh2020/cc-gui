# 实施计划：左侧边栏菜单入口 + Ctrl+K 统一搜索

## 目标
1. 在左侧边栏底部"设置"入口上方，新增一个**入口菜单**（按钮+下拉菜单），含「新建会话」「搜索」两项，每项带图标、文字、快捷键显示。
2. 将 Ctrl+K 命令面板升级为**统一搜索面板**：输入查询时，结果分「命令 / 线程 / 文件 / 文件内容」四组实时展示，统一键盘导航。空查询时保留原有命令列表。

## 用户已确认的决策
- 「新建任务」= 新建会话（`startSession`，复用 Ctrl+N）
- Ctrl+K 统一面板（命令+线程+文件+文件内容四类结果同屏）
- 线程搜索**跨所有项目**（需新增后端 IPC）

---

## 改动 1：新增「按标题跨项目搜索会话」后端 IPC

**新增 `session.search`** 通道，模仿 `listByProject`（`repositories.ts:253`）的 SQL 模式。

### `packages/contracts/src/ipc.ts`
- 在 `ProjectSessionsSchema`（480 行）附近新增 `SessionSearchSchema`：
  ```ts
  export const SessionSearchSchema = z.object({
    query: z.string(),
    limit: z.number().int().positive().optional(),
  });
  export type SessionSearchInput = z.infer<typeof SessionSearchSchema>;
  ```
- `RpcMap`（1686 行 `session.messages` 附近）加签名：
  ```ts
  "session.search": (input: SessionSearchInput) => Promise<{ sessions: Session[] }>;
  ```
- `IPC` 常量（1898 行 `SESSION_UPDATE_SETTINGS` 附近）加：
  ```ts
  SESSION_SEARCH: "session:search",
  ```

### `apps/desktop/src/main/store/repositories.ts`
在 `SessionRepo`（`listByProject` 之后）加：
```ts
searchByTitle(query: string, opts?: { limit?: number }): Session[] {
  const db = getDb();
  const q = `%${query.trim()}%`;
  const params: BindValue[] = [v(q)];
  let sql = `SELECT * FROM sessions WHERE archived = 0 AND title LIKE ? ORDER BY updated_at DESC`;
  const limit = opts?.limit ?? 30;
  sql += " LIMIT ?";
  params.push(v(limit));
  // 复用 prepare/bind/step 模式
}
```
只搜未归档，默认上限 30 条（桌面级数据量无压力）。

### `apps/desktop/src/main/ipc/projects.ts`
在 `PROJECT_SESSIONS` handler（45 行）之后注册 `SESSION_SEARCH` handler：
```ts
ipcMain.handle(IPC.SESSION_SEARCH, (_evt, raw) => {
  const input = SessionSearchSchema.parse(raw);
  return { sessions: SessionRepo.searchByTitle(input.query, { limit: input.limit }) };
});
```

### `apps/desktop/src/preload/index.ts`
在 `session:` 命名空间（43 行）追加：
```ts
search: ((input) =>
  ipcRenderer.invoke(IPC.SESSION_SEARCH, input)) as RpcMap["session.search"],
```

---

## 改动 2：左侧边栏新增入口菜单组件

在 `LeftBar.tsx` 底部"设置"按钮（612 行）上方，插入一个新的菜单区，沿用 base-ui Menu 模式 B（Trigger 按钮 + Positioner align="end"）。

### 新增 `SidebarActionMenu` 组件（放在 LeftBar.tsx 内或单独文件）
结构：
```tsx
<Menu.Root>
  <Menu.Trigger className="…与设置按钮一致的行样式…">
    {/* 左侧 + 图标 + 文字 / 右侧展开箭头 */}
    <IconLayoutGrid / IconPlus size={14} />  {/* 触发器主图标 */}
    <span>新建 / 搜索</span>
    <IconChevronRight className="ml-auto rotate-90" size={12} />
  </Menu.Trigger>
  <Menu.Portal>
    <Menu.Positioner align="end" side="top">
      <Menu.Popup className={…复用现有菜单 Popup className…}>
        <Menu.Item onClick={() => startSession()}>
          <IconPlus size={14} />  <span className="flex-1">新建会话</span>
          <kbd>Ctrl N</kbd>      {/* 用 acceleratorToDisplayString 渲染 */}
        </Menu.Item>
        <Menu.Item onClick={() => setCommandPaletteOpen(true)}>
          <IconSearch size={14} /> <span className="flex-1">搜索…</span>
          <kbd>Ctrl K</kbd>
        </Menu.Item>
      </Menu.Popup>
    </Menu.Positioner>
  </Menu.Portal>
</Menu.Root>
```

要点：
- `side="top" align="end"`：菜单从底部入口**向上**展开（避免被屏幕底裁切），右对齐。
- 快捷键徽章用 `resolveShortcut(id, overrides)` + `acceleratorToDisplayString` 实时渲染（用户重绑后自动更新，与命令面板一致）。
- `新建会话` 的 `available` 与命令一致（`activeProjectId !== null`），无项目时禁用或灰显。
- 入口按钮风格与"设置"完全一致（同 padding/字号/hover），视觉上成一对。

---

## 改动 3：Ctrl+K 升级为统一搜索面板

改造 `CommandPalette.tsx`：当输入框有非空查询时，在**命令结果**之外，并发拉取三类异步结果，按固定顺序合并展示。

### 新增数据获取层（`CommandPalette.tsx` 内部）
- 新增三个 debounced 异步 fetch（复用 `SearchDialog.tsx` 已验证的模式：debounce 120ms + `reqIdRef` 防过期覆盖）：
  - **线程**：`api.session.search({ query, limit: 30 })` → `Session[]`，跨所有项目
  - **文件**：`api.file.search({ projectPath, query, limit: 50 })` → `FileSearchEntry[]`（需 `activeProjectId` 非空）
  - **文件内容**：`api.file.grep({ projectPath, query, limit: 50, maxResultsPerFile: 3 })` → `FileGrepEntry[]`（需 `activeProjectId` 非空）
- 空查询时：三类异步结果清空，仅展示命令（保留原行为）。
- loading 态：分组标题旁显示 spinner（`IconLoader2 animate-spin`）。

### 交互行为
- **线程结果**：点击 → 若 `sess.projectId === activeProjectId` 直接 `openTab(sess.id)`；否则先 `selectProject(sess.projectId)` 再 `openTab(sess.id)`（跨项目跳转）。关闭面板。
- **文件结果**：点击 → `openFileInIde(absPath)`（支持现有定位）。**关闭面板**（区别于 SearchDialog 的"不关闭"，因为统一面板是 one-shot，与命令一致）。
- **文件内容结果**：点击 → `openFileInIde(absPath, { line, column: match.start + 1 })`。关闭面板。
- 三类结果的行渲染：复用 `SearchDialog` 的视觉风格（文件图标、`relativePath` 副标题、`<mark>` 高亮匹配片段、行号）。

### 键盘导航
保留 base-ui `Combobox` 的统一导航：把四类结果都作为 Combobox items 注入（命令在前，线程、文件、文件内容按序），`autoHighlight` 高亮首项，↑↓ 跨组移动，↵ 执行当前项。这是对现有结构改动最小的做法——只需把 `items` 从纯命令数组扩展为「命令 + 异步结果」合并数组，每组带 `group` 字段。

### 分组顺序与标题
`COMMAND_GROUPS` 扩展或新增独立分组渲染逻辑：
```
命令（CommandGroup）  ← 现有
线程
文件
文件内容
```
空组（无结果且非 loading）不渲染。

### 边界
- 无激活项目时：文件/文件内容分组不请求、不渲染（与 `files.search` 命令的 `available` 一致）；线程搜索仍可用（跨项目，不依赖当前项目）。
- placeholder 文案改为「搜索命令、线程、文件…」。

---

## 改动 4：图标补充（如需）

`icons.tsx` 已导出 `IconPlus`、`IconSearch`、`IconChevronRight`、`IconLoader2`、`IconMessage`、`IconFile`、`IconFileSearch`，**无需新增**。入口菜单触发器图标用 `IconDots`（已导出，第 51 行）或 `IconPlus`——倾向 `IconPlus`（语义更贴合"新建/操作"）。

---

## 文件清单（改动点）

| 文件 | 改动 |
|------|------|
| `packages/contracts/src/ipc.ts` | +`SessionSearchSchema`/type、+RpcMap 签名、+`IPC.SESSION_SEARCH` |
| `apps/desktop/src/main/store/repositories.ts` | +`SessionRepo.searchByTitle` |
| `apps/desktop/src/main/ipc/projects.ts` | +`SESSION_SEARCH` handler |
| `apps/desktop/src/preload/index.ts` | +`session.search` 桥接 |
| `apps/desktop/src/renderer/components/layout/LeftBar.tsx` | +`SidebarActionMenu` 组件 + 在底部"设置"上方插入 |
| `apps/desktop/src/renderer/components/layout/CommandPalette.tsx` | 改造为统一搜索（+异步三类结果 + 跨项目打开） |

## 验证步骤
1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 类型检查通过。
2. `pnpm dev` 启动：
   - 左侧边栏底部出现入口菜单，点击展开「新建会话 / 搜索」，快捷键徽章正确显示（Ctrl+N / Ctrl+K）。
   - 无激活项目时「新建会话」禁用；「搜索」始终可用。
   - Ctrl+K：空查询显示命令；输入文字后出现「线程/文件/文件内容」分组。
   - 跨项目线程点击能正确切换项目并打开会话。
   - 文件/文件内容点击能在编辑器打开并定位（内容命中行号/列）。

## 不做的事
- 不改 `SearchDialog.tsx`（Ctrl+Shift+F 仍打开独立文件搜索面板，互不冲突）。
- 不新增"搜索消息内容"（消息只在 SQLite，需全文索引，范围过大；本次仅标题级线程搜索）。
- 不改快捷键默认绑定（Ctrl+K / Ctrl+N 保持不变）。