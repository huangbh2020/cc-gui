# 新增「自动生成线程名称」功能

## 需求回顾
在设置页新增「线程名称生成」配置(开关 + 生成模型选择)。开关关闭时不执行;开启时,用户发送**第一条消息**后,后台自动调用 LLM 生成简短标题,覆盖默认标题。

## 设计决策(基于代码库现有模式)
- **触发点**:主进程 `CLAUDE_SEND_TURN` handler 的「首条消息」分支(`session.title === "New session"`)。保留现有「前 40 字符截断」作即时占位标题,同时 **fire-and-forget**(`void`,不 await)发起后台 LLM 生成,成功后覆盖标题并推送刷新。这样:① 不阻塞 turn 启动;② 即便 LLM 失败/超时,也有占位标题兜底。
- **一次性 LLM 调用**:照搬 `git.ts:generateCommitMessage` 的 `query()` 调用块(60s 超时、`maxTurns:1`、收集 assistant text、strip code fence),复用 `resolveModelForGitOp` / `buildCustomEnv` / `resolveSdkBinaryPath`。
- **设置持久化**:仿 `UI_COMMIT_GEN_MODEL_SETTING_KEY` 模式,新增两个 setting key + zod schema。
- **标题刷新通知**:新增轻量推送通道 `session:titleUpdated`(仿 `theme:changed`),renderer 收到后复用 `renameSession` 同款的列表 patch 逻辑更新标题。
- **UI**:设置页左侧导航新增「线程名称」项,新建 `TitleGenPanel.tsx`(仿 GitPanel commit-gen 卡片:一行开关 + 一行模型选择)。
- **标题文案**:统一中文简短标题(与项目整体中文风格一致),不暴露自定义提示词(保持设置简洁)。

---

## 实现步骤

### 1. IPC 契约层 `packages/contracts/src/ipc.ts`
新增(紧挨 `UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY` 附近,约第 243 行后):
- `UI_TITLE_GEN_ENABLED_SETTING_KEY = "ui.titleGenEnabled"` + `TitleGenEnabledSchema = z.enum(["on","off"])` + `TitleGenEnabled` 类型
- `UI_TITLE_GEN_MODEL_SETTING_KEY = "ui.titleGenModel"`(值 `"configId:roleKey"` 或空,同 commitGenModel)
- 新增推送消息类型 `SessionTitleUpdatedMessage { channel: "session:titleUpdated"; sessionId: string; title: string }`,加入 `MainToRendererMessage` 联合
- 新增通道常量 `SESSION_TITLE_UPDATED: "session:titleUpdated"`

### 2. 主进程 — 标题生成逻辑
**新建 `apps/desktop/src/main/ipc/titleGen.ts`**:
- 导出 `generateSessionTitle(session, firstPrompt): Promise<string | null>`
- 内部:① 读 `SettingRepo.get(UI_TITLE_GEN_ENABLED_SETTING_KEY)`,非 `"on"` 直接返回 null;② 读 `titleGenModel`,解析 `"configId:roleKey"`;③ 照搬 `generateCommitMessage` 的 `query()` 调用块(`resolveModelForGitOp`、`buildCustomEnv`、`resolveSdkBinaryPath`、60s 超时、`maxTurns:1`);④ systemPrompt 固定约束「输出 ≤30 字符中文简短标题,无标点/代码块/前导语」;⑤ 收集 text → strip code fence → 截断 80 字符兜底;⑥ `SessionRepo.updateTitle` 写回;⑦ `sendToRenderer(IPC.SESSION_TITLE_UPDATED, ...)` 通知 renderer。
- 失败仅 `log.warn`,不抛错(后台任务,静默)。

**修改 `apps/desktop/src/main/ipc/claude.ts`** 第 79-85 行:
- 保留现有「前 40 字符截断」即时占位逻辑。
- 在 `await runtimeManager.sendTurn(...)` **之后**、`return` **之前**,新增:
  ```ts
  void generateSessionTitle(updated, input.prompt).catch((err) =>
    log.warn(`title generation failed for ${session.id}: ${(err as Error).message}`),
  );
  ```
  fire-and-forget,不阻塞。
- 注:`generateSessionTitle` 内部自检 enabled,关闭时立即返回,无开销。

### 3. Preload 桥接 `apps/desktop/src/preload/index.ts`
在 `on:` 对象(约第 297 行后)新增:
```ts
sessionTitleUpdated(handler: (msg: Extract<MainToRendererMessage, { channel: "session:titleUpdated" }>) => void): () => void {
  const listener = (_e, msg) => { if (msg.channel === IPC.SESSION_TITLE_UPDATED) handler(msg); };
  ipcRenderer.on(IPC.SESSION_TITLE_UPDATED, listener);
  return () => ipcRenderer.off(IPC.SESSION_TITLE_UPDATED, listener);
}
```

### 4. Renderer store `apps/desktop/src/renderer/stores/sessionStore.ts`
- **字段**(仿 `commitGenModel`,约第 585 行后):`titleGenEnabled: boolean`、`titleGenModel: string | null`
- **初始值**(约第 2093 行):`titleGenEnabled: false`、`titleGenModel: null`
- **setter 类型**(约第 950 行):`setTitleGenEnabled(v: boolean) => void`、`setTitleGenModel(id: string | null) => void`
- **setter 实现**(约第 4938 行后):`setTitleGenEnabled` / `setTitleGenModel`,仿 `setCommitGenModel` —— 本地 `set({...})` + `void api.setting.set({key, value})`。
- **水合**(约第 2344 行 `Promise.all`):新增 `api.setting.get({ key: UI_TITLE_GEN_ENABLED_SETTING_KEY })` 和 `UI_TITLE_GEN_MODEL_SETTING_KEY`,解析后 `set({...})`。
- **订阅推送**:在 `init()` 里 `api.on.sessionTitleUpdated((msg) => {...})`,复用 `renameSession` 同款的 `patchRow` 列表 patch 逻辑(更新 `sessionsByProject` / `archivedSessionsByProject` / `sessions` 三处的行),不调 IPC(标题已落库)。

### 5. 设置面板 UI
**新建 `apps/desktop/src/renderer/components/settings/TitleGenPanel.tsx`**:
- 仿 GitPanel commit-gen 卡片结构。
- 卡片标题「线程名称生成」,说明文案「开启后,在发送第一条消息时后台自动生成简短标题并覆盖默认标题。」
- 第一行 `SettingRow`「自动生成」:开关(复用 base-ui Switch 或简单 `<input type="checkbox">`,参考项目已有开关样式)。关闭时模型选择行灰显/禁用。
- 第二行 `SettingRow`「生成模型」:`<select>` + `modelOptions`(完全复用 GitPanel 第 47-62 行的 `useMemo`,遍历 `customModels` × `CUSTOM_MODEL_ROLES`)。无可用模型时显示提示文案,并说明「未选择则使用内置 Claude 模型」。
- 用 `cn()`、语义 token、`SettingRow`,遵守编码规范。

**修改 `apps/desktop/src/renderer/components/settings/SettingsPage.tsx`**:
- `SectionId` 加 `"title-gen"`(第 35 行)
- `NAV_ITEMS` 加 `{ id: "title-gen", label: "线程名称" }`(第 48 行 git 前)
- import + 条件渲染 `{active === "title-gen" && <TitleGenPanel />}`(第 121 行附近)

### 6. IPC 注册
- `apps/desktop/src/main/ipc/index.ts`:`titleGen.ts` 不注册新 IPC handler(`generateSessionTitle` 是内部函数,由 `claude.ts` 直接调用),故无需改 `registerIpcHandlers`。但需确认 `titleGen.ts` 的 import 被使用。

---

## 验证
- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 全量类型检查通过。
- 手动验证(可选,需运行):① 设置页可见「线程名称」面板;② 关闭开关,新会话首条消息标题仍为「前 40 字符截断」;③ 开启开关 + 选模型,新会话首条消息后标题被 LLM 生成的中文短标题覆盖;④ LLM 失败时标题保持占位不变(兜底)。

## 涉及文件
| 文件 | 改动 |
|------|------|
| `packages/contracts/src/ipc.ts` | +2 setting key/schema、+1 推送消息类型、+1 通道常量 |
| `apps/desktop/src/main/ipc/titleGen.ts` | **新建** — `generateSessionTitle()` |
| `apps/desktop/src/main/ipc/claude.ts` | sendTurn handler 加 fire-and-forget 调用 |
| `apps/desktop/src/preload/index.ts` | +`on.sessionTitleUpdated` |
| `apps/desktop/src/renderer/stores/sessionStore.ts` | +字段/初始值/setter/水合/订阅 |
| `apps/desktop/src/renderer/components/settings/TitleGenPanel.tsx` | **新建** — 设置卡片 |
| `apps/desktop/src/renderer/components/settings/SettingsPage.tsx` | +导航项 +渲染 |

## 不做的事
- 不暴露自定义提示词(保持设置简洁;systemPrompt 内置固定)。
- 不新增 IPC RPC handler(标题生成是主进程内部触发,renderer 不主动调用)。
- 不改 `Session` 类型 / DB schema(复用现有 `title` 列与 `SessionRepo.updateTitle`)。
- 不改 `renameSession`(用户手动改名仍走原路径;AI 生成走独立推送通道)。