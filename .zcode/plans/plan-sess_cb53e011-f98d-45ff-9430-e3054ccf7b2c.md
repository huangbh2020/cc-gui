# 右侧面板字体统一管理 - 实施计划

## 目标

在设置页面的"通用(General)"页签(目前是占位符)中新增"右侧面板字体大小"设置,范围 10-22px,默认 14px,步进 1px。该设置统一驱动文件树、Git 面板、终端三个 tab 的字号。完全复刻现有 `chatFontSize` 的端到端链路(CSS 变量 + store 持久化 + appearance hook + Tailwind 任意值消费),终端额外通过 store 值联动 xterm `fontSize`。

## 字号层级映射设计

定义 1 个基础变量 + 3 个派生变量(复用 chat 的比例系数),保留各面板内原有的视觉层级:

| 变量 | calc 公式 | 默认值 | 用途(原字号) |
|------|----------|--------|--------------|
| `--right-panel-font-size` | base | 14px | 正文主体(文件树节点、Git仓库名/文件路径/提交信息/按钮) |
| `--rp-fs-sm` | base × 0.8571 | ≈12px | tab 按钮、placeholder 标签(原 11-12px) |
| `--rp-fs-xs` | base × 0.7857 | ≈11px | loading/empty 提示文案(原 11px) |
| `--rp-fs-xxs` | base × 0.7143 | ≈10px | 元数据:hash/计数/状态图标/分组小标题(原 10px) |

终端 xterm `fontSize` 直接取 store 的 `rightPanelFontSize` 数值(= base,默认 14)。

---

## 实施步骤(7 处改动)

### ① `packages/contracts/src/ipc.ts` — 新增 setting key

在 `UI_CHAT_FONT_SIZE_SETTING_KEY`(第 63 行)后新增:
```ts
export const UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY = "ui.rightPanelFontSize";
```
带文档注释(value 是数字字符串如 "14",10-22px,在 renderer store action 里 clamp)。

### ② `apps/desktop/src/renderer/stores/sessionStore.ts` — store 字段 + 常量 + setter + hydration

完全仿照 `chatFontSize` 的实现(第 524-533、168-171、353-355、1218、1291-1300、2446-2457 行):
- 导入 `UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY`
- 新增常量 `RIGHT_PANEL_FONT_SIZE_MIN = 10`、`RIGHT_PANEL_FONT_SIZE_MAX = 22` + `clampRightPanelFontSize(px)` 函数(非法值返回 14)
- `SessionState` 接口加 `rightPanelFontSize: number;`(带注释)
- `SessionActions` 接口加 `setRightPanelFontSize: (px: number) => Promise<void>;`
- 初始 state 加 `rightPanelFontSize: 14,`
- `init()` 的 `Promise.all` 块(第 1291 行)加一项 `api.setting.get({ key: UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY })`,读回后 `clampRightPanelFontSize` 校验
- 实现 `setRightPanelFontSize`:先 `set({ rightPanelFontSize: clamped })`,再 `await api.setting.set(...)`

### ③ `apps/desktop/src/renderer/lib/appearance.ts` — CSS 变量应用 + 新 hook

- 新增 `applyRightPanelFontSize(px)`:写 `--right-panel-font-size: ${px}px` 到 `<html>`
- 新增 `useRightPanelAppearance()` hook:订阅 `rightPanelFontSize`,`useEffect` 调 `applyRightPanelFontSize`
- 不污染现有 `useChatAppearance`(职责清晰,各自独立 hook)

### ④ `apps/desktop/src/renderer/App.tsx` — 挂载新 hook

在 `useChatAppearance()`(第 23 行)旁加一行 `useRightPanelAppearance();`

### ⑤ `apps/desktop/src/renderer/styles.css` — CSS 变量默认值 + 派生

- `:root`(第 44 行附近)和 `.dark`(第 68 行附近)各加 `--right-panel-font-size: 14px;`
- 新增独立 `:root` 块加派生变量(仿第 82-87 行 chat 派生):
```css
:root {
  --rp-fs-sm: calc(var(--right-panel-font-size) * 0.8571);
  --rp-fs-xs: calc(var(--right-panel-font-size) * 0.7857);
  --rp-fs-xxs: calc(var(--right-panel-font-size) * 0.7143);
}
```

### ⑥ 新建 `apps/desktop/src/renderer/components/settings/GeneralPanel.tsx` + 改 `SettingsPage.tsx` — 设置 UI

**新建 `GeneralPanel.tsx`**:仿 `AppearancePanel.tsx` 第 189-208 行的聊天字体大小滑块,结构为:
- 外层容器 `<div className="divide-y divide-edge">` 包裹
- 一个 `SettingRow`(title="右侧面板字体大小",desc 提示 10-22px,htmlFor)
- 原生 `<input type="range" min={10} max={22} step={1}>` + `<span>{rightPanelFontSize}px</span>`
- 从 store 读 `rightPanelFontSize` / `setRightPanelFontSize`,从 store 导入 `RIGHT_PANEL_FONT_SIZE_MIN/MAX`
- 复用 `AppearancePanel` 顶部的 `DEFAULT_FONT_SIZE` 概念(默认14)

**改 `SettingsPage.tsx`**:
- 顶部 import `GeneralPanel`
- 第 86-88 行:把 `{active === "general" && (<PlaceholderPanel .../>)}` 替换为 `{active === "general" && <GeneralPanel />}`

### ⑦ 消费端 — 右侧面板各组件替换硬编码字号

**7a. `RightPanel.tsx`**(tab 条外壳):
- 第 61 行 tab 按钮 `text-[11px]` → `[font-size:var(--rp-fs-sm)]`
- 第 101 行 placeholder label `text-xs` → `[font-size:var(--rp-fs-sm)]`
- 第 104 行 placeholder hint `text-[11px]` → `[font-size:var(--rp-fs-xs)]`

**7b. `FileTree.tsx`**(文件树):
- 第 78 行根容器 `text-xs` → `[font-size:var(--right-panel-font-size)]`(子节点继承)
- 第 62 行 loading `text-[11px]` → `[font-size:var(--rp-fs-xs)]`
- 第 71 行 empty `text-[11px]` → `[font-size:var(--rp-fs-xs)]`

**7c. Git 面板三文件**(`GitPanel.tsx` / `GitRepoCard.tsx` / `GitHistoryView.tsx`):
- 所有面板内联的 `text-[11px]`(正文:仓库名、子tab、提交信息框、按钮、菜单项、文件路径、提示文案)→ `[font-size:var(--right-panel-font-size)]`
- 所有 `text-[10px]`(元数据:hash、分支名、ahead/behind、+/-计数、状态字母、分组小标题)→ `[font-size:var(--rp-fs-xxs)]`
- 语义化 `text-xs`(空状态主文案)→ `[font-size:var(--right-panel-font-size)]`
- ⚠️ **不改 Dialog 弹窗内容**:`GitRepoCard.tsx` 第 331/334/343/351 行的"放弃更改"对话框内的 `text-sm`/`text-xs` 保持原样(模态弹窗走全局字号,不跟面板字号)
- ⚠️ `CommitDetail` 的 `text-[12px]`(第 299 行 commit subject,作为详情页主标题)→ `[font-size:var(--right-panel-font-size)]`

**7d. `TerminalView.tsx`**(终端 xterm 联动):
- 顶部加 `const rightPanelFontSize = useSessionStore((s) => s.rightPanelFontSize);`
- 第 147 行构造参数 `fontSize: 12` → `fontSize: rightPanelFontSize`
- 新增一个 `useEffect([rightPanelFontSize])`:若 `termRef.current` 已存在,执行 `termRef.current.options.fontSize = rightPanelFontSize;` 然后 `fitRef.current?.fit()`(xterm 支持运行时改字号 + 重算行列,无需重建实例)

**不改动**:`FilesPanel.tsx`(容器不设字号,由 FileTree 根容器驱动)、`FileEditor.tsx`(Monaco 编辑器是独立代码视图,不属于三 tab 面板内容,保持 fontSize:12)、`tailwind.config.js`(无 fontSize token 先例,用任意值语法)。

---

## 验证

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` — 类型检查
2. `pnpm dev` 手动验证:
   - 设置 → 通用 → 滑动字体大小,文件树/Git/终端三处实时缩放
   - 重启应用,设置值持久化
   - 终端字号变化后行列数正确重算(fit)、输入正常
   - Git"放弃更改"弹窗字号不受影响
   - 切换 light/dark 主题,字号一致