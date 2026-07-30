## 目标

在右侧 Files 面板的搜索功能上增加**文件内容搜索**(grep):顶部搜索框旁加一个模式切换按钮,在「按文件名搜索」和「按内容搜索」之间切换。内容搜索走新后端通道 `file:grep`,返回带行号和匹配行的结果,前端分组展示(按文件分组,每个文件下列出命中行)。

## 关键事实(已确认)

- **后端模式**:`file:search` 用 BFS 遍历 + `IGNORED_ENTRIES` 过滤 + `pathWithin` 守卫 + `samePath` 校验。新 `file:grep` 复用同一套(同文件 `files.ts` 里的 `samePath`/`pathWithin`/`IGNORED_ENTRIES`/`log` 都是模块级可复用)。无 glob/ripgrep 依赖,沿用现有 `readdir` 手写遍历风格。
- **二进制检测:不存在**,需自写。用 ripgrep/git 同款启发式:读前 ~8KB,含 `0x00` 字节视为二进制跳过;外加一个二进制扩展名 skip-list(.png/.jpg/.zip/.woff/.pdf/.exe…)省去无谓读取。
- **IPC 五层链路**(改 5 处文件,与现有 `file:search` 完全平行):
  1. `contracts/ipc.ts` — 加 `FileGrepEntry` 接口 + `FileGrepSchema`/`FileGrepInput` 类型(547-566 附近)
  2. `contracts/ipc.ts` — `RpcMap` 加 `"file.grep"`(947 后)
  3. `contracts/ipc.ts` — `IPC` 常量加 `FILE_GREP`(1032 后)
  4. `preload/index.ts` — `file:` 对象加 `grep` 方法(103 后)
  5. `main/ipc/files.ts` — 加 `ipcMain.handle(IPC.FILE_GREP, ...)`(232 后)
- **UI 模式切换**:用现有的「内联单图标 toggle 按钮」惯用法(`FileEditor.tsx:180` / `GitDiffDialog.tsx:151` 都是这个模式:`<button>` + `cn()` + `text-content-subtle hover:bg-surface-hover`,title 显示当前模式)。比 segmented control 更省横向空间,适配 360px 面板。
- **图标**:`IconFileSearch`(名搜索,已导出)↔ `IconTextSearch`(内容搜索,需在 `icons.tsx` 加 re-export)。已确认 `IconTextSearch` 是真实 Tabler 图标。

## 改动文件(共 6 个)

### 1. `packages/contracts/src/ipc.ts`(三处)

**566 后**加接口与 schema:
```ts
/** One line-level match from `file.grep`. `lineText` is the raw line (1-based
 *  `lineNumber`). `matches` are 0-based [start,end) column ranges for each
 *  occurrence of the query on that line (for frontend highlighting). */
export interface FileGrepEntry {
  path: string;
  relativePath: string;
  lineNumber: number;
  lineText: string;
  matches: Array<{ start: number; end: number }>;
}

/** Grep file contents under a project root. Main walks the same ignored-dir-
 *  filtered tree as `file.search`, skips binary files (null-byte sniff +
 *  extension skip-list), and scans each text file's lines for the query.
 *  Case-insensitive by default. Returns line-level matches, capped. */
export const FileGrepSchema = z.object({
  projectPath: z.string(),
  query: z.string(),
  limit: z.number().int().positive().max(500).optional(),        // 默认 200 命中
  maxResultsPerFile: z.number().int().positive().max(50).optional(), // 默认 10/文件
  caseSensitive: z.boolean().optional(),
});
export type FileGrepInput = z.infer<typeof FileGrepSchema>;
```

**947 后**RpcMap 加:`"file.grep": (input: FileGrepInput) => Promise<{ matches: FileGrepEntry[] }>;`
**1032 后**IPC 常量加:`FILE_GREP: "file:grep",`

### 2. `apps/desktop/src/preload/index.ts`

103 后加:
```ts
grep: ((input) =>
  ipcRenderer.invoke(IPC.FILE_GREP, input)) as RpcMap["file.grep"],
```

### 3. `apps/desktop/src/main/ipc/files.ts`

- import 加 `FileGrepSchema` 到 `@contracts/ipc` 导入块;`FileGrepEntry` 加到类型 import。
- 模块级新增:`BINARY_EXTENSIONS` Set(扩展名 skip-list)。
- `file:search` handler 后(232 后)加 `file:grep` handler:
  - 复用 `samePath` 校验 projectPath(拒绝则 `log.warn` + 返回 `{ matches: [] }`)
  - 复用 BFS 框架 + `IGNORED_ENTRIES` + `pathWithin` + MAX_DEPTH/MAX_VISIT 同上限
  - 对每个文件:扩展名在 skip-list 跳过;否则 `readFile` 成 Buffer,前 8KB 含 `0x00` 跳过(二进制);其余 `toString("utf-8")` 按行扫描
  - 大小写:`caseSensitive ? query : query.toLowerCase()`,hay 同步处理
  - 逐行匹配,记录命中行 `{ path, relativePath, lineNumber, lineText, matches:[{start,end}] }`;每文件命中达 `maxResultsPerFile`(默认 10)即止;总命中达 `limit`(默认 200)即终止遍历
  - 单文件读取失败 `log.warn` 跳过,不中断整体(与 readFile 的降级哲学一致)
  - 返回 `{ matches }`

### 4. `apps/desktop/src/renderer/lib/icons.tsx`

在 `IconFileSearch` 旁加 `IconTextSearch` re-export(一行)。

### 5. `apps/desktop/src/renderer/components/ide/FilesPanel.tsx`(主要 UI 改动)

- 新增 `searchMode` state(`"name" | "content"`,默认 `"name"`),沿用本地 state 惯例(注释里说搜索是 transient view affordance)。
- 搜索行加模式 toggle 按钮(置于 IconSearch 与 input 之间,或 input 后):`IconFileSearch`↔`IconTextSearch`,title="切换为内容搜索/文件名搜索"。切换时清空 query + results(不同模式结果不通用)。
- 内容搜索:输入非空时调 `api.file.grep({ projectPath, query, limit:200, maxResultsPerFile:10 })`,沿用现有 120ms debounce + `reqIdRef` 竞态取消(同一 effect 按 `searchMode` 分派 name/content)。
- 结果渲染分两个子组件:
  - `NameSearchResults`(现有 `SearchResults`,基本原样,微调)
  - `ContentSearchResults`(新):**按 path 分组**(同文件多行命中聚到一起),每组:文件名 + relativePath(可点击 `openFileInIde`),下方列出命中行——行号(灰)+ 截断的 lineText(query 片段可用 `<mark>`/accent 色高亮)。行点击也可 `openFileInIde`(后续可传行号定位,当前先打开文件)。
  - loading/empty 分支同现有(搜索中…/无匹配)。
- 键盘导航:name 模式保持现有 ↑↓/Enter/Esc;content 模式 Enter 打开当前高亮项所在文件。为简化,content 模式 activeIdx 在扁平命中行上移动(分组后仍维护一个扁平 index)。

### 6. (无单独改动)`main/ipc/index.ts` 不用动 —— `registerFileHandlers` 已注册,新 handler 加在其函数体内即可。

## 验证

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 通过(5 层类型链一致)。
2. `pnpm dev` 手动验证:
   - 文件名搜索仍正常(默认模式)。
   - 点 toggle 切到内容搜索,输入关键词,出现按文件分组的命中行。
   - 二进制文件(如 .png)不被扫描;node_modules 等被忽略。
   - 点击文件名/命中行在中间栏打开。
   - 切回名搜索、切项目均清空结果。
   - 大小写:默认不敏感(可选后续加大小写 toggle,本期 schema 已留 `caseSensitive` 字段,UI 暂不暴露)。