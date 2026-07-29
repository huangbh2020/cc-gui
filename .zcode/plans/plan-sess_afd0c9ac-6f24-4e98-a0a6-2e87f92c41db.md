# 面板可拖拽调整宽度实施计划

## 目标
左侧栏、右侧栏、底部终端栏、以及中间区域内的聊天|编辑器分栏均可自由拖拽调整宽度，且宽度持久化（重启后恢复）。

## 现状
- `ThreePaneLayout.tsx`：左右栏宽度硬编码（`w-[280px]` / `w-[360px]`），底部终端高度硬编码（`h-[280px]`），无拖拽手柄
- `CenterPane`（App.tsx:148-162）：聊天与编辑器各占 `flex-1`（50/50），仅有 `border-l border-edge` 无手柄
- `Titlebar.tsx:73`：左侧条硬编码 `w-[280px]` 与侧栏对齐
- Monaco（`automaticLayout: true`）和 xterm（ResizeObserver + fit）**已自动响应容器尺寸变化，无需额外处理**
- 项目中无任何拖拽实现，无分栏库——**手写**符合项目风格

## 设计方案

### 核心组件：复用的 `Divider` + `useResizable` hook
手写一个通用的水平/垂直拖拽手柄，4 处分栏共用同一套逻辑，避免重复代码。

**新建 `components/layout/Divider.tsx`**：
- `<Divider orientation="vertical" />`（用于左右栏分隔，光标 `col-resize`）
- `<Divider orientation="horizontal" />`（用于底部终端分隔，光标 `row-resize`）
- 视觉：1px 分隔线（`bg-edge`），hover 时加宽热区 + 变色（`hover:bg-accent/40`），拖拽中全局 `select-none`
- 交互：`onMouseDown` → `document.addEventListener('mousemove'/'mouseup')`，计算 delta 调用 `onResize(deltaPx)`
- 拖拽期间在 body 上加 `cursor-col-resize`/`cursor-row-resize` + `user-select: none`，防止文字选中

### 数据层：宽度状态放 store + 持久化

**`packages/contracts/src/ipc.ts`**：新增 setting key 常量
```
UI_PANE_WIDTHS_SETTING_KEY = "ui.paneWidths"
```
值是 JSON：`{ left: 280, right: 360, bottomTerminal: 280, editor: 50 }`（editor 用百分比 0-100）

**`sessionStore.ts`** 改动：
1. 新增状态字段：
   - `leftWidth: number`（默认 280）
   - `rightWidth: number`（默认 360）
   - `bottomTerminalHeight: number`（默认 280）
   - `editorWidthPct: number`（默认 50，表示编辑器列占中心区域的百分比）
2. 新增 clamp 常量 + 函数（参照 `clampRightPanelFontSize` 模式）：
   - `LEFT_WIDTH_MIN=180 / MAX=500`
   - `RIGHT_WIDTH_MIN=240 / MAX=640`
   - `BOTTOM_TERMINAL_HEIGHT_MIN=80 / MAX=600`
   - `EDITOR_WIDTH_PCT_MIN=20 / MAX=80`
3. 新增 actions（直接 set，不异步——宽度拖拽需要高频更新，持久化用 debounce）：
   - `setLeftWidth(px)` / `setRightWidth(px)` / `setBottomTerminalHeight(px)` / `setEditorWidthPct(pct)`
   - 每个 setter：clamp 后 `set({...})`，**debounce 300ms 后** `api.setting.set` 持久化（拖拽过程中频繁更新，不应每次都写 DB）
4. `init()` 中 hydrate：读 `UI_PANE_WIDTHS_SETTING_KEY`，JSON.parse + 校验 + clamp，`set({...})`

### 布局层改动

**`ThreePaneLayout.tsx`**：
- 接收新 props：`leftWidth` / `rightWidth` / `bottomTerminalHeight` / 对应的 `onResize` 回调
- 左栏：`w-[280px]` → `style={{ width: leftWidth }}`
- 右栏：`w-[360px]` → `style={{ width: rightWidth }}`
- 底部终端：`h-[280px]` → `style={{ height: bottomTerminalHeight }}`
- 在 left|center、center|right 之间插入 `<Divider orientation="vertical" />`（仅当对应栏 open 时渲染）
- 在 center|bottomTerminal 之间插入 `<Divider orientation="horizontal" />`（仅当 bottomTerminalOpen 时渲染）
- **保留** `overflow-hidden`（xterm FitAddon 要求）、`shrink-0`、`min-w-0`/`min-h-0`

**`CenterPane`（App.tsx）**：
- 聊天列：`flex-1` → `style={{ flexBasis: (100 - editorWidthPct) + "%" }}` + `flex-grow: 0` + `min-w-0`
- 编辑器列：`flex-1` → `style={{ flexBasis: editorWidthPct + "%" }}` + `flex-grow: 0` + `min-w-0`
- 在两列之间插入 `<Divider orientation="vertical" />`（仅当 `activeFile` 存在时）
- 无文件打开时，聊天列恢复全宽（flex-1）

**`Titlebar.tsx`**：
- 左侧条 `w-[280px]` → 从 store 读 `leftWidth`，用 `style={{ width: leftWidth }}`（仅 leftOpen 时）

**`App.tsx`**：
- 从 store 读取四个宽度值，传入 ThreePaneLayout 和 CenterPane

## 文件改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `packages/contracts/src/ipc.ts` | 改 | 新增 `UI_PANE_WIDTHS_SETTING_KEY` 常量 |
| `apps/desktop/src/renderer/components/layout/Divider.tsx` | **新建** | 通用拖拽手柄组件（vertical/horizontal） |
| `apps/desktop/src/renderer/stores/sessionStore.ts` | 改 | 4 个宽度状态 + clamp + actions + init hydrate + debounce 持久化 |
| `apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx` | 改 | 硬编码宽度→style 驱动，插入 3 个 Divider |
| `apps/desktop/src/renderer/App.tsx` | 改 | CenterPane 聊天|编辑器分栏加 Divider + 宽度驱动；传宽度给 ThreePaneLayout |
| `apps/desktop/src/renderer/components/layout/Titlebar.tsx` | 改 | 左侧条宽度从 store 读取 |

## 关键技术细节

1. **debounce 持久化**：拖拽时 mousemove 每帧都会触发 setter，但 DB 写入用 300ms debounce（模块级 timer），拖拽停止后才落盘。UI 更新始终即时（`set()` 同步）。
2. **Divider 热区**：实际可点击区域 5px（`w-[5px]`），视觉线条 1px 居中，避免难以瞄准。hover 时显示 `bg-accent/30` 提示。
3. **拖拽方向计算**：
   - 左栏 Divider：拖动向右 → 宽度增大 → `newWidth = leftWidth + (currentX - startX)`
   - 右栏 Divider：拖动向右 → 宽度减小 → `newWidth = rightWidth - (currentX - startX)`
   - 底部终端：拖拽向下 → 高度增大
   - 编辑器 Divider：拖拽换算为百分比（基于中心区域实际宽度，用 `getBoundingClientRect`）
4. **边界保护**：clamp 保证每个面板不小于最小值，且当总宽度超出窗口时中心区域仍有 `min-w-0` 防溢出。
5. **保留 overflow-hidden**：xterm 的祖先容器必须保持 `overflow-hidden`，否则 FitAddon 会失效。

## 验证方式
1. **TypeScript**：`cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
2. **运行时**（`pnpm dev`）：
   - 拖动左/右栏分隔条，宽度实时变化，Monaco 和文件树自动适配
   - 拖动底部终端分隔条，高度实时变化，xterm 自动 fit + pty resize
   - 打开文件后拖动聊天|编辑器分隔条，两栏比例变化
   - Titlebar 左侧条随左栏宽度同步
   - 重启应用，宽度恢复（持久化生效）
   - 拖到最小/最大边界，宽度被 clamp 住，不会消失或溢出