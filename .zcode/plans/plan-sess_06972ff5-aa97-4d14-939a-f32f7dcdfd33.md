# 修复:切换 SDK 时输入框模型名不同步

## 问题根因

切换 SDK(`ProviderDropdown` → `setProvider`)时,**只更新 `providerId`,完全不重置 `model` / `customModelId`**(`sessionStore.ts:4457`)。由于 model id 是 per-provider 的命名空间(claude 用 alias/role key 如 `"sonnet"`,pi 用 `"openai/gpt-4o"` 形式),残留的旧值会导致两个方向的显示 bug:

1. **Claude → Pi**:claude 下选的自定义端点(`customModelId="xxx"`, `model="sonnet"`)切到 pi 后仍在,`ModelDropdown` 的 `chipLabel`(`ModelDropdown.tsx:72-81`)走 `activeCustom` 分支,显示一个 pi 用不了的 claude 端点名。
2. **Pi → Claude**:pi 下选的 `model="openai/gpt-4o"` 切到 claude 后,`builtinModels.find()` 找不到,`chipLabel = builtin?.label ?? model` 直接把原始字符串 `"openai/gpt-4o"` 显示在 chip 上。

## 修复方案(两道保险)

### 改动 1:`setProvider` 切换 SDK 时重置 model 选择

**文件**:`apps/desktop/src/renderer/stores/sessionStore.ts`(`setProvider` action,约 4457 行)

当目标 provider 与当前不同时:
- 重置 store:`set({ providerId: id, model: "default", customModelId: null })`——同时覆盖 "next-session slot"(新建线程继承)和当前显示。
- 对空会话 persist 时,一并写入 `model: "default"` 和 `customModelId: null`(非空会话 `ProviderDropdown` 已隐藏,走不到这里)。

切换到同一个 provider(`prev === id`)时不触发重置,保持原行为。

### 改动 2:`ModelDropdown` 的 `chipLabel` 按当前 provider 的模型面正确计算

**文件**:`apps/desktop/src/renderer/components/chat/ModelDropdown.tsx`(约 72-81 行)

三处调整,即便持久化层有脏数据也能兜底:

1. **`activeCustom` 只在 `supportsCustomEndpoint` 时查找**:避免 pi 下因 `customModelId` 残留误走 claude 自定义端点分支。
2. **增加 `piModel` 查找**:pi 下按 `piAvailableModels` 解析选中模型的 label(与下拉列表一致)。
3. **兜底从 `?? model` 改为 `?? "默认"`**:model id 在当前 provider 的任何已知列表里都找不到时,显示友好中文兜底,而非原始字符串。

修复后各场景:
| provider | model 值 | chipLabel |
|---|---|---|
| claude | `"default"` | `"Auto"`(走 `builtinModels[0].label`) |
| claude | 自定义端点 role | 端点 display 名 |
| pi | `"default"`(切换后重置值) | `"默认"` |
| pi | `"openai/gpt-4o"` | pi 模型 label |
| 任意 | 脏数据残留 | `"默认"` |

## 验证

```bash
cd apps/desktop && npx tsc --noEmit -p tsconfig.json
```

类型检查通过即完成。改动是纯逻辑修复,无新增依赖、无 IPC schema 变更(`updateSettings` 已支持 `model` + `customModelId` 字段)。