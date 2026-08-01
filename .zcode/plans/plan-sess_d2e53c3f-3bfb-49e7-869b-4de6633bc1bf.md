# 范围 2 + 4 启动优化方案

## 范围 2:DB 初始化与窗口创建解耦

### 现状
`index.ts` 里 `await initDb()`(第 35 行)阻塞 `initTheme()` / `registerIpcHandlers()` / `createMainWindow()`。窗口必须等 sql.js(6MB asm.js)解析 + DB 文件读取 + migrate 完成才创建。IPC handler 无 DB 就绪守卫(`getDb()` 未就绪时抛错),`init()` 里 `project.list`/`project.sessions` 无 try/catch,所以不能简单地把窗口提前。

### 方案:DB ready promise + handler 守卫 + 窗口提前

**`db.ts` 改动:**
- 新增模块级 `let dbReadyPromise: Promise<void> | null = null;`
- `initDb()` 开头赋值 `dbReadyPromise = (async () => { ...原本的逻辑... })();`,然后 `return dbReadyPromise.then(() => db!)`。这样 `initDb()` 仍返回 `Promise<Database>`(向后兼容),但同时暴露一个可被 await 的 ready promise。
- 新增 `export function awaitDb(): Promise<void> { return dbReadyPromise ?? Promise.resolve(); }`。若 `initDb()` 尚未调用过,返回已 resolve 的 promise(安全降级)。

**`index.ts` 改动:**
- `void initDb();`(不 await)启动 DB 后台初始化。
- `initTheme()` 改为 `void initTheme();`(不 await,见下文)。
- `registerIpcHandlers();`(handler 内部会 `await awaitDb()`,所以注册本身不依赖 DB)
- `createMainWindow();` 立即执行--窗口提前显示,renderer 提前加载 JS。
- 顺序变为:`void initDb()` -> `void initTheme()` -> `registerIpcHandlers()` -> `createMainWindow()` -> `void initUpdater()`。

**`theme.ts` 改动:**
- `initTheme()` 改为 `async function initTheme(): Promise<void>`,开头 `await awaitDb();`(等 DB ready 再读 settings)。
- 窗口先用默认 `nativeTheme`(跟随 OS)创建,`initTheme` 在 DB ready 后设 `themeSource = pref`。仅当用户偏好 ≠ OS 时首帧可能闪一下(可接受)。

**IPC handler 守卫(关键):**
- 不在每个 handler 里加 `await awaitDb()`(太散)。而是在 `ipc/index.ts` 的 `registerIpcHandlers` 里包一层 wrapper:对每个 `ipcMain.handle(channel, handler)`,实际注册 `(evt, raw) => awaitDb().then(() => handler(evt, raw))`。这样所有 DB 相关请求自动排队,不抛错、不中断。
- 具体实现:在 `ipc/index.ts` 加一个辅助 `handleGuarded(ipcMain, channel, handler)`,内部 `ipcMain.handle(channel, async (evt, raw) => { await awaitDb(); return handler(evt, raw); })`。但现有 10 个 `registerXxxHandlers(ipcMain)` 各自内部直接调 `ipcMain.handle`,逐一改 wrapper 工作量大。
- **更简洁的方案**:在 `db.ts` 的 `getDb()` 不变(仍同步抛错),但把 `awaitDb()` 守卫放在**最外层**:在 `index.ts` 里,`registerIpcHandlers()` 之后、`createMainWindow()` 之前,**不额外改 handler**。因为 DB 初始化(几百 ms)大概率在 renderer 加载 JS + React 挂载 + `useEffect` 触发之前就完成了。为防边界情况,在 `init()` 的 `project.list` 和 `project.sessions` 加 try/catch + 重试一次 `await awaitDb()`。
- **最终采用**:双重保护--(a) 主进程 `awaitDb()` 守卫放在 `registerIpcHandlers` 的 wrapper 里(统一拦截,最干净);(b) renderer `init()` 给无 try/catch 的 `project.list`/`project.sessions`/`selectSession` 加 try/catch(防御性)。

  实现上 `ipc/index.ts` 改为:
  ```ts
  import { awaitDb } from "@main/store/db.js";
  // ...
  export function registerIpcHandlers(): void {
    const guarded = (ipc: IpcMain, channel: string, handler: (e: any, r: unknown) => unknown | Promise<unknown>) =>
      ipc.handle(channel, async (e, r) => { await awaitDb(); return handler(e, r); });
    // 但各 registerXxxHandlers 内部自己调 ipcMain.handle,无法统一拦截...
  }
  ```
  问题:各 `registerXxxHandlers(ipcMain)` 内部直接调 `ipcMain.handle`,无法在 `ipc/index.ts` 层面拦截。

  **最终最干净的方案**:改 `ipcMain` 参数为包装过的版本。在 `registerIpcHandlers` 里:
  ```ts
  const wrappedIpc = new Proxy(ipcMain, {
    get(target, prop) {
      if (prop === "handle") {
        return (channel: string, handler: any) =>
          target.handle(channel, async (e: any, r: unknown) => {
            await awaitDb();
            return handler(e, r);
          });
      }
      return (target as any)[prop];
    },
  });
  registerProjectHandlers(wrappedIpc);
  // ... 其余 9 个
  ```
  这样所有 handler 自动获得 `await awaitDb()` 守卫,零侵入。

---

## 范围 4:启动期 IPC 瀑布拆解

### 现状
`init()`(sessionStore.ts:1658)串行 await 链:
1. `await api.claudeHealthCheck()`(:1674) -- spawn claude 二进制,最慢,阻塞后续所有
2. `void reloadCustomModels()`(:1677) -- 已是 fire-and-forget,OK
3. `await setting.get(displayMode)`(:1683) -- 串行,阻塞 appearance
4. `await Promise.all(4× setting.get(appearance))`(:1698) -- 并发,OK
5. `await setting.get(paneWidths)`(:1727) -- 串行,阻塞 ide
6. `await Promise.all(10× setting.get(ide))`(:1752) -- 并发,OK
7. `await setting.get(gitCollapsedRepos)`(:1838) -- 串行
8. `await project.list()`(:1849) -- 串行,阻塞 sessions
9. `await Promise.all(sessions per project)`(:1901) -- 并发,OK
10. `await selectSession()`(:1946) -- 拉历史消息

### 方案:首屏必需 vs 延后拆分

**首屏必需(用户第一眼要看到的):**
- `displayMode`(决定 single/tabs 布局)
- `project.list` + 首个 project 的 `sessions` + `selectSession`(会话列表 + 默认选中)
- appearance 的 `chatFontSize`(避免字体闪)

**可延后到首屏 paint 后(`requestIdleCallback` / `setTimeout 0`):**
- `claudeHealthCheck` -- spawn 二进制,最慢,UI 用占位 `claudeInstalled: null`
- `paneWidths` / `ide` 10 项 / `gitCollapsedRepos` -- 右栏/面板设置,首屏不可见(右栏默认折叠或可后设)
- appearance 的 `rightPanelFontSize` / `userMessageColor` / `accentColor` -- 非 chat 字体的可延后

**改动(`sessionStore.ts` `init()`):**
1. 把 `init()` 拆成 `init()`(首屏必需,精简)+ `initDeferred()`(延后部分)。
2. `init()` 新顺序:
   - `try { displayMode }`(首屏布局)
   - `Promise.all([project.list, chatFontSize])`(并发:会话列表 + 字体)
   - `Promise.all(sessions per project)`(并发拉会话)
   - `selectSession(firstSession)`(默认选中 + 拉历史)
   - 全程不 await healthCheck
3. `init()` 末尾用 `queueMicrotask` 或 `requestIdleCallback` 触发 `initDeferred()`:
   - `claudeHealthCheck`(fire-and-forget,set `claudeInstalled`)
   - `reloadCustomModels()`
   - 其余 `setting.get`(paneWidths / ide / gitCollapsedRepos / appearance 剩余)
   - 这些都在 try/catch 里,失败不影响首屏

4. `healthCheck` fire-and-forget:从 `init()` 关键路径移除,`claudeInstalled` 保持 `null`(UI 显示加载态),healthCheck 完成后 `set({ claudeInstalled })`。用户发消息前 UI 会显示状态。

**`init()` 加防御性 try/catch:**
- 给 `project.list`(:1849)、`project.sessions`(:1901)、`selectSession`(:1946)包 try/catch,失败时 console.error 但不中断 init(显示空状态而非白屏)。

---

## 改动文件清单
| 文件 | 改动 |
|------|------|
| `src/main/store/db.ts` | 加 `dbReadyPromise` + `awaitDb()` |
| `src/main/index.ts` | `void initDb()` / `void initTheme()` / 窗口提前;埋点调整 |
| `src/main/lib/theme.ts` | `initTheme` 改 async,内部 `await awaitDb()` |
| `src/main/ipc/index.ts` | Proxy 包装 `ipcMain.handle`,统一加 `await awaitDb()` 守卫 |
| `src/renderer/stores/sessionStore.ts` | `init()` 拆为首屏必需 + `initDeferred()`(idle 后);healthCheck fire-and-forget;加 try/catch |

## 验证
1. `tsc --noEmit` 通过
2. `electron-vite build` 通过
3. 启动 dev,看 `startup:` 埋点:`createMainWindow returned` 应显著提前(不再等 `initDb done`)
4. 功能验证:首屏会话列表正常显示、healthCheck 在后台完成、右栏设置(ides/paneWidths)延后加载正确、git 面板正常

## 风险
- Proxy 包装 `ipcMain` 是非标准用法,但只拦截 `handle` 方法,其余属性透传,风险低。若担心可改为显式 wrapper 函数。
- `initTheme` 延后可能导致首帧主题闪(用户偏好 ≠ OS 时),可接受。
- `init()` 拆分后时序变化,需验证 `selectSession` 依赖的 `sessionsByProject` 仍在其之前 set(保持原顺序)。
- 开发环境 StrictMode 双调用 `init()` -- 原本就存在,本次不引入新问题(但可顺便加 `initialized` 守卫)。