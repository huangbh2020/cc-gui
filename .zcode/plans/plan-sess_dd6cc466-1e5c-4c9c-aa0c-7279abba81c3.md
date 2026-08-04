# 浏览器多 Tab 页实现方案

## 核心洞察

**主进程已经完全支持多 view**:`BrowserManager` 是 `Map<string, LiveBrowser>`,每个 view 有独立 browserId,`wcToBrowser` 按 sender 路由 picker IPC,每个 `BrowserEventMessage` 都携带 `browserId`。**单 tab 限制完全在 renderer 端**(`BrowserPanel.tsx` 的单个 `browserIdRef` + 扁平 useState)。

因此本次改动**几乎不碰主进程/契约/preload**--只在 renderer 端把单 tab 状态改为多 tab 状态管理 + 加一条 tab 条 UI。关闭面板时只 hide 所有 view(不销毁),重开时 show 活跃 tab;退出 app 时 `disposeAll` 统一清理。

## 状态模型(renderer)

`BrowserPanel.tsx` 当前用一个 `browserIdRef` + 6 个扁平 useState。改为一个 tabs 数组 + activeId:

```ts
interface BrowserTab {
  id: string;           // renderer 生成的 tab 标识(crypto.randomUUID)
  browserId: string;    // 主进程返回的 view id
  url: string;          // 地址栏文本(受控)
  title: string;        // 页面标题(tab 显示)
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  pickMode: boolean;    // per-tab 拾取模式
}
```

- `tabs: BrowserTab[]`(useState,初始 `[]`)
- `activeTabId: string | null`(useState)
- 派生:`activeTab = tabs.find(t => t.id === activeTabId)`
- `stageRef` / `lastBoundsRef` 保持不变--只有一个 stage,只有活跃 tab 的 view 在屏上

## 改动清单

### 1. `BrowserPanel.tsx`(重写核心逻辑)

**Tab 生命周期:**
- **首次打开面板**:创建第一个 tab(`api.browser.create` -> 拿 browserId -> `loadUrl(about:blank)` -> `show()`)。
- **新建 tab**(`+` 按钮):`create` -> `hide(旧活跃 browserId)` -> `show(新 browserId)` -> 设为活跃 -> `syncBounds()`。新 tab 初始 `about:blank`。
- **切换 tab**(点击 tab 条):`hide(旧活跃)` -> `show(新活跃)` -> `syncBounds()`。注意:切换前如果旧 tab 在拾取模式,先 `setPickMode(false)` 关掉(拾取脚本不跨 tab)。
- **关闭 tab**(✕ / 中键):`api.browser.close(browserId)` -> 从 tabs 移除。如果关的是活跃 tab,切到相邻 tab(前一个或末尾)。如果关的是最后一个 tab,关闭整个面板(`setBrowserPanelOpen(false)`)。
- **关闭面板**(返回主面板 / ✕):`hide(活跃 browserId)`--**不销毁任何 view**,tabs 数组保留。重开时 `show(活跃)` + `syncBounds()`。
- **退出 app**:主进程 `disposeAll` 已有。

**事件路由:**
- 单个 `api.on.browserEvent` 订阅,按 `msg.browserId` 查找对应 tab,更新该 tab 的状态(用 `setTabs(prev => prev.map(t => t.browserId === msg.browserId ? {...t, ...} : t))`)。
- `navigation` -> 更新该 tab 的 url/title/canGoBack/canGoForward
- `loading` -> 更新该 tab 的 loading
- `pickResult` -> `enqueueChatElement(el)` + pickFlash(全局,不 per-tab)
- `crashed` -> 可选:标记该 tab 为崩溃态

**syncBounds:**
- 改为读取 `activeTab?.browserId`,只给活跃 tab 发 bounds(背景 tab 的 view 是 `visible:false`,`setBounds` 自动 no-op)。

**所有 handler 改为操作活跃 tab:**
- `handleNavigate/Back/Forward/Reload/TogglePickMode` 都用 `activeTab.browserId`。
- 地址栏的 `url` / `loading` / `canGoBack` / `canGoForward` / `pickMode` 从 `activeTab` 读取(而非全局 state)。

**面板 open/close effect:**
- `open` true->true 的首次(无 tab):创建首个 tab。
- `open` true->false:`hide(活跃)`。
- `open` false->true:若有 tab,`show(活跃)` + `syncBounds`;若无 tab(不应发生),创建首个。

### 2. `BrowserTabs.tsx`(新建 - tab 条 UI)

镜像 `SessionTabs.tsx` 的视觉模式,但简化(不用 dnd-kit 拖拽排序,初版固定顺序):
- 容器:`flex shrink-0 items-end gap-0.5 border-b border-edge bg-surface/40 px-2 pt-1.5`
- 每个 tab:`group flex max-w-[180px] min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[11px]`,活跃 `border-accent bg-surface text-content`,非活跃 `border-transparent text-content-muted hover:bg-surface-muted/50`。
- tab 内容:loading 时显示 spinner(`IconLoader2 animate-spin`)否则 favicon 占位点;标题 `truncate`;关闭 ✕(`opacity-0 group-hover:opacity-100`,活跃 tab 常显)。
- 末尾 `+` 按钮(`IconPlus`)新建 tab。
- 中键关闭(`onMouseDown button===1`)。
- 可滚动:溢出 `overflow-x-auto no-scrollbar`,初版不加 chevron/overflow 菜单(够用)。

Props:`tabs`、`activeTabId`、`onSelect(id)`、`onClose(id)`、`onNew()`。

### 3. `BrowserToolbar.tsx`(微调)

无结构性改动--它已经是纯展示组件,props 不变(url/loading/canGoBack 等从 `activeTab` 传入)。只是 `BrowserPanel` 传入的值来源从全局 state 改为 `activeTab` 字段。

### 4. 主进程 / 契约 / preload:**零改动**

`BrowserManager` 的 `create/show/hide/close/setBounds/setPickMode` 全部已按 browserId 操作。`show()` 会 `addChildView`(已附加的 view 会移到顶层 z-order,正好是切换 tab 想要的效果)。唯一需验证的点:`show()` 对已 attached 的 view 调 `addChildView` 是否幂等--Electron 文档说"already contains it -> reordered to topmost",正好符合需求。

### 5. `icons.tsx`:确认 `IconPlus` 已导出(已有,line 36 区域)。

## 关键交互细节

1. **切换 tab 时的拾取模式**:切走前若旧 tab 在拾取模式,先 `setPickMode(oldId, false)`;切回时不自动恢复(用户需重新点🎯)。这避免拾取脚本残留在不可见页面。
2. **bounds 同步时机**:tab 切换后(`show` 完成后)`requestAnimationFrame(syncBounds)`,确保新活跃 view 对齐 stage。
3. **关闭最后一个 tab**:直接 `setBrowserPanelOpen(false)`(面板关闭,view 在 `disposeAll` 或下次重开首 tab 时清理)。初版不在关闭最后一个 tab 时销毁 view--让它和面板生命周期一致。实际上更干净的做法:关闭最后一个 tab 时销毁该 view + 关面板。采用:关最后一个 tab -> `close(browserId)` + 移除 tab + 关面板。
4. **地址栏跨 tab**:切换 tab 时地址栏自动显示新活跃 tab 的 url(因为 `url` 从 `activeTab.url` 读取)。
5. **新建 tab 焦点**:新建后地址栏自动聚焦,方便用户立即输入网址。

## 实施步骤

1. 新建 `BrowserTabs.tsx`(tab 条组件)。
2. 重写 `BrowserPanel.tsx` 核心:tabs 数组状态 + activeTabId + 事件路由 + tab 生命周期 + handler 改用 activeTab。
3. 在 `BrowserPanel` 的 JSX 中 toolbar 上方插入 `<BrowserTabs />`。
4. typecheck + build 验证。

## 不做的事(初版范围外)
- Tab 拖拽排序(后续可用 dnd-kit 加,SessionTabs 已有范式)。
- Tab 溢出 chevron / overflow 菜单(初版 `overflow-x-auto` 够用)。
- Tab 持久化到磁盘(关闭 app 即销毁,符合 `disposeAll`)。
- Favicon 加载(用占位点/标题首字替代)。