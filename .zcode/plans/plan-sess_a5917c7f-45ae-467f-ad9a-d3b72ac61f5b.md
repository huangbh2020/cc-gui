# 快捷键系统实现方案

## 设计核心：复用命令注册表作为单一数据源

项目已有完善的**命令注册表**（`lib/commands.ts`），每个 `CommandDef` 都有 `id` + `perform` + `shortcutHint`（仅显示，未真实绑定）。快捷键系统直接挂载到这个注册表上：

- 快捷键 = `Record<commandId, accelerator>`（持久化的覆盖映射）
- 全局监听器遍历命令列表，按下匹配的组合键就调 `cmd.perform(store)`
- **命令面板和快捷键共享同一份 `perform`，零重复**
- `shortcutHint` 改为从实际生效的快捷键动态派生，命令面板自动显示真实绑定

## 数据结构设计

### 1. accelerator 表示法（平台感知）
```ts
// 一个"逻辑组合键",平台无关存储
interface Accelerator {
  key: string;        // 主键,规范化小写:"k", "f", "n", "b" ... (单字符或特殊键名)
  cmd: boolean;       // 修饰键:存储为 cmd,Mac 显示 ⌘;Win/Linux 监听时用 ctrlKey
  shift: boolean;
  alt: boolean;
}
// 序列化为紧凑字符串持久化:"cmd+shift+f"(与 Electron accelerator 风格一致)
```

**跨平台处理**（已确认）：统一存 `cmd`，监听时 `metaKey || ctrlKey` 都算匹配；显示时 Mac 用 `⌘`、Win/Linux 用 `Ctrl`。

### 2. 快捷键映射表
```ts
// Record<commandId, accelerator>
type ShortcutBindings = Record<string, Accelerator>;
// 只存"用户覆盖项";未出现在此表中的命令用 DEFAULT_SHORTCUTS 兜底
```

## 默认快捷键表（11 项，全部采用推荐列表）

| 命令 id | 默认绑定 | 说明 |
|---|---|---|
| `command.palette` | `Cmd+K` | 切换命令面板（新增命令，原硬编码迁移） |
| `files.search` | `Cmd+Shift+F` | 搜索文件（原硬编码迁移） |
| `view.settings` | `Cmd+,` | 打开设置（原仅显示，现真实绑定） |
| `session.new` | `Cmd+N` | 新建线程/会话 |
| `layout.toggle-left` | `Cmd+B` | 切换左侧栏（对齐 VS Code） |
| `layout.toggle-right` | `Cmd+Shift+B` | 切换右侧栏 |
| `layout.toggle-bottom-terminal` | `Cmd+\`` | 切换底部终端（对齐 VS Code） |
| `view.display-mode.toggle` | `Cmd+Shift+T` | 切换单会话/标签模式（新增命令） |
| `appearance.theme.toggle` | `Cmd+Shift+L` | 切换深/浅主题（新增命令） |
| `tab.close` | `Cmd+W` | 关闭当前 Tab（新增命令，仅 tabs 模式可用） |
| `app.zoom-reset` | `Cmd+0` | 重置缩放（新增命令） |

> 注：`command.palette` 和 `files.search` 原本硬编码在 `App.tsx`，迁移到新系统后 `App.tsx` 的硬编码监听器删除。`view.display-mode.toggle`、`appearance.theme.toggle`、`tab.close` 是为快捷键新增的"toggle"型命令（现有的 `view.display-mode.single/tabs` 和 `appearance.theme.light/dark` 是"设为某值"型，不适合 toggle 快捷键，保留不动）。

## 实现步骤（按文件）

### 步骤 1 — 契约层：新增 setting key + 类型（`packages/contracts/src/ipc.ts`）
仿照 `DISPLAY_MODE_SETTING_KEY`（第 53 行）模式，新增：
- `export const UI_SHORTCUTS_SETTING_KEY = "ui.shortcuts";`
- `AcceleratorSchema`、`ShortcutBindingsSchema`（zod 校验结构，防 DB 损坏）
- `type Accelerator`、`type ShortcutBindings`
- 无需新增 IPC 通道——复用通用 `setting.get/set`。

### 步骤 2 — 新建快捷键核心模块（renderer）
**新建 `apps/desktop/src/renderer/lib/shortcuts.ts`**——纯逻辑、无 React：
- `DEFAULT_SHORTCUTS: Record<commandId, Accelerator>`（11 项默认表）
- `acceleratorToString(a)` / `stringToAccelerator(s)`：序列化/反序列化（`"cmd+shift+f"` ↔ 对象）
- `acceleratorToDisplayString(a)`：渲染显示用，Mac 输出 `⌘⇧F`、其他平台输出 `Ctrl+Shift+F`
- `eventToAccelerator(e: KeyboardEvent): Accelerator | null`：从按键事件构造 accelerator（录制时用）
- `matchAccelerator(e, a): boolean`：监听时判断事件是否匹配（`cmd` 修饰键同时接受 `metaKey`/`ctrlKey`）
- `isShortcutInput(target: EventTarget | null): boolean`：判断事件源是否在输入框/编辑器/终端内（决定是否拦截）
- `normalizeKey(e)`：把 `e.key` 规范化（处理 `" "` → `"space"`、`Escape` 等）

### 步骤 3 — 改造命令注册表（`lib/commands.ts`）
- `CommandDef.shortcutHint` 字段从静态字符串改为可选的 `accelerator` 引用：新增 `defaultAccelerator?: Accelerator` 字段，标记哪些命令有默认快捷键
- 新增 3 个 toggle 命令：`view.display-mode.toggle`、`appearance.theme.toggle`、`tab.close`
- 新增 `command.palette` 命令（绑定 `setCommandPaletteOpen` toggle）
- 新增 `app.zoom-reset` 命令（调 `webFrame.setLayoutZoomLevel(0)` / Electron zoom reset）
- `collectCommands()` 返回值额外暴露每个命令的**生效快捷键**（默认 + 用户覆盖合并后的结果），供命令面板显示

### 步骤 4 — sessionStore 接入（`stores/sessionStore.ts`）
- 新增状态字段：`shortcutOverrides: ShortcutBindings`（默认 `{}`）
- 新增 action：
  - `setShortcutOverride(commandId, accel | null)`：`null` 表示清除覆盖（回退默认）；乐观更新 + `api.setting.set` 持久化整个合并表
  - `resetAllShortcuts()`：清空所有覆盖
- `initDeferred()` 里 hydrate：读取 `UI_SHORTCUTS_SETTING_KEY`，`JSON.parse` + `ShortcutBindingsSchema.safeParse` 校验，失败则忽略保持默认
- 写回逻辑：每次 `setShortcutOverride` 把整个 `shortcutOverrides` 序列化为 JSON 写入

### 步骤 5 — 新建快捷键监听 hook（`hooks/useGlobalShortcuts.ts`）
```ts
// 挂在 App 根,单一全局 window keydown 监听器
useGlobalShortcuts();
```
逻辑：
1. 从 store 读取 `shortcutOverrides`，与 `DEFAULT_SHORTCUTS` 合并出**生效表**
2. 注册一个 `window.addEventListener("keydown", handler)`（capture 阶段，确保优先于 chat 组件的 capture listener）
3. handler：用 `eventToAccelerator` + 遍历生效表找匹配的 commandId
4. 找到后：`e.preventDefault()` + `e.stopPropagation()` + 调 `collectCommands(getState()).find(id)?.perform(getState())`
5. **输入源守卫**：当焦点在 `<input>`/`<textarea>`/`[contenteditable]`/xterm/Monaco 内时，**仅放行带修饰键的快捷键**（纯字母不放行，避免影响打字）；带 `Cmd/Ctrl/Alt` 的组合键即使在输入框内也拦截（符合 VS Code 行为）
6. 依赖 `shortcutOverrides` 变化时重新注册

### 步骤 6 — 设置面板新增「快捷键」section
**新建 `components/settings/ShortcutsPanel.tsx`**：
- 用 `SettingRow`（vertical 布局）逐行展示，按 `COMMAND_GROUPS` 分组
- 每行右侧是**快捷键捕获控件** `ShortcutRecorder`（新建子组件）
- 顶部有「恢复全部默认」按钮
- 底部有冲突说明文字

**新建 `components/settings/ShortcutRecorder.tsx`**（核心交互组件）：
- 三态：`idle`（显示当前绑定的 `<kbd>` + 「修改」按钮）/ `recording`（显示"按下组合键…"，监听下一次按键）/ `conflict`（若捕获到的组合键已被其他命令占用，显示冲突提示 + 确认覆盖/取消）
- 录制逻辑：进入 `recording` 态后挂一个一次性的 `keydown` listener，用 `eventToAccelerator` 解析，按 Esc 取消
- 校验：必须有至少一个修饰键（cmd/ctrl/alt），纯单字母不允许；显示规范化后的组合
- 用项目 UI 组件库：`<Button>` 做按钮，`<Tooltip>` 做提示，`<kbd>` + 语义 token 做展示

**修改 `SettingsPage.tsx`**：
- `SectionId` 加 `"shortcuts"`
- `NAV_ITEMS` 加 `{ id: "shortcuts", label: "快捷键" }`
- center 区加 `{active === "shortcuts" && <ShortcutsPanel />}`
- 注意：`SettingsPage` 已有 Esc 关闭面板的 listener（第 61-67 行），需确保 `ShortcutRecorder` 录制时 Esc 被 Recorder 消费而非冒泡关闭面板——通过 Recorder 用 capture + `stopPropagation` 实现

### 步骤 7 — 清理 App.tsx 硬编码 + 挂载 hook
- **删除** `App.tsx:90-109` 的硬编码 `window.addEventListener("keydown")`（Cmd+K / Cmd+Shift+F 已迁移到新系统）
- 删除 `setCommandPaletteOpen` / `setSearchDialogOpen` 的局部订阅（不再需要，hook 内部用 `getState()`）
- 在 `App()` 顶部调用 `useGlobalShortcuts()`

### 步骤 8 — 命令面板显示真实绑定（`CommandPalette.tsx`）
- `cmd.shortcutHint` 改为从 store 的生效快捷键动态读取（通过 `collectCommands` 或新 helper），显示 `acceleratorToDisplayString`
- 这样用户改了快捷键后，命令面板的 `<kbd>` 自动同步

## 关键设计决策说明

1. **为何用 capture 阶段注册全局 listener**：现有 chat 组件（SlashCommandPicker、ApprovalPrompt 等）用 `document` capture 监听箭头键/Esc。新快捷键 listener 挂 `window` capture，比 document 更早触发，能优先消费带修饰键的组合，避免被 chat 组件意外拦截。

2. **为何 toggle 命令而非复用 single/tabs 命令**：现有 `view.display-mode.single` 是"设为 single"（`available: displayMode !== "single"`）。一个快捷键反复按应做 toggle，所以新增 `view.display-mode.toggle` 在 single↔tabs 间翻转。主题同理。

3. **输入源守卫**：避免 Cmd+B 在聊天输入框里失效（VS Code 行为），但纯"B"在输入框里要正常打字。规则：有修饰键 → 拦截；无修饰键 → 放行给输入框。

4. **持久化只存覆盖项**：默认表是代码常量，DB 只存用户改过的条目。升级版本新增默认快捷键时自动生效，老用户的覆盖保留。

5. **冲突处理**：录入时即时检测，若组合键已被其他命令占用，提示"该组合已被【XX】占用，是否覆盖"，确认后把旧命令的覆盖清除。

## 文件清单（新增 + 修改）

**新增**：
- `packages/contracts/src/ipc.ts`（修改：加 setting key + schema）
- `apps/desktop/src/renderer/lib/shortcuts.ts`（核心逻辑）
- `apps/desktop/src/renderer/hooks/useGlobalShortcuts.ts`（监听 hook）
- `apps/desktop/src/renderer/components/settings/ShortcutsPanel.tsx`（设置面板）
- `apps/desktop/src/renderer/components/settings/ShortcutRecorder.tsx`（捕获控件）

**修改**：
- `apps/desktop/src/renderer/lib/commands.ts`（加 defaultAccelerator 字段 + 4 个新命令）
- `apps/desktop/src/renderer/stores/sessionStore.ts`（加状态 + action + hydrate）
- `apps/desktop/src/renderer/components/settings/SettingsPage.tsx`（加 section）
- `apps/desktop/src/renderer/App.tsx`（删硬编码 + 挂 hook）
- `apps/desktop/src/renderer/components/layout/CommandPalette.tsx`（显示真实绑定）

## 验证方式
- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 类型检查
- `pnpm dev` 启动验证：默认快捷键全部生效、设置面板可录入修改、冲突提示、持久化重启后保留、命令面板 `<kbd>` 同步、输入框内打字不受影响