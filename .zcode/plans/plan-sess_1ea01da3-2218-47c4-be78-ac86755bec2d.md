# 右侧面板 Files/Git tab 改为胶囊型 (Pill)

## 范围
- 仅改 `apps/desktop/src/renderer/components/layout/RightPanel.tsx` 一个文件的 tab strip 样式(第 38-61 行)。
- 中间面板线程 tab **不动**(保持下划线型)。
- 逻辑(state / 持久化 / body 渲染)完全不变,只改视觉 className。

## 当前样式(下划线型)
- 容器:`flex shrink-0 border-b border-edge` — 整行 + 底部边框分隔
- 每个 tab:`flex-1` 等宽、`uppercase`、激活 `border-b-2 border-accent`、非激活 `border-b-2 border-transparent`

## 目标样式(胶囊型)
让每个 tab 变成**完全圆角的胶囊**,激活态实心填充,非激活透明 + hover 浅底;外层保留底部边框作为与面板内容的分隔。

### 容器(第 39 行)
- 改为:`flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1.5`
  - 加 `px-2 py-1.5` 让胶囊四周有留白、悬浮于面板背景
  - 加 `items-center gap-1` 让胶囊间有间距、垂直居中
- 移除 `flex-1` 宽度分配 —— 胶囊按内容宽度,不再等宽铺满(这是 pill 风格的典型特征)

### 每个 tab button(第 44-58 行)
- 基础:`flex items-center gap-1.5 rounded-full px-3 py-1 font-medium uppercase tracking-wide transition-colors [font-size:var(--rp-fs-sm)]`
  - `rounded-full` = 胶囊圆角;`px-3 py-1` = 胶囊内边距
- 激活:`bg-surface-muted text-content`(浅底实心填充 + 全色文字)
- 非激活:`text-content-subtle hover:bg-surface-muted/50 hover:text-content-muted`
- 移除原来的 `border-b-2` 下划线相关 class

### 预览效果
```
当前(下划线型):
┌──────────────┬──────────────┐
│  FILES       │  GIT         │   ← 等宽铺满
│══════════════│              │   ← 激活:底部彩色条
└──────────────┴──────────────┘

改后(胶囊型):
  ╭───────╮  ╭───────╮
  │ FILES │  │  GIT  │          ← 按内容宽度,有间距
  ╰───────╯  ╰───────╯          ← 激活:圆角实心填充
──────────────────────────────  ← 底部分隔线保留
```

## 验证
- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 类型检查(仅 className 改动,预期无影响)。
- 视觉:激活 tab 为浅底胶囊,非激活透明 hover 变浅;面板内容与 tab strip 仍有底部分隔线。
