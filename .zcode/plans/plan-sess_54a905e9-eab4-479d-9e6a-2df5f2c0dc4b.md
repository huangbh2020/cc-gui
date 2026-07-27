## LeftBar 重构计划 — 使用组件库和图标

### 变更范围
只改 `apps/desktop/src/renderer/components/layout/LeftBar.tsx` 一个文件。

### 具体替换

#### 1. 图标替换 (Unicode → Tabler icons)

| 当前 Unicode | 替换为 | 来源 |
|---|---|---|
| `📁` | `<IconFolder size={14} />` | `@renderer/lib/icons.js` |
| `💬` | `<IconMessage size={14} />` | `@renderer/lib/icons.js` |
| `▸` / `▾` (展开箭头) | `<IconChevronRight size={12} />` (旋转90°) | `@renderer/lib/icons.js` |
| `+` (新建) | `<IconPlus size={12} />` | `@renderer/lib/icons.js` |
| `✓` (激活) | `<IconCheck size={12} />` | `@renderer/lib/icons.js` |
| `⋯` (菜单) | `<IconDotsVertical size={12} />` | `@renderer/lib/icons.js` |
| `→` (引导箭头) | `<IconArrowRight size={12} />` | `@renderer/lib/icons.js` |

#### 2. 上下文菜单 (NodeMenu) → @base-ui/react Menu

手写 NodeMenu (click-away catcher + absolute div) 替换为 `@base-ui/react` 的 Menu primitive:
- `Menu.Root` — 状态容器（接受 `open` / `onOpenChange`）
- `Menu.Trigger` — 触发按钮（dots icon）
- `Menu.Portal` + `Menu.Positioner` + `Menu.Popup` — 弹出面板
- `Menu.Item` — 菜单项（`className` 里处理 `danger` 样式,使用 `data-[highlighted]` 选择器）

优势：键盘导航（arrow keys / Enter / Escape）、焦点管理、点击外部关闭全由 base-ui 处理。

#### 3. 按钮 → Button 组件

- Header "添加项目" → `<Button variant="ghost" size="sm">`
- 归档折叠区开关 → `<Button variant="ghost" size="sm">` + 全宽
- 其余树内交互元素（展开箭头、项目名、会话行、"+"/"恢复"/"删"等）保持 `<button>` 但改用 `cn()` 管理 className

#### 4. className → cn()

所有 template literal 拼接的 className 改为 `cn()` 调用，旧代码已匹配的样式不变。

### 不做的
- ❌ 不改动 LeftBar 外部的任何组件
- ❌ 不改动 store / 业务逻辑
- ❌ 不引入 react-icons 的额外图标（所有替换的图标 Tabler 都有覆盖）

### 类型检查
修改完成后 `npx tsc --noEmit -p tsconfig.json` 验证。

### 涉及文件
| 操作 | 文件 |
|------|------|
| 修改 | `apps/desktop/src/renderer/components/layout/LeftBar.tsx` |
