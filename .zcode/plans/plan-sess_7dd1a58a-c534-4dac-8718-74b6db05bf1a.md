## 目标

在设置面板新增「终端」菜单,包含两项:
1. **按项目管理的自定义终端命令** — 替换现有全局命令系统,命令按 `projectId` 区分存储。
2. **终端 Shell 设置** — 为已存在但无 UI 的 `terminal.shell` 设置项补充界面。

## 关键决策(已与用户确认)
- 旧全局命令(`ui.customCommands`)**不迁移,清空重来**:新代码不再读取该 key;已保存的旧数据留在 DB 但被忽略。
- 终端工具栏的书签菜单(`TerminalCommandsMenu`)**保留**,改为读取当前活动项目的命令;支持一键运行 + 快速添加,编辑/删除引导到设置面板。
- 设置面板的「终端」菜单同时包含 **Shell 设置** 和 **按项目自定义命令**。

---

## 改动清单

### 1. `packages/contracts/src/ipc.ts` — 新增 per-project 命令的设置 key

在现有 `UI_CUSTOM_COMMANDS_SETTING_KEY` 附近新增:

```ts
/**
 * Setting key under which per-project terminal quick-commands are persisted.
 * Value is a JSON-encoded `Record<string, CustomCommand[]>` keyed by projectId.
 * Mirrors the per-project IDE-state persistence pattern (ui.ideOpenFiles etc.).
 */
export const UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY = "ui.customCommandsByProject";
```

`CustomCommand` 接口(`{ id, name, command }`)**保持不变**,直接复用。旧 `UI_CUSTOM_COMMANDS_SETTING_KEY` 常量**保留**(避免编译错误),但代码不再使用它,在注释中标注为废弃。

### 2. `apps/desktop/src/renderer/stores/sessionStore.ts` — per-project 命令状态

**类型/初始值**(沿用 `ideOpenFilesByProject` 模式):
- 新增 store 字段 `customCommandsByProject: Record<string, CustomCommand[]>`,初始值 `{}`。
- 移除/废弃字段 `customCommands: CustomCommand[]`(初始值改回 `[]`,保留字段以减小 diff?—— 实际上 `TerminalCommandsMenu` 与 `setCustomCommands` 会改掉,无其它消费者,直接删除该字段及 `setCustomCommands`,保持干净)。

**Hydration**(`init()` 中,替换原 `commandsRes` 读取块):
- 新增并行 `api.setting.get({ key: UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY })`。
- 用已有的 `parseBucket<CustomCommand[]>` 模式解析(参考 `parseBucket` at line ~1733);对每个项目的数组再做 `CustomCommand` shape 校验(沿用原 `valid` filter 逻辑)。
- 写入 `set({ customCommandsByProject: parsed })`。

**新 setter** `setCustomCommandsByProject`(参考 `setCustomCommands` + `persistIdeBuckets` 模式):
- 签名:`(projectId: string, commands: CustomCommand[]) => void`。
- 行为:`set((s) => ({ customCommandsByProject: { ...s.customCommandsByProject, [projectId]: commands } }))`,然后 `api.setting.set({ key, value: JSON.stringify(get().customCommandsByProject) })`。

**新便捷 action** `addCustomCommand(projectId, cmd)` / `updateCustomCommand(projectId, cmd)` / `removeCustomCommand(projectId, id)`:封装常见增删改,避免 UI 层重复拼数组。这三个 action 内部调用 `setCustomCommandsByProject`。

**移除** `setCustomCommands`(仅 `TerminalCommandsMenu` 用,会改)。

### 3. 新增 `apps/desktop/src/renderer/components/settings/TerminalPanel.tsx`

参考 `GitPanel.tsx` 的双区块结构(`<h2>` + `SettingRow` + 控件),含两个区块:

**区块 A:终端 Shell**
- 读:挂载时 `api.setting.get({ key: TERMINAL_SHELL_SETTING_KEY })` -> 本地 state。
- 写:`api.setting.set({ key, value })`。
- UI:`SettingRow` + `<Input>` + 说明文字("留空使用系统默认 shell;例如 pwsh / bash / powershell")。无需 store 字段(主进程在 create 时直接读 setting,与现有 GitPanel 的 diff open mode 类似的直读直写)。
- 提供「测试」按钮可选(调用 `which`?—— 主进程无对应 IPC,略过;仅保存)。

**区块 B:按项目自定义命令**
- 项目选择器:顶部一个 `<Select>`,列出所有未归档项目(`projects.filter(p => !p.archived)`),值为 `projectId`,默认选 `activeProjectId`。
- 命令列表:选中项目的 `customCommandsByProject[pid] ?? []`,每行显示「名称 + 命令 + 编辑/删除按钮」。
- 添加按钮:打开内联编辑表单(Dialog,复用 `TerminalCommandsMenu` 的 Dialog 样式)。
- 编辑/删除:调用 `updateCustomCommand` / `removeCustomCommand`。
- 空态提示:"该项目暂无自定义命令,可在终端工具栏快速添加,或点此添加。"
- 无项目时(projects 为空):整体显示"请先添加项目"。

### 4. `apps/desktop/src/renderer/components/settings/SettingsPage.tsx` — 注册终端菜单

- `SectionId` 类型新增 `"terminal"`。
- `NAV_ITEMS` 在 `git` 之后、`about` 之前插入 `{ id: "terminal", label: "终端" }`。
- import `TerminalPanel`,在 center 渲染链新增 `{active === "terminal" && <TerminalPanel />}`。

### 5. `apps/desktop/src/renderer/components/ide/TerminalCommandsMenu.tsx` — 改为读 per-project

- 不再读 `customCommands` 全局字段;改为:
  - `const activeProjectId = useSessionStore((s) => s.activeProjectId);`
  - `const commands = useSessionStore((s) => (activeProjectId ? s.customCommandsByProject[activeProjectId] : null)) ?? EMPTY;`(模块级 `const EMPTY: CustomCommand[] = []`,遵守 store 选择器稳定引用约定)。
- 保存逻辑(`save`):用 `activeProjectId` 作 key,调用新 store action(`addCustomCommand` / `updateCustomCommand`)。`activeProjectId` 为 null 时禁用添加(按钮禁用 + 提示"请先选择项目")。
- 删除(`remove`):调 `removeCustomCommand(activeProjectId, id)`。
- 列表、运行逻辑(`onRun`)不变——仍写 `command + "\r"` 到 PTY。
- 编辑入口:保留内联编辑 Dialog(用户要求"运行+快速添加";为保持简单与一致,内联编辑/删除仍保留在此菜单,与设置面板都能改同一份数据)。**修正**:用户选项为"运行+快速添加",即编辑/删除走设置面板。故此处移除编辑/删除按钮,仅保留:列表(点击运行)+「添加命令」(快速添加,仅名称+命令两个字段)。删除/编辑引导到设置面板(空态文案中提示)。

### 6. 不需要改动的部分
- **preload / IPC 契约**:复用通用 `setting.get/set`,无需新通道。
- **主进程**:`terminal.create` handler 已读 `terminal.shell` setting,无需改。per-project 命令完全是渲染层状态 + 通用 KV 持久化。
- **TerminalManager / shellResolve**:不动。

---

## 验证
1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 通过(无 `any`、严格模式)。
2. `pnpm dev` 手动验证:
   - 设置面板出现「终端」菜单,含 Shell 设置 + 按项目命令管理。
   - 切换项目,工具栏书签菜单显示对应项目的命令。
   - 在设置面板添加/删除命令,工具栏菜单实时同步(同一 store)。
   - 设置 Shell 后,新建终端使用该 shell;留空用默认。
   - 重启 app,命令与 shell 设置均持久化。
3. 旧 `ui.customCommands` 数据被忽略,不影响新功能。