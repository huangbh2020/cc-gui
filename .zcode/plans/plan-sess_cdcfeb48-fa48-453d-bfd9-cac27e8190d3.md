## 数据流输入优化 — 实施计划

### 问题 1：用户展开 Edit 卡片审查时，模型输出会关闭卡片

**根因分析**：有两处机制会导致卡片被关闭：

1. **`TurnPanel` 的自动折叠**（`MessageBlocks.tsx:376-378`）：当 `turn.done` 触发时，`useEffect` 调用 `setOpen(false)` 强制折叠整个 TurnPanel，导致其内部用户已展开的 `EditToolCard` / `WriteToolCard` 被隐藏。

2. **LegendList 的 key 变化导致组件重挂载**（`ChatPane.tsx:1246-1250`）：`keyExtractor` 对 `turnGroup` 使用 `turn:${item.textMsgs[0]?.id ?? item.turnMeta?.startedAt}`。当模型的最终回复文本开始到达（`textMsgs` 从空变为非空），key 从 `turn:12345` 变为 `turn:msgId`，LegendList 会卸载旧组件并挂载新组件，导致 TurnPanel 及其内部 Edit 卡片的展开状态全部丢失。

**修改方案**：

- **a) 移除 TurnPanel 的自动折叠行为**：删除 `MessageBlocks.tsx` 第 376-378 行的 `useEffect`。TurnPanel 的折叠/展开完全由用户手动控制，不再随 turn 结束自动折叠。

- **b) 稳定 turnGroup 的 key**：修改 `ChatPane.tsx` 的 `keyExtractor`，`turnGroup` 始终使用 `turnMeta?.startedAt` 作为 key（该值在整个 turn 生命周期中不变），不再因 `textMsgs` 变化而改变 key。

### 问题 2：去掉 Edit 卡片中点击文件名跳转的功能

**修改方案**：

- **`EditToolCard`**（`MessageBlocks.tsx:734-736`）：将 `<FileLink token={filePath} projectPath={projectPath} />` 替换为纯文本 `<span>`，只显示文件名（使用 `basename` 或直接截取路径末尾）。

- **`WriteToolCard`**（`MessageBlocks.tsx:813-815`）：同上，移除 `<FileLink>`，替换为纯文本文件名显示。

### 问题 3："本轮修改了 x 个文件" 卡片需显示在模型最后输出内容下方

**根因分析**：当前 `upsertLiveTurnFilesBlock`（`sessionStore.ts:1548`）在消息的 blocks 数组中插入 `turn-files` 块时，查找最后一个 `plan` 块并在其后插入。如果 `plan` 块之后还有 `text` 块（可能性较小但存在），`turn-files` 会插入到 text 之前，导致卡片显示在文本上方。

**修改方案**：

- 修改 `upsertLiveTurnFilesBlock` 中的插入位置逻辑：始终将 `turn-files` 块插入到消息 blocks 数组的**最末尾**（`target.blocks.length`），确保它渲染在所有文本内容之后。

### 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `apps/desktop/src/renderer/components/chat/MessageBlocks.tsx` | 删除 TurnPanel 自动折叠 useEffect；移除 EditToolCard/WriteToolCard 中的 FileLink |
| `apps/desktop/src/renderer/components/chat/ChatPane.tsx` | 稳定 turnGroup keyExtractor |
| `apps/desktop/src/renderer/stores/sessionStore.ts` | 修改 upsertLiveTurnFilesBlock 插入位置为末尾 |

### 风险评估

- **低风险**：所有修改都是局部行为调整，不涉及数据流或 IPC 变更
- TurnPanel 折叠行为变更只影响 UI 交互，不影响数据持久化
- key 稳定性变更可能导致 LegendList 在 turn 生命周期内不复用组件，但 turn 数量极少（通常 1 个），不会造成性能问题