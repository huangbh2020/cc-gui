# 修复计划

## 问题1：模型思考时计时器一直显示 `<1s` 不刷新

### 根因
`TurnStatRow`（`ChatPane.tsx:103-128`）用组件内 `setInterval` 每秒 `force` 重渲染来更新用时。但它渲染在 LegendList（v3.0.0-beta.44 beta 版虚拟列表）的 item 内部。思考期间 delta 高频 flush → `renderItems` 数组频繁重建 → LegendList `data`/`extraData` 每次都是新引用 → 虚拟化容器重新渲染/重分配 → `TurnStatRow` 可能在 1 秒内被卸载重挂载 → `useEffect` cleanup 执行 `clearInterval` → 新 interval 从 0 重新计时 → 永远等不到 1000ms → duration 永远 `<1s`。

已排除：`startedAt` 只在首个 delta 创建消息时设置一次（`sessionStore.ts:1433`）；`endedAt` 仅在 `turn.done`/`error` 时设置（`sessionStore.ts:2825/2796`）。

### 修复方案：用全局共享 tick 替代组件内 setInterval

将计时器从"依赖组件持续挂载"改为"全局共享 interval + `useSyncExternalStore` 订阅"，使计时更新不受虚拟化列表的挂载/卸载影响。

**1. 新建 `apps/desktop/src/renderer/hooks/useNow.ts`**
- 模块级：`listeners: Set<() => void>`、`interval` 句柄、`currentTick`（初始 `Date.now()`）
- `subscribe(cb)`：有 listener 时启动全局 `setInterval(1000)` 更新 `currentTick` 并通知所有 listener；最后一个 listener 移除时 `clearInterval`
- `getSnapshot()`：返回 `currentTick`
- 导出 `useNow(): number`——用 `useSyncExternalStore` 封装，全局共享同一个 interval

**2. 修改 `ChatPane.tsx` 的 `TurnStatRow`**
- 拆分为两个分支，避免已完成 turn 不必要的每秒重渲染：
  - `meta.endedAt === undefined`（live）→ 渲染 `<LiveTurnStatRow>`，调用 `useNow()` 获取当前时间
  - `meta.endedAt` 已设置（frozen）→ 渲染 `<FrozenTurnStatRow>`，直接用静态 `endedAt - startedAt`
- 移除 `useState` / `useEffect` / `setInterval`（原 105-111 行）
- 提取共享的渲染内容为 `StatContent` 子组件（开始时间 + 用时 + live 时的 spinner）

## 问题2：去掉右上角胶囊弹出层中的上下文统计

### 修复方案：删除 ActivityPopover 的 UsageSection 及相关数据流

**1. 修改 `ActivityPopover.tsx`**
- 删除 `UsageSection`（207-327）、`TurnUsageRow`（330-392）、`fmtDuration`（190-197）、`totalCost`（200-202）
- 删除 `showUsage` 定义（483 行）和渲染块（505-509 行）
- 删除 `snapshot` / `usageHistory` props（471-472, 477-478 行）
- 清理 imports：`TurnUsageRecord`、`ContextSnapshot`、`fmtTokens`、`getContextBreakdown`、`IconCoins`、`IconDatabase`、`IconArrowBarToDown`、`IconArrowBarToUp`、`IconStack2`、`IconCpu`、`IconClock`、`IconChevronDown`、`IconChevronRight`（均已确认仅 UsageSection 使用）
- 更新文件顶部 JSDoc 注释，移除 Usage 相关描述

**2. 修改 `StatusCapsule.tsx`**
- 删除 `snapshot` / `usageHistory` props 定义（28-29, 34-35 行）
- 删除传给 `ActivityPopover` 的 `snapshot` / `usageHistory`（101-102 行）
- 删除 `ContextSnapshot` / `TurnUsageRecord` 类型 import（已不再使用）

**3. 修改 `ChatPane.tsx`**
- 删除 `contextSnapshot` 订阅（352 行）和 `usageHistory` 订阅（355-357 行）
- 删除传给 `StatusCapsule` 的 `snapshot` / `usageHistory`（839-840 行）
- 从 import 行移除 `EMPTY_USAGE`（已不再使用）

## 验证
- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 确认无类型错误