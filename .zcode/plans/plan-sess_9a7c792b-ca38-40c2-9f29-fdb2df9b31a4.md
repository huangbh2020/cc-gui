## 目标

优化中间面板文件编辑器的标签栏(`OpenTabsBar`)在打开大量文件时的体验,移植会话标签栏(`SessionTabs`)的完整交互模型,两者视觉保持一致。

## 改动清单

### 1. `sessionStore.ts` — 新增拖拽排序 action
- 在 `SessionState` 接口中 `setIdeActiveFile` 之后(约 L685)增加:
  `reorderIdeFile: (from: number, to: number) => void;`
- 在实现区 `setIdeActiveFile` 之后(约 L3683)实现,镜像现有 `reorderTab`(越界/同索引 no-op),但作用于当前项目的 `ideOpenFilesByProject[activeProjectId]`,成功后调用 `persistIdeBuckets(get())` 持久化。

### 2. 新建 `components/layout/TabBarChrome.tsx` — 提取共享 tab 栏基础件
从 `SessionTabs` 提取两个纯展示组件(避免两份几乎相同的实现):
- `TabBarChevronButton({ dir, onClick, title })` — 左右翻页箭头
- `TabBarOverflowMenu({ items, activeKey, onSelect, heading })` — base-ui Menu 的溢出菜单,`items` 泛化为 `{ key, label, title?, active, dotClass? }`(dotClass 表达"运行中/未保存"指示点),两种 tab 栏共用

### 3. `SessionTabs.tsx` — 改为复用共享件
删除本地 `ChevronButton` / `OverflowMenu` 及对应 props 接口,改为从 `TabBarChrome` 导入;`findSession` 保留。纯提取、无行为变化。

### 4. `OpenTabsBar.tsx` — 重写,移植 SessionTabs 全部交互
保持现有文件 tab 语义(不引入回归),叠加导航能力:
- 隐藏原生滚动条(`no-scrollbar`)+ ResizeObserver / onScroll 计算 `canScrollLeft/Right`
- 左右 chevron 翻页按钮(仅溢出时显示,共占 20px 内)
- 鼠标滚轮 → 横向滚动;激活 tab 自动 `scrollIntoView`
- 两侧边缘渐隐遮罩(pointer-events-none)
- `⋯` 溢出菜单:溢出时列出所有打开文件快速跳转,未保存文件带 accent 脉冲点(dirty dotClass)
- dnd-kit 拖拽排序(PointerSensor 距离 6px / TouchSensor delay 120,onDragEnd → `reorderIdeFile`)
- 中键点击关闭(未保存文件跳过,与现有"dirty 时不显示关闭按钮"语义一致)
- 保留:basename 截断 + 全路径 title、dirty 脉冲点、hover/active 显示关闭按钮、active 高亮样式(与 SessionTabs 相同的 tab 视觉)

### 5. 验证
- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
- `pnpm dev` 手动验证多文件场景:滚动、拖拽排序、溢出菜单跳转、中键/×关闭、dirty 点、replace/tabs 模式切换无回归

## 不改动
- `SessionTabs.tsx` 行为、`FileEditor.tsx`、`App.tsx`(OpenTabsBar 挂载点不变);无新增依赖。