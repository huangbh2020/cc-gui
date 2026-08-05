## 概述

增强 SkillsPanel 的「导入 Skill」功能,新增「导入本地文件夹」入口,让用户能选择任意本地目录,自动识别其中包含的 skill 并导入到 `~/.mcode/skills`。

**自动识别规则**(已与用户确认):
- 若所选文件夹**直接含 `SKILL.md`** → 当作**单个 skill**(文件夹名作为 skill 名)
- 否则 → 扫描其**子目录**(每个含 `SKILL.md` 的子目录是一个 skill),与现在扫描 `~/.claude/skills` 的逻辑一致

## 改动文件清单(4 个)

### 1. `packages/contracts/src/ipc.ts` — 新增 scanSources 入参 + 新 channel

**a. 扩展 `SkillsScanSourcesSchema`**,接受可选的 `localDir`:
```ts
export const SkillsScanSourcesSchema = z.object({
  /** 可选:扫描用户指定的本地文件夹。未提供时(默认)扫描固定外部工具目录。 */
  localDir: z.string().optional(),
});
```
相应地 `SkillsScanSourcesInput` 类型自动跟着变(因为是 `z.infer`)。`scanSources` 的 `RpcMap` 签名会自动引用此类型,无需单独改。

**为什么不新增独立 channel?** `scanSources` 已经返回 `ExternalSkillInfo[]`,本地文件夹扫出的 skill 复用同一数据结构即可(只是 `tool` 字段用新值 `"local"` 区分),UI 端也能复用同一个列表渲染逻辑。新增 channel 会割裂 UI。

**b. 扩展 `SkillTool` 类型**,增加 `"local"`:
```ts
export type SkillTool = "claude-code" | "codex" | "zcode" | "local";
```

### 2. `apps/desktop/src/main/ipc/skills.ts` — 扫描逻辑

**a. 修改 `SKILLS_SCAN_SOURCES` handler**,在扫描完固定外部工具目录后,若 `input.localDir` 存在,额外扫描它:
- 用 `safeRealPath(localDir)` 解析;不存在则跳过
- **判断单 skill vs 集合**:检测 `<localDir>/SKILL.md` 是否存在
  - 存在 → 当作单个 skill:直接构造一条 `ExternalSkillInfo`(name 取 frontmatter 或文件夹名,`tool: "local"`,`sourcePath: realLocalDir`)
  - 不存在 → 调用现有 `scanExternalSkillsRoot(realLocalDir, "local", byKey)`(它已经做了子目录扫描 + SKILL.md 解析)

这样**完全复用**已有的扫描函数和去重逻辑。

**b. 安全/边界**:
- `localDir` 是用户主动选的,无路径遍历风险(不像 `import` 的 `name` 需要正则);但仍验证它是一个存在的目录
- 去重 key 从 `${tool}:${name}` 扩展为 `local:${localDir}:${name}`,避免同一文件夹多次扫描重复(沿用现有 dedup 约定)

### 3. `apps/desktop/src/renderer/components/settings/SkillsPanel.tsx` — UI

**a. 扩展 `ImportSkillsDialog`**,新增「选择文件夹」按钮 + 本地 skill 列表分组:

UI 布局(Dialog body 内,现有外部工具分组列表**之后**):
```
┌──────────────────────────────────────────┐
│ Dialog Title: 导入 Skill                  │
│ ─────────────────────────────────────── │
│ [现有 Claude Code / Codex / Zcode 分组]   │
│                                          │
│ ── 本地文件夹 ──                         │
│ [「选择文件夹」按钮]                      │
│ (选择后显示扫出的 skill,带复选框)         │
│   ○ my-local-skill    [本地]  描述…      │
│   ○ another-skill     [本地]  描述…      │
│                                          │
│ [Footer: 已选 N 个 | 取消 | 导入]        │
└──────────────────────────────────────────┘
```

具体改动:
- `ImportSkillsDialog` 内新增 state:`localDir: string | null`(选中的文件夹路径)
- 新增「选择文件夹」按钮(用 `IconFolder` 图标),调用 `api.pickFolder()`,拿到路径后:
  - 设 `localDir`,并把 `localDir` 作为参数传给 `api.skills.scanSources({ localDir })`
  - 重置 selection
- `scanSources` 一次调用即可同时返回固定工具目录 + 本地目录的 skill(后端已合并),前端只需在分组时新增 `"local"` 这个 tool 分组
- `TOOL_LABELS` / `TOOL_BADGE_CLS` 扩展 `"local"` 项(label = `"本地"`,颜色用中性灰 `bg-surface-hover text-content-muted`)
- `toolOrder` 数组末尾追加 `"local"`
- 复选框勾选 → `doImport` 逻辑**完全不变**(它已经按 `sourcePath` 过滤),本地 skill 的 `sourcePath` 指向用户本地目录,`name` 已带正则校验

**b. 关键复用点**:
- `ExternalSkillInfo` 结构不变,本地 skill 只是 `tool === "local"`
- `grouped` reduce / `toolOrder.map` 渲染分组 — 现有逻辑自动覆盖新分组
- `existing` 去重(已导入标记)— 同样适用
- `doImport` — 无需改动

**c. 选择文件夹后的体验**:
- 文件夹路径在按钮旁显示(截断 + title 全路径)
- 可重新选择其他文件夹(会替换 `localDir` + 重新 scan)
- Dialog 重新打开时,`localDir` 重置为 `null`(在 open effect 里 reset)

### 4. (无新增 preload 改动)
`api.skills.scanSources` 已经存在,类型从 `RpcMap["skills.scanSources"]` 派生,Schema 改了 preload 端类型自动跟着变,无需手动修改 preload/index.ts。

## 不改动的部分

- `SkillsImportSchema` / `SKILLS_IMPORT` handler — 导入复制逻辑完全复用(`fs.cp` recursive)
- preload `api.skills.*` — 6 个方法签名都不变(scanSources 入参变,但 TS 自动推导)
- Provider / CLAUDE_CONFIG_DIR — 导入后 skill 存放在 `~/.mcode/skills`,SDK 已能发现
- `SkillInfo` / composer `/` 菜单 — 不涉及

## 验证方式

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` — 全链路类型检查
2. 手动验证(开发环境):
   - 打开设置 → Skills → 「导入 Skill」
   - 点「选择文件夹」,选一个直接含 SKILL.md 的目录 → 列表出现 1 个本地 skill
   - 选一个含多个 skill 子目录的目录 → 列表出现多个本地 skill
   - 勾选 + 导入 → 确认出现在全局 skill 列表,标记「已存在」
