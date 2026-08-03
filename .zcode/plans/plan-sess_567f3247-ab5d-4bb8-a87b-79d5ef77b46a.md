## 目标

点击 composer 输入框的「上下文用量圆环」时，打开一个上下文统计面板。面板顶部保留当前轮的简易统计，底部新增一个统计按钮，点击后查看本线程历史所有回复的 token 详细情况。

## 设计决策（基于代码现状的最佳判断）

- **入口**：圆环本身可点击（把 `Tooltip.Trigger` 的 `render={<span />}` 改为 `<button />`）。hover 仍显示简易 tooltip，click 打开面板。不增加 composer 按钮数量。
- **面板形态**：圆环原地向上弹出一个浮层（采用 `StatusCapsule` + `ActivityPopover` 的手写 absolute 定位范式，不引入新依赖）。浮层顶部是当前轮的 `ContextTooltipBody`（复用已有组件），底部加一个「查看历史详情」图标按钮。
- **历史详情**：点击按钮后，在同一个浮层内切换为「历史详情视图」（浮层内 `view: "current" | "history"` 状态切换，避免再开一层浮层），展示一个紧凑表格，每轮一行。
- **展示字段**：完整字段——轮次序号 / 时间 / 耗时 / 处理 token / 输出 token / 缓存读 / 缓存写 / 累计占用 / 费用 / 模型。
- **空态**：`usageHistoryBySession` 为空（首轮回合前 / 刚重启）时，历史区显示「本轮结束后将显示历史」。

## 数据来源

- 当前轮：`contextSnapshotBySession[activeSessionId]`（已有，ComposerToolbar 已取）。
- 历史：`usageHistoryBySession[activeSessionId] ?? EMPTY_USAGE`（store 已维护，目前无消费者）。

## 改动清单

### 1. `apps/desktop/src/renderer/lib/icons.tsx`（新增图标导出）
在 Tabler 导出块里补上：`IconChartBar`（历史入口/表头）、`IconArrowLeft`（历史视图返回，已导出）、`IconClock`（耗时列，已导出）、`IconCalendarStats`（时间列）。其中 `IconArrowLeft`/`IconClock` 已存在，只需新增 `IconChartBar` 和 `IconCalendarStats`。

### 2. 新建 `apps/desktop/src/renderer/components/chat/ContextStatsPopover.tsx`
新组件，仿 `ActivityPopover` 的结构：
- props：`snapshot: ContextSnapshot`、`history: TurnUsageRecord[]`、`maxTokens: number`（用于历史行算占比）、`onClose: () => void`。
- 内部 `view` 状态（`"current" | "history"`）。
- **current 视图**：顶部渲染 `<ContextTooltipBody>`（从 ContextRing.tsx 复用，已 export），底部一个「历史详情」按钮行（`IconChartBar` + 文字 + 记录数徽章）。
- **history 视图**：顶部标题栏（返回按钮 + "历史 · N 轮"），中部滚动表格（`max-h-80 overflow-y-auto`）。每行：`#序号` · 相对时间（`endedAt` 用 `Intl.RelativeTimeFormat` 或简单的 `HH:mm`）· 耗时（`durationMs`→`Xs`/`Xm`）· 处理/输出/缓存读/缓存写 token（用 `fmtTokens`）· 累计占用（`usedTokens` + 用 `maxTokens` 算的 `pct%`）· 费用（`$x.xxxx`）· 模型名（truncate，title 全名）。底部汇总行：总处理 / 总输出 / 总费用。
- 空态：`history.length === 0` 时显示占位文案。
- 定位：`absolute bottom-full right-0 mb-1 z-50 w-[380px]`（从圆环上方弹出），`rounded-lg border border-edge bg-surface shadow-2xl`。

### 3. 修改 `apps/desktop/src/renderer/components/chat/ContextRing.tsx`
- 把 `Tooltip.Trigger` 的 `render={<span />}` 改为 `render={<button type="button" />}`，加 `onClick` 切换 `open` 状态。
- 新增 `useState<boolean>(false)` 控制 popover。
- 注意 base-ui Tooltip 与 click 共存：Tooltip 是 hover 触发，button click 打开 popover，两者不冲突（button click 时 tooltip 自然消失）。需要给 button 加 `title` 属性做无障碍提示。
- popover 打开时在 Trigger 外部点击关闭——采用最简方案：popover 容器加一个透明 fixed 全屏 backdrop（`fixed inset-0 z-40`），点击它 `onClose`。比 outside-click 监听简单可靠。
- 把 `snapshot` 通过 prop 透传给新 popover。

### 4. 修改 `apps/desktop/src/renderer/components/chat/ComposerToolbar.tsx`
- 额外从 store 取 `usageHistoryBySession[activeSessionId]`（用 `EMPTY_USAGE` 兜底）。
- 把 history 和 maxTokens 透传给 `ContextRing`，再由 ContextRing 透传给 popover。
- 保持 selector 返回稳定引用（`?? EMPTY_USAGE`）。

### 5. 类型检查
`cd apps/desktop && npx tsc --noEmit -p tsconfig.json`

## 不做的事

- 不引入新的 UI 库依赖（不用 base-ui Popover，复用手写 absolute + backdrop 模式）。
- 不改 `usageHistoryBySession` 的数据结构或 push 逻辑（它已经完备）。
- 不加趋势图/折线图（用户未明确要求，保持首版简洁；表头列已足够直观）。
- 不持久化历史（store 注释明确它是 ephemeral，重启清空，符合设计）。

## 关键风险与缓解

- **base-ui Tooltip + button click 冲突**：base-ui Tooltip 在 trigger 获得焦点/hover 时显示，click 不会锁住 tooltip。若实测 click 后 tooltip 仍残留，加 `onPointerDown` 阻止或用 `Tooltip.Root open={false}` 受控。实现时验证。
- **popover 定位偏移**：圆环在 toolbar 最右侧，popover 用 `right-0` 右对齐、`bottom-full` 向上，与 `EffortDropdown` 的 Menu.Positioner `side="top" align="start"` 风格一致。实测微调 `mb-1`。
- **多 tab 并发**：history 按 sessionId 分桶，ContextRing 只看前台 session，无串扰。