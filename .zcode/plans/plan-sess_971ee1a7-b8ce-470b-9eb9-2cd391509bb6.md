## 方案:可配置聊天字体大小 + 用户消息背景色

### 设计要点(已与用户确认)
- **字体大小**:设置页用**滑块**控件(12~20px),实时预览。
- **用户消息背景色**:颜色选择器选色相,**透明度固定 10%**(与当前 `bg-info/10` 风格一致)。
- 两个设置都走现有 `displayMode` 的成熟管线(renderer store → `setting.set` IPC → SQLite `settings` 表),**零新增 IPC / 零 DB 迁移**。

### 技术方案:CSS 变量驱动(项目首个运行时 CSS 变量)

这是本项目第一次在运行时写 CSS 变量(此前全是 `styles.css` 静态定义)。用 CSS 变量而非 inline style,因为:
- 字体大小需穿透到 `Markdown.tsx` 的嵌套渲染层,inline style 不便传递;CSS 变量天然继承。
- 背景色要复用 Tailwind 的 `<alpha-value>` 机制(固定 10% 透明度),必须用 `R G B` 三元组格式的变量。

### 改动清单(6 个文件,1 个新文件)

#### 1. `packages/contracts/src/ipc.ts` — 新增两个 setting key 常量
紧跟 `DISPLAY_MODE_SETTING_KEY` 模式:
```ts
export const UI_CHAT_FONT_SIZE_SETTING_KEY = "ui.chatFontSize";       // value: "14" (px,字符串)
export const UI_USER_MSG_COLOR_SETTING_KEY = "ui.userMessageColor";   // value: "124 58 237" (R G B 三元组) 或 "" 表示用默认
```

#### 2. `apps/desktop/src/renderer/styles.css` — 新增 CSS 变量默认值
在 `:root` 和 `.dark` 各加两行(默认值 = 当前效果):
```css
:root {
  /* ...existing... */
  --chat-font-size: 14px;          /* 默认 = text-sm */
  --user-bubble: 124 58 237;       /* 默认 = info 色 (violet-600) */
}
.dark {
  /* ...existing... */
  --chat-font-size: 14px;
  --user-bubble: 167 139 250;      /* dark = info 色 (violet-400) */
}
```
三元组格式(R G B)是关键——让 Tailwind 的 `<alpha-value>` 能合成 `bg-userBubble/10`。

#### 3. `apps/desktop/tailwind.config.js` — 新增 userBubble 颜色 token
```js
colors: {
  /* ...existing... */
  userBubble: "rgb(var(--user-bubble) / <alpha-value>)",
}
```

#### 4. `apps/desktop/src/renderer/stores/sessionStore.ts` — store 字段 + action + init 水合
- 新增字段(默认值):`chatFontSize: number = 14`、`userMessageColor: string | null = null`(null = 用主题默认)。
- 新增 action:`setChatFontSize(px)`、`setUserMessageColor(rgbTriplet | null)`,镜像 `setDisplayMode`(乐观本地更新 + `api.setting.set`)。font size 在 action 内 clamp 到 12~20。
- `init()` 中水合:读 `UI_CHAT_FONT_SIZE_SETTING_KEY` / `UI_USER_MSG_COLOR_SETTING_KEY`,校验后 `set()`。

#### 5. `apps/desktop/src/renderer/lib/appearance.ts` — 新建:运行时应用函数
镜像 `lib/theme.ts` 的 `applyThemeClass()`:
```ts
export function applyChatFontSize(px: number) {
  document.documentElement.style.setProperty("--chat-font-size", `${px}px`);
}
export function applyUserBubbleColor(triplet: string | null) {
  // null = 移除自定义,回退到 styles.css 的 :root/.dark 默认值
  if (triplet) document.documentElement.style.setProperty("--user-bubble", triplet);
  else document.documentElement.style.removeProperty("--user-bubble");
}
```
- 在 `MessageTimeline`/`ChatPane` 不需要——改在 **App 根组件**用 `useEffect` 监听 store 变化调用这两个函数(一处生效全局)。

#### 6. `apps/desktop/src/renderer/components/chat/ChatPane.tsx` + `Markdown.tsx` — 替换硬编码类
- ChatPane line 625:`bg-info/10` → `bg-userBubble/10`;`text-sm` → `[font-size:var(--chat-font-size)]`(用 Tailwind 任意值语法读 CSS 变量)。
- ChatPane line 626(assistant):`text-sm` → `[font-size:var(--chat-font-size)]`。
- Markdown.tsx line 132:`text-sm` → `[font-size:var(--chat-font-size)]`(穿透到 markdown 正文)。

#### 7. 新建 `apps/desktop/src/renderer/components/settings/ChatAppearancePanel.tsx` — 设置面板
镜像 `DisplayModePanel.tsx` 结构:
- **字体大小滑块**:`<input type="range" min={12} max={20} step={1}>`,旁边显示当前 `{px}px`;onChange 调 `setChatFontSize` + 本地 pending 状态即时反馈。
- **用户消息背景色**:`<input type="color">`(HTML 原生取色器,输出 `#rrggbb`),需转成 `R G B` 三元组存 store;加一个"恢复默认"按钮(置 null)。
- 接入 `SettingsModal.tsx` 的 `appearance` 区块(在 `DisplayModePanel` 后加第三段)。

### 颜色格式转换细节
- 取色器输出 `#rrggbb`(如 `#7c3aed`)。
- store 里存为三元组字符串 `"124 58 237"`(供 CSS 变量 + alpha 合成)。
- 面板里 `#hex ↔ "R G B"` 双向转换(hex→split→parseInt;RGB→pad→`#`)。

### 验证
- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`。
- `pnpm dev`:设置页拖滑块,聊天区字体实时变;取色器选色,用户消息气泡背景变;切深色模式默认色仍正确(自定义优先于 `.dark` 默认);重启后设置保留。

### 不在本次范围
- 助手消息背景色配置(本次只做用户消息)。
- 字体族(family)配置。
- 每会话独立外观(本次全局)。
