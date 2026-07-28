## 模型输出内容渲染重构方案

基于 Synara 架构的分析，结合 my-claude-gui 当前实现，提出以下 5 个模块的重构方案。除 LegendList 外，各模块可独立实施、互不依赖。

---

### 📦 模块 1: Shiki 语法高亮

**目标**: 为代码块添加 Shiki 语法高亮，支持懒加载 + LRU 缓存 + 流式内容跳过

**新增文件** (3 个):
1. **`renderer/lib/highlightCache.ts`** — FNV-1a 哈希 + LRU 缓存 (500 条目 / 50MB 上限)
   - `hashKey(code, lang, theme)` → `fnv1a32(code):length:lang:theme`
   - `getCached(key)` / `setCached(key, html)`，跳过流式内容缓存
2. **`renderer/hooks/useHighlighter.ts`** — Shiki highlighter 懒加载
   - 动态 `import('shiki')` + `createHighlighter({ themes: ['github-dark', 'github-light'], langs: [...] })`
   - 返回 `{ highlighter, isReady }`，React 19 `use()` 配合 `<Suspense>`
3. **`renderer/components/chat/CodeHighlight.tsx`** — 代码高亮组件
   - 接收 `code`, `language`, `isStreaming` props
   - 流式内容直接渲染 `<pre>`（跳过缓存和高亮）
   - 非流式: 通过 LRU 缓存查询 → 命中直接 `dangerouslySetInnerHTML` → 未命中调用 Shiki 高亮
   - 包裹 `CodeHighlightErrorBoundary`，高亮失败降级为 `<pre>`

**修改文件** (1 个):
4. **`Markdown.tsx`** — 替换 `pre` 渲染器的 `<code>` 为 `<CodeHighlight>`
   - 保留语言标签 + copy 按钮的 header
   - 代码内容传递给 `<CodeHighlight>` 渲染

**安装依赖**: `shiki` (最新版，当前 ~v3.x)

---

### 📦 模块 2: 平滑流式文本 (useSmoothStreamedText)

**目标**: 流式输出时文本渐进显示而非一次性跳入，自适应节流 + 无障碍支持

**新增文件** (1 个):
1. **`renderer/hooks/useSmoothStreamedText.ts`** — 自适应 rAF 节流
   - **核心算法**:
     ```
     目标速度 = min(2000 chars/s, backlog / 0.16s)
     低通滤波: VELOCITY_LERP = 0.15 (速度变化缓动 ~110ms)
     帧上限: MAX_FRAME_SECONDS = 0.05 (防止切后台回来瞬间吐全部)
     ```
   - **无障碍**: 检测 `window.matchMedia('(prefers-reduced-motion: reduce)')`，启用时直接返回全文
   - **流结束**: `isStreaming=false` 瞬间跳转到完整文本
   - 输入: `fullText: string`, `isStreaming: boolean`
   - 输出: `displayedText: string` (应显示的阶段性文本)

**修改文件** (1 个):
2. **`MessageBlocks.tsx`** — 文本块流式渲染路径
   - 当前: `isStreamingTail` 时直接 `whitespace-pre-wrap` 显示完整文本
   - 改为: 将 `block.text` 传入 `useSmoothStreamedText(block.text, isStreamingTail)`
   - 使用 `displayedText` 渲染，其余不变

---

### 📦 模块 3: useDeferredValue 解析降级

**目标**: 流式输出时 Markdown 渲染不阻塞主线程，使用 `useDeferredValue` 将重解析推迟到空闲帧

**修改文件** (1 个):
1. **`Markdown.tsx`** — 添加 `useDeferredValue`
   - 包裹 `children` 字符串: `const deferredText = useDeferredValue(children)`
   - `ReactMarkdown` 接收 `deferredText` 而非直接 `children`
   - 效果: 流式期间 deferred 值滞后，React 在空闲帧才执行完整 Markdown 解析
   - 流结束后 deferred 值立即收敛，已完成消息瞬间渲染

**注意**: `useDeferredValue` 是 React 18+ 内置 Hook，无需额外依赖。本项目的 React 19 完全支持。

---

### 📦 模块 4: CSS 渲染性能优化

**目标**: 通过 CSS containment 减少布局计算范围，优化滚动性能

**修改文件** (1 个):
1. **`ChatPane.tsx`** — 消息列表容器和行级 CSS
   - 滚动容器添加: `scrollbar-gutter: stable` (防止滚动条出现时内容抖动)
   - 消息行容器添加: `contain: layout` (隔离每行的布局计算)
   - 底部渐变遮罩添加到消息列表尾部
   
具体改动:
- `ChatPaneForSession` 中 `scrollRef` 的 div: 添加 `scrollbar-gutter-stable` CSS class
- `MessageRow` 的 `div.group`: 添加 `contain-layout` class
- 用户气泡区域: 已有 contain 类可复用

---

### 📦 模块 5: LegendList 虚拟列表 + 结构共享

**目标**: 引入 `@legendapp/list` v3 虚拟列表，替代当前的全量渲染；通过 `useStableRows` 实现结构共享避免无效重渲染

**新增文件** (2 个):
1. **`renderer/hooks/useStableRows.ts`** — 结构共享 Hook
   - 维护 `Map<string, RenderItem>` 缓存
   - `isItemUnchanged()` 深度比较: `msg.blocks` 引用 + `turnMeta` + `isStreamingTail`
   - 未变化行复用对象引用 → LegendList `extraData` 不变 → 不重渲染

**修改文件** (1 个):
2. **`ChatPane.tsx`** — 替换滚动容器为 LegendList
   - 当前: `<div ref={scrollRef} className="overflow-y-auto">` 内 `{renderItems.map(...)}`
   - 改为: `<LegendList
       data={stableRenderItems}
       renderItem={renderRow}
       estimatedItemSize={80}
       keyExtractor={(item) => getItemKey(item)}
       maintainScrollAtEnd={followLiveOutput}
       maintainVisibleContentPosition
     />`
   - `estimatedItemSize=80` (平均每条消息高度)
   - 将 `renderItems.map(...)` 逻辑提取为 `renderRow({ item })` 函数
   - 保留跳到底部按钮（通过 `useStore` 监听位置）
   - 使用 `useStableRows(renderItems)` 获取稳定引用
   - `followLiveOutput`: 当用户在底部 10% 内时自动跟随
   - 移除原生的 `useEffect` 手动滚动管理（LegendList 接管）

**安装依赖**: `@legendapp/list` (v3.0.0-beta.44)

---

### 📋 实施顺序

```
第 1 步: 安装依赖 (shiki, @legendapp/list)
    ↓
第 2 步: 模块 4 - CSS 优化 (无风险，纯 CSS)
    ↓
第 3 步: 模块 3 - useDeferredValue (单文件修改，低风险)
    ↓
第 4 步: 模块 1 - Shiki 语法高亮 (新增文件 + 修改 Markdown.tsx)
    ↓
第 5 步: 模块 2 - 平滑流式文本 (新增 Hook + 修改 MessageBlocks.tsx)
    ↓
第 6 步: 模块 5 - LegendList 虚拟列表 (核心架构变更)
```

后 4 步相互独立，可按任意顺序实施。LegendList 放在最后是因为它涉及最大范围的重构。

### ⚠️ 风险点

| 风险 | 缓解措施 |
|------|---------|
| Shiki 在 Electron renderer 中加载失败 | CodeHighlightErrorBoundary 降级为 `<pre>`，不影响可用性 |
| Shiki bundle 体积 | 动态 `import()` 懒加载，首次用到时才下载 |
| 平滑流式文本在长文本中延迟累积 | 帧上限 `MAX_FRAME_SECONDS=0.05` 防止 backlog 突增 |
| LegendList 滚动行为差异 | `maintainVisibleContentPosition` + `maintainScrollAtEnd` 配置 |
| LegendList 测量不准确 | `estimatedItemSize=80`，LegendList 会自适应调整 |

### 🔄 回退策略

每个模块修改独立提交，可通过 `git revert <commit>` 单独回退。LegendList 前置提交便于回滚。