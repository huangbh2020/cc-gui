# 输入框功能优化:SDK 图标 + 模型选择面板调整

## 涉及文件(5 个)

1. `apps/desktop/src/renderer/components/chat/ModelDropdown.tsx` — 模型选择面板主改
2. `apps/desktop/src/renderer/components/chat/ProviderDropdown.tsx` — SDK 选择框加图标
3. `apps/desktop/src/renderer/stores/sessionStore.ts` — settings 定向打开支持
4. `apps/desktop/src/renderer/components/settings/SettingsPage.tsx` — 消费定向 section
5. `apps/desktop/src/main/providers/pi-sdk/PiAgentSdkProvider.ts` — pi 模型选择后端生效

---

## 需求 1:claude sdk 隐藏内置模型 + "自定义模型"→"模型列表"

**ModelDropdown.tsx:**
- 新增 `isClaude` / `isPi` 标志(沿用现有 `provider?.id === "pi-sdk"` 分支风格)
- **隐藏内置模型区**:claude 时跳过"内置模型" section 渲染(Auto/Sonnet/Opus/Fable 不再显示)
- **重命名 section 标题**:第 144 行 `自定义模型` → `模型列表`(claude 的自定义配置区)
- 保留 chip 标签查找逻辑(数据数组仍在,`model="default"` 时 chip 仍显示 "Auto",只是菜单里不列出)
- 空状态文案微调

> 注:这是产品决策(claude 用户从自己的网关模型列表选择,不关心 Anthropic 别名)。若 claude 未配置任何自定义模型,下拉只显示"添加 / 管理模型"入口,引导用户去配置。

---

## 需求 2:pi sdk 可选配置的模型列表(参考 claude)

**前端(ModelDropdown.tsx):**
- pi 模型仍来自 `piAvailableModels`(已通过 IPC 动态拉取),渲染保持**单选扁平列表**风格(每项 `setCustomModel(null, b.id)`)
- pi 的模型区 section 标题也用 **"模型列表"**(与 claude 统一;原来走"内置模型"分支,现 pi 分支单独标注标题)
- **新增 pi 的"添加 / 管理模型"入口** → 定向打开设置页 `pi-models`(原来 claude 有此入口、pi 没有,现补齐)

**后端(PiAgentSdkProvider.ts)—— 让选择真正生效:**
- 当前 `createAgentSession` 调用未传 `model`,前端 `req.model`("providerId/modelId")被丢弃
- 在 `modelRuntime` 构建后、`createAgentSession` 前,新增解析:
  ```ts
  let resolvedModel;
  if (req.model && req.model !== "default") {
    const slashIdx = req.model.indexOf("/");
    if (slashIdx > 0) {
      resolvedModel = modelRuntime.getModel(
        req.model.slice(0, slashIdx),
        req.model.slice(slashIdx + 1),
      );
    }
  }
  ```
- 传入 `createAgentSession({ ..., ...(resolvedModel ? { model: resolvedModel } : {}) })`
- 安全性:解析失败(getModel 返回 undefined / 无斜杠 / model="default")时回退到 pi 默认行为(当前现状),零风险

---

## 需求 3:SDK 选择框加图标

**ProviderDropdown.tsx:**
- 复用现有 `getProviderIcon(providerId)`(`providerIcon.tsx` 已映射 claude→SiClaude 橙、pi→IconTerminal 紫)
- 触发 chip:`<Icon size={12}>` + 品牌色 + displayName(锁定态也带图标,因 chip 复用)
- 菜单项:每项 `<Icon size={14}>` + 品牌色 + displayName + 选中勾

---

## 贯穿改动:settings 定向打开

**sessionStore.ts:**
- 新增状态 `settingsSection: string | null`(默认 null)
- 扩展签名 `setSettingsOpen: (open: boolean, section?: string) => void`(section 可选,旧调用 `(true)`/`(false)` 不受影响)
- `setSettingsOpen` 实现同时写 `settingsSection`(open=false 时也置 null 复位)

**SettingsPage.tsx:**
- `useState` 初始值改为读 `settingsSection ?? "custom-models"`(组件在 `settingsOpen` 切换时卸载/重挂,每次打开按传入 section 定位)

**ModelDropdown.tsx 管理入口统一:**
- `manageTarget = isClaude ? "custom-models" : isPi ? "pi-models" : null`
- 点击 `setSettingsOpen(true, manageTarget)`

---

## 验证

- `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`(项目约定:改完先 typecheck)
- 手动验证:claude 下拉无内置区、标题为"模型列表";pi 下拉显示模型列表 + 管理入口;切换 pi 模型后实际生效;SDK 选择框与菜单项均带图标;管理入口正确跳到对应设置面板