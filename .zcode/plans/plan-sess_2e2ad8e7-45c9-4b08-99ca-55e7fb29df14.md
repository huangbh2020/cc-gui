# Skill 导入功能实现计划

## 背景与目标

SDK 在自定义 endpoint 场景下不加载 user 级 skill，根因是 provider 为了规避 cc-switch 覆盖 `~/.claude/settings.json`，在自定义 endpoint 时设置了 `settingSources: ["project", "local"]`，这同时禁用了 user 级 skill 加载。

解决方案：**始终设置 `CLAUDE_CONFIG_DIR=~/.mcode`**，让 Mcode 维护独立的全局 skill 目录。这样：
- claude 二进制的用户配置根移到 `~/.mcode`，cc-switch 写的 `~/.claude/settings.json` 不再被读取
- `settingSources` 可以安全地包含 `"user"`（因为 `~/.mcode/settings.json` 由 Mcode 控制）
- 导入的 skill 放到 `~/.mcode/skills/`，SDK 能正常加载

设置页面：移除全局 skill 显示和新建表单的全局选项，新增「导入」功能，支持从 Claude Code (`~/.claude/skills`)、Codex (`~/.codex/skills`)、Zcode (`~/.agents/skills` + `~/.zcode/skills` + 插件目录) 自动扫描并勾选导入。

---

## 改动清单（7 个文件）

### 1. `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts` — 核心：设置 CLAUDE_CONFIG_DIR

**始终在 `options.env` 中设置 `CLAUDE_CONFIG_DIR`**（不再仅在自定义 endpoint 时设置 env）：

- 新增一个辅助函数 `buildSdkEnv()`，始终返回 `{ ...process.env, CLAUDE_CONFIG_DIR: path.join(homedir(), ".mcode") }`
- **标准 endpoint 路径**（无 `apiConfig`）：`options.env = buildSdkEnv()`（当前标准路径不设 env，需要补上）
- **自定义 endpoint 路径**：`options.env = buildCustomEnv(cfg)` 内部也设 `CLAUDE_CONFIG_DIR`（在 `buildCustomEnv` 末尾加一行，或在此处合并）
- **移除 `settingSources: ["project", "local"]`**（第 197 行）：因为配置根已移到 `~/.mcode`，cc-switch 的 `~/.claude/settings.json` 不再被读取，可以安全地让 SDK 使用默认的 `["user", "project", "local"]`，user 级 skill（`~/.mcode/skills/`）即可加载

具体做法：
- 在 `customEnv.ts` 的 `buildCustomEnv` 末尾加 `env.CLAUDE_CONFIG_DIR = path.join(homedir(), ".mcode");`（需 import `path` 和 `homedir`）
- 在 `ClaudeAgentSdkProvider.ts` 中，标准 endpoint 路径也设置 `options.env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(homedir(), ".mcode") };`
- 删除 `options.settingSources = ["project", "local"];` 那一行及其相关注释块

### 2. `apps/desktop/src/main/ipc/skills.ts` — 新增扫描 + 导入 handler

**改动 `resolveSkillRoot`**：
- `global` 改为 `path.join(homedir(), ".mcode", "skills")`（原为 `~/.claude/skills`）

**新增三个 handler**：

```ts
// SKILLS_SCAN_SOURCES — 扫描三个工具的 skill 目录，返回可导入列表
// 返回: { sources: Array<{ tool, skills: SkillSourceInfo[] }> }
// 复用 scanSkillsRoot 逻辑扫描:
//   - Claude Code: ~/.claude/skills
//   - Codex: ~/.codex/skills (跳过 .system 目录)
//   - Zcode: ~/.agents/skills + ~/.zcode/skills + 插件目录 (~/.zcode/cli/plugins/cache/*/*/skills)
// 每个 skill 附带来源 tool 标签 + 源目录绝对路径(供后续复制)

// SKILLS_IMPORT — 导入选中的 skill 到 ~/.mcode/skills
// 输入: { names: string[] } (要导入的 skill name 列表, name 来自 scan 结果)
// 用 fs.cp(srcDir, destDir, { recursive: true }) 复制整个 skill 目录
// 已存在的 skill 跳过(不覆盖),在返回中标记 skipped
// 返回: { imported: string[], skipped: string[], errors: Array<{name, error}> }
```

需要新增辅助函数：
- `scanExternalSkillsRoot(rootDir, tool, into)` — 类似 `scanSkillsRoot` 但额外记录 `sourcePath`（skill 目录绝对路径）和 `tool` 来源
- 导出一个新的类型 `ExternalSkillInfo`（含 `name`, `description`, `tool`, `sourcePath`）

### 3. `packages/contracts/src/ipc.ts` — 新增 IPC 契约

新增类型、schema、RpcMap 条目、IPC 常量：

```ts
// 类型
export type SkillTool = "claude-code" | "codex" | "zcode";
export interface ExternalSkillInfo {
  name: string;
  description: string;
  tool: SkillTool;
  sourcePath: string; // skill 目录绝对路径
}

// Schemas
export const SkillsScanSourcesSchema = z.object({}); // 无入参
export const SkillsImportSchema = z.object({
  skills: z.array(z.object({
    sourcePath: z.string(), // 源目录
    name: z.string().regex(SKILL_NAME_RE), // 导入后的名字
  })),
});

// RpcMap
"skills.scanSources": () => Promise<{ sources: ExternalSkillInfo[] }>;
"skills.import": (input: SkillsImportInput) => Promise<{ imported: string[]; skipped: string[]; errors: Array<{ name: string; error: string }> }>;

// IPC 常量
SKILLS_SCAN_SOURCES: "skills:scanSources",
SKILLS_IMPORT: "skills:import",
```

### 4. `apps/desktop/src/preload/index.ts` — 注册新通道

在 `skills` 命名空间新增：
```ts
scanSources: ((input) => ipcRenderer.invoke(IPC.SKILLS_SCAN_SOURCES, input)) as RpcMap["skills.scanSources"],
import: ((input) => ipcRenderer.invoke(IPC.SKILLS_IMPORT, input)) as RpcMap["skills.import"],
```

### 5. `apps/desktop/src/renderer/components/settings/SkillsPanel.tsx` — UI 改动

**移除全局 skill 显示**：
- 列表中不再显示 `source === "global"` 的 skill（`loadPanelSkills` 后过滤掉 global，或只保留 project）
- 描述文案更新：说明全局 skill 现在通过导入管理，存放在 `~/.mcode/skills`

**新建表单移除全局选项**：
- `NewSkillForm` 中移除「存放范围」Field（ScopeRadio global/project），新建 skill 固定为项目级
- `NewForm` 接口移除 `scope` 字段，`emptyNewForm` 移除 scope，`saveNew` 中固定 `source: "project"`

**新增「导入」按钮 + 导入对话框**：
- 左栏底部在「新建 Skill」旁新增「导入 Skill」按钮
- 点击打开 `ImportSkillsDialog`（基于 Dialog 组件）
- 对话框逻辑：
  1. 打开时调用 `api.skills.scanSources()`，展示 loading
  2. 按来源分组展示扫描到的 skill（Claude Code / Codex / Zcode 分组），每条带 checkbox、name、description、来源标签
  3. 已存在于 `~/.mcode/skills` 的 skill 标记「已存在」并默认不勾选
  4. 底部显示已选数量，点击「导入」调用 `api.skills.import({ skills: [...] })`
  5. 导入完成后关闭对话框，刷新 skill 列表

### 6. `apps/desktop/src/main/providers/claude-sdk/customEnv.ts` — 设置 CLAUDE_CONFIG_DIR

在 `buildCustomEnv` 函数末尾（return 前）加：
```ts
env.CLAUDE_CONFIG_DIR = path.join(homedir(), ".mcode");
```
需新增 `import { homedir } from "node:os";` 和 `import path from "node:path";`

---

## 关键设计决策

1. **CLAUDE_CONFIG_DIR 始终设置**：标准/自定义 endpoint 行为一致，Mcode 完全独立于用户的 Claude Code CLI 安装
2. **移除 settingSources 限制**：配置根移到 `~/.mcode` 后，cc-switch 的 `~/.claude/settings.json` 不再被读取，`settingSources` 可用默认值（含 user），user 级 skill 正常加载
3. **导入用 fs.cp 递归复制**：保留 skill 的完整目录结构（references/、assets/ 等）
4. **不覆盖已存在 skill**：导入时已存在的跳过，避免误覆盖用户手动修改
5. **扫描复用现有逻辑**：`scanSkillsRoot` 已有完善的 frontmatter 解析 + symlink 处理，扩展即可

## 不涉及的部分

- 不改动 SDK 包本身
- 不改动 composer 的 `/` 菜单逻辑（它仍用 `api.skills.list` 扫描，只是全局根从 `~/.claude/skills` 变成 `~/.mcode/skills`）
- 不改动会话存储/持久化逻辑
- 项目级 skill 路径不变（仍为 `<project>/.claude/skills`）

## 验证方式

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 类型检查通过
2. 启动 `pnpm dev`，在设置页面验证：
   - 全局 skill 不再显示
   - 新建表单无全局选项
   - 导入对话框能扫描三个工具的 skill 并展示
   - 勾选导入后，skill 出现在 `~/.mcode/skills/` 目录
   - 自定义 endpoint 下发送含 skill 的 turn，skill 能被加载执行
