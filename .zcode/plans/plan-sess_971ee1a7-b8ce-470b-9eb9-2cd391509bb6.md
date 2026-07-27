## 方案：左侧用户消息时间线

### 设计要点(已与用户确认)
- **圆点垂直对齐到对应消息行**:圆点与该条用户消息处于同一水平高度。
- **hover 显示带样式卡片**:顶部时间 + 下方消息正文(长内容可滚动)。

### 核心实现思路

圆点对齐到消息行最可靠的做法是——**让时间线圆点和消息列表共用同一个滚动容器**,圆点作为消息列表的兄弟 DOM,这样圆点天然随消息滚动,不需要任何 scroll-sync / 位置映射计算。用户向上下滚动时圆点自动跟着走,且因为时间线和消息共享布局,圆点的 `top` 始终等于对应消息行的 `top`。

### 改动文件

**1. 新建 `apps/desktop/src/renderer/components/chat/MessageTimeline.tsx`**(核心组件)
- 渲染一条左侧竖线 + 每条用户消息一个圆点。
- 接收 `messages: ChatMessage[]`,过滤出 `role === "user"` 的消息。
- 每个圆点 hover 显示卡片:时间(`fmtClock`)+ 消息正文(`blocksToText`)。
- 使用手写浮层(参考现有 `TagPopover` / `ActivityPopover` 的 absolute 定位 + outside-click/ESC 关闭模式)。
- 卡片定位在圆点右侧(`left-full ml-2`),避免遮挡消息内容。
- 卡片正文超过一定高度时内部滚动(`max-h-60 overflow-y-auto`)。
- 圆点用原生 `<span className="rounded-full bg-...">` (与 `StatusCapsule` 中 `h-1.5 w-1.5 rounded-full bg-warning` 的点保持一致风格),hover 时高亮放大。

**2. 修改 `apps/desktop/src/renderer/components/chat/ChatPane.tsx`**
- 在消息列表容器(`mx-auto max-w-5xl space-y-5 pt-6`,约 line 378)外层增加一个 `relative` 的 wrapper,把时间线作为绝对定位的左侧栏放进去,让两者共享同一滚动上下文。

具体结构调整(在消息列表外层包裹):
```tsx
// 滚动容器内
<div className="relative mx-auto max-w-5xl pt-6">   ← 新增 relative wrapper
  <MessageTimeline messages={messages} />           ← 左侧绝对定位时间线
  <div className="space-y-5">                        ← 原消息列表(去掉 mx-auto,移到外层)
    {messages.map(...)}
  </div>
</div>
```
- `MessageTimeline` 内部用 `absolute left-0 top-0 bottom-0 w-6` 占据左侧 24px 宽度。
- **关键:圆点定位到对应消息行**。实现方式——给每个用户消息渲染时,在消息行的 DOM 内部(或通过 `data-` 属性 + ref map)记录其相对偏移。最简单可靠的做法:圆点也走 `space-y-5` 相同的流式布局——即时间线内部维护一个与消息列表结构平行的"占位结构",每条用户消息对应一个圆点项,圆点项的高度 = 它在真实消息列表中对应消息之前的所有消息高度之和。

**更简洁可靠的替代定位方案**(采用):既然圆点要对齐用户消息,而用户消息在列表中是按 `space-y-5` 顺序排列的,我让**时间线内部遍历所有 messages(包括 assistant),但只为 user 消息渲染圆点**,其余消息渲染一个等高的"透明占位"。但等高占位无法准确还原 assistant 消息的真实高度(可能含 thinking、tool_use 等可变内容)。

**因此采用 ref 测量法**(最准确):
- 在消息列表渲染时,为每条**用户消息**的行 `div` 挂一个 `ref`,存入一个 `Map<messageId, HTMLElement>`。
- 用 `ResizeObserver` + scroll 容器的 scroll 监听,周期性读取每个用户消息行的 `offsetTop`,把圆点的 `top` 设为相同的 `offsetTop`。
- 时间线圆点容器 `absolute left-0 top-0`,每个圆点 `position: absolute; top: {offsetTop}px`,完美对齐。

这是工业标准做法(VS Code minimap、Cursor 时间线都类似),对齐精度最高,且能应对消息高度任意变化(流式输出时 assistant 消息不断增高,圆点跟着下移)。

**测量触发时机**(复用现有 `updateJumpState` 的 scroll listener 模式):
- 滚动时(虽然 absolute 元素随滚动容器自然滚动,但测量 offsetTop 仍是相对滚动内容,无需 scroll 时重算——`offsetTop` 是相对 offsetParent 的静态布局值,只有布局变化时才变)。
- 实际只需在 `messages` 变化、以及用 `ResizeObserver` 监听消息列表容器尺寸变化时重新测量。
- 流式输出期间用 `requestAnimationFrame` 节流,避免高频测量。

### 复用现有代码
- `fmtClock(ms)`(ChatPane.tsx line 48)——格式化时间。需从 ChatPane 导出,或在时间线组件内复制(函数很小,倾向复制以避免改动 ChatPane 的导出接口)。
- `blocksToText(blocks)`(ChatPane.tsx line 626)——提取消息正文。同样复制到时间线组件或提取到 `lib/`。
- 浮层 outside-click/ESC 关闭模式——参考 `TagPopover.tsx` line 29-49。
- 圆点样式——参考 `StatusCapsule.tsx` 的 `h-1.5 w-1.5 rounded-full bg-warning`。
- 卡片样式——参考 `ActivityPopover.tsx`(rounded-xl、border、bg-surface/95、shadow、backdrop-blur)。

### 视觉细节
- 时间线竖线:1px 宽,`bg-edge`,位于左侧 24px 栏的中央。
- 圆点:`h-2 w-2 rounded-full bg-info`,hover 时 `bg-info` 变亮 + 放大到 `h-2.5 w-2.5`。
- 竖线左侧给消息列表留出 padding(消息列表 `pl-7` 或外层 padding-left),避免内容与时间线重叠。
- 空会话(无消息)时时间线不渲染。
- 卡片宽度 `w-72`,时间用 `text-content-subtle text-[11px]`,正文 `text-sm text-content`。

### 不在本次范围
- 时间线滚动同步面板(独立 minimap 式滚动条)——用户已确认是"圆点对齐消息行",不需要。
- 点击圆点跳转到消息——本次不做(hover 已满足需求);若后续需要可加。
- 时间标尺刻度(每条线标注具体时间)——卡片 hover 已展示时间,竖线保持纯净。

### 风险与验证
- **流式输出时圆点抖动**:`ResizeObserver` + `requestAnimationFrame` 节流;若仍抖动可降级为仅在 `messages` 数组长度变化时重算(用户消息只在发送时新增,流式只改 assistant)。
- **长会话性能**:用户消息通常远少于 assistant 消息,Map 只存 user 行,测量成本低。
- **typecheck**:实现后跑 `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`。