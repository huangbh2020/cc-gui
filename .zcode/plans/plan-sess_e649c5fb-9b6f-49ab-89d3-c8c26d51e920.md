# Git 面板分支切换功能实现计划

## 目标
在右侧 Git 面板的仓库卡片(`GitRepoCard`)中,把当前静态展示的分支徽章改为可点击的下拉选择器,支持:
- 查看并切换**本地分支**
- 查看**远程分支**,点击时自动创建本地跟踪分支并切换(VS Code 行为)
- 查看**tag**,点击进入 detached HEAD
- **新建分支**(从当前 HEAD 创建并切换)
- 支持搜索过滤(分支较多的仓库)

遵循项目既有的四层 IPC 模式:契约(`contracts/ipc.ts`)→ 主进程(`main/ipc/git.ts`)→ preload → 渲染层(`GitRepoCard.tsx`)。复用已导入的 `@base-ui/react/menu`(参考 `PermissionModeDropdown` 模式)和 `simple-git`。

---

## 改动文件清单(4 个)

### 1. `packages/contracts/src/ipc.ts` — 新增 schema/类型/通道常量

在 Git schema 区(约 949 行 `GitShowFileSchema` 之后)新增:

```ts
/** 单个分支/tag 信息。 */
export interface GitBranchInfo {
  /** 显示名:本地分支为短名(main);远程分支为 origin/main;tag 为 v1.0.0。 */
  name: string;
  /** 是否为当前检出。 */
  current: boolean;
  /** 最新提交短哈希。 */
  commit: string;
  /** 最新提交 subject(一行摘要)。 */
  label: string;
  /** 类型:local / remote / tag。 */
  type: "local" | "remote" | "tag";
}

/** git.listBranches 返回的分组分支列表。 */
export interface GitBranchListResult {
  /** 当前分支名(detached HEAD 时为空字符串)。 */
  current: string;
  /** 是否 detached HEAD。 */
  detached: boolean;
  local: GitBranchInfo[];
  remote: GitBranchInfo[];
  tags: GitBranchInfo[];
}

/** 列出仓库的本地/远程分支与 tag。复用 GitRepoPathSchema(repoPath)。 */

/** 切换分支/tag。含可选 newBranch 用于从远程分支创建本地跟踪分支或新建分支。
 *  branch 字段复用 GitLogSchema.ref 的安全正则,防 CLI 注入。 */
export const GitCheckoutSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref"),
  /** 若提供,执行 git checkout -b <newBranch> <branch>;否则 git checkout <branch>。 */
  newBranch: z
    .string()
    .regex(/^[A-Za-z0-9._/\-]+$/, "invalid branch name")
    .optional(),
});
export type GitCheckoutInput = z.infer<typeof GitCheckoutSchema>;
```

在 `RpcMap`(约 1152 行 `git.showFile` 之后)新增两条:
```ts
"git.listBranches": (input: GitRepoPathInput) => Promise<{ branches: GitBranchListResult }>;
"git.checkout": (input: GitCheckoutInput) => Promise<GitOpResult>;
```

在 `IPC` 通道常量(约 1240 行 `GIT_SHOW_FILE` 之后)新增:
```ts
GIT_LIST_BRANCHES: "git:listBranches",
GIT_CHECKOUT: "git:checkout",
```

### 2. `apps/desktop/src/main/ipc/git.ts` — 新增两个 handler

import 处加 `GitCheckoutSchema`;在 `git.showFile` handler 之后追加:

**`git.listBranches`**:用 `git.raw(["for-each-ref", ...])` 精确取 refs/heads、refs/remotes、refs/tags 的 refname+短哈希+subject+HEAD 标记,自行解析为三组 `GitBranchInfo`。过滤掉 `refs/remotes/*/HEAD` 符号引用。遵循现有 try/catch + `findContainingProject` 防护 + 优雅降级(失败返回空列表)。不用 `git.branch()` 因为其 `label` 字段不可控且对中文 subject 截断不稳;`for-each-ref` 更可靠。

**`git.checkout`**:
- `newBranch` 存在 → `await git.checkoutBranch(input.newBranch, input.branch)`(即 `git checkout -b newBranch branch`)
- 否则 → `await git.checkout(input.branch)`
- 失败捕获(如本地未提交改动会被覆盖),返回 `{ ok: false, error }`。

### 3. `apps/desktop/src/preload/index.ts` — 注册两个方法

在 `git:` 命名空间(约 166 行 `showFile` 之后)新增:
```ts
listBranches: ((input) => ipcRenderer.invoke(IPC.GIT_LIST_BRANCHES, input)) as RpcMap["git.listBranches"],
checkout: ((input) => ipcRenderer.invoke(IPC.GIT_CHECKOUT, input)) as RpcMap["git.checkout"],
```

### 4. `apps/desktop/src/renderer/components/ide/GitRepoCard.tsx` — 分支徽章改下拉选择器

**新增本地状态**:`branches`(GitBranchListResult|null)、`branchesLoading`、`branchQuery`(搜索词)、`checkingOut`(切换中)。

**替换 418-422 行的静态 span** 为 `Menu.Root` + `Menu.Trigger`(复用现有 Menu import),trigger 样式保持徽章观感,加 `IconGitBranch` + 分支名 + `IconChevronDown`。detached HEAD(branch 为空)时显示 "HEAD"。

**Menu Popup 结构**:
- 顶部搜索 `<input>`(置于非 `Menu.Item` 的 div 内,`onKeyDown` 阻止方向键冒泡以免被 Menu 键盘导航拦截)
- 可滚动列表 `max-h-[300px] overflow-y-auto`,分组:本地分支 / 远程分支 / 标签,每组前加 `GroupLabel`
- 每项显示分支名 + 灰色短哈希/subject;当前分支带 `IconCheck` 并高亮
- 顶部固定一个 "+ 新建分支" 项,点击打开小型 `Dialog`(复用已 import 的 Dialog)输入分支名 → `checkout({ branch: "HEAD", newBranch: name })`

**交互逻辑**:
- `onOpenChange(open=true)` 时调用 `api.git.listBranches({ repoPath })` 拉取列表
- 点击本地分支 → `checkout({ branch: name })`
- 点击远程分支 `origin/foo` → 若 local 已有 `foo` 则 `checkout({ branch: "foo" })`,否则 `checkout({ branch: "origin/foo", newBranch: "foo" })`
- 点击 tag → `checkout({ branch: tagName })`
- 切换中显示 spinner;成功后调用现有 `refresh()` 刷新状态并关闭菜单;失败用现有 `prependLog` 记录错误日志并提示
- 搜索框按 name 客户端过滤三组列表

**样式**:遵循 AGENTS.md 规范——用 `cn()` 合并 class,语义 token(`bg-surface`/`border-edge`/`text-content-muted`/`text-accent`),`Menu.Trigger`/`Popup`/`Item` 的 className 模式照搬 `PermissionModeDropdown` 与同文件已有的提交拆分 Menu(755-793 行)。

---

## 验证步骤
1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` —— 全量类型检查(AGENTS.md 要求)
2. 手动验证(需用户运行 `pnpm dev`):
   - 点击分支徽章 → 弹出含本地/远程/标签分组的列表
   - 切换本地分支、检出远程分支(自动建跟踪)、检出 tag(detached)
   - 新建分支、搜索过滤
   - 有未提交改动时切换失败应有错误提示且不崩溃
