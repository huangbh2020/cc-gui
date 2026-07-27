## 根因回顾

DeepSeek 的 Anthropic 兼容端点用**模型名后缀 `[1M]`** 声明 1M 上下文（如 `deepseek-v4-pro[1M]`），**不认** Anthropic 原生的 `anthropic-beta: context-1m-2025-08-07` header。当前代码（`ClaudeAgentSdkProvider.ts:97-100`）在 role 勾选 `supports1m` 时设置 `options.betas = ["context-1m-2025-08-07"]`，DeepSeek 网关收到这个 header 后无法路由到正确渠道，返回含糊的 "It may not exist or you may not have access to it"。

另外，DeepSeek 约定需要的 `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME` 环境变量，`buildCustomEnv` 完全没有设置。

## 修改方案（模型名后缀路线）

### 1. `apps/desktop/src/main/providers/claude-sdk/customEnv.ts`
**新增一个工具函数 `with1MSuffix(model, supports1m)`**：当 `supports1m` 为 true 时，给 model 追加 `[1M]` 后缀（若已有则不重复追加）。

**在 `buildCustomEnv` 里**：
- 计算 selected role 的 `supports1m`（注意：1M 只对**选中 role** 生效，不是所有 role——参考你能用的配置，只有 sonnet 那行带 `[1M]`）
- 选中 role 的 requestModel 在写入对应 `ROLE_ENV_VAR` 和 `ANTHROPIC_MODEL` 时，按 `supports1m` 决定是否加后缀
- 其他 role 不加后缀
- **新增 `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME`**：当 sonnet 被绑定且是 selected role 时，设为不带后缀的 requestModel（这是 DeepSeek 的私有约定变量，记录 sonnet 的"逻辑名"）

具体改动的关键点（customEnv.ts:96-123 区域）：
```ts
// 选中 role 的 supports1m 决定是否加 [1M] 后缀
const selectedBinding = cfg.roles[cfg.selectedRole];
const selectedSupports1m = Boolean(selectedBinding?.supports1m);

for (const key of CUSTOM_MODEL_ROLES) {
  const binding = cfg.roles[key];
  const rawModel = binding?.requestModel?.trim() || fallbackModel;
  if (!rawModel) continue;
  // 仅当此 role 是 selected role 且声明了 1M 时才加后缀
  const isSelected = key === cfg.selectedRole;
  const use1m = isSelected && selectedSupports1m;
  env[ROLE_ENV_VAR[key]] = use1m ? with1MSuffix(rawModel) : rawModel;
}

// 新增：DeepSeek 私有约定。当 sonnet 是 selected role 且带 1M 时,
// 用未加后缀的名字填 ANTHROPIC_DEFAULT_SONNET_MODEL_NAME。
if (cfg.selectedRole === "sonnet") {
  const sonnetModel = cfg.roles.sonnet?.requestModel?.trim() || fallbackModel;
  if (sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = sonnetModel;
}

// ANTHROPIC_MODEL 也要带后缀(若 selected role 声明 1M)
const mainModel = resolveMainModel(cfg);
if (mainModel) env.ANTHROPIC_MODEL = selectedSupports1m ? with1MSuffix(mainModel) : mainModel;
```

`with1MSuffix` 实现：
```ts
function with1MSuffix(model: string): string {
  return model.endsWith("[1M]") ? model : `${model}[1M]`;
}
```

### 2. `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts`
**删除设置 `options.betas` 的逻辑（97-100 行）**。1M 现在完全由 env（模型名后缀）表达，不再走 SDK 的 betas 选项。

注意：`buildCustomEnv` 的入参 `cfg` 已经包含完整的 roles + selectedRole 信息，所以函数内部能自己判断是否加后缀，不需要从 provider 传额外参数。

### 3. `apps/desktop/src/main/ipc/customModel.ts`
**`probeEndpoint` 函数**：当前测试连接时也设置了 `betas: supports1m ? [...] : undefined`（98-99 行），并且 `model: cfg.roles[cfg.selectedRole]?.requestModel`。需要改成：
- 不再传 `betas`
- `model` 改为 `with1MSuffix(requestModel, supports1m)` 形式（从 customEnv 导入 `with1MSuffix`）

这样测试连接和实际对话行为完全一致。

### 4. UI 提示文案更新（`apps/desktop/src/renderer/components/settings/CustomModelsPanel.tsx`）
**`CustomModelsPanel.tsx:392-395`** 的说明文字目前写的是"声明 1M 后,选中该角色时会带 1M 上下文 beta"，需要改成"声明 1M 后,选中该角色时会在模型名后追加 `[1M]` 后缀(适配 DeepSeek 等网关)"。

`roleHint` 函数（540-553 行）的 placeholder 也可以更新一下，sonnet 的提示加上 `[1M]` 示例。

### 5. 诊断日志（已在上一轮加好）
`ClaudeAgentSdkProvider.ts` 已经在上一轮加了 `claude custom env: ...` 的诊断日志，这次改动后日志会自动反映新的 env 状态（包括 `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME` 和带 `[1M]` 后缀的模型名）。**这条日志保留**，作为后续排查的常驻诊断。

## 用户侧操作（代码改完后）

改完代码 + 重启后，用户**不需要重新填配置**，只需要：
1. 在设置里编辑这个 "ds" 配置，**修正 role 绑定**（haiku→flash、sonnet→pro 勾1M、opus→pro、fable 留空）
2. **改认证方式**为 `auth_token`（Bearer），不是 `api_key`
3. 在 ModelDropdown 选 sonnet role 发起对话

## 不在本次范围

- 不动 contract 的 `RoleBinding` 类型（`supports1m` 字段语义不变，只是实现方式从 beta header 换成模型名后缀）
- 不动 zod schema
- 不动 sessionStore
- 不做"1M 实现方式"的多选开关（用户已明确选择"改用模型名后缀"路线）

## 验证方式

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 必须通过
2. 重启 dev，用修正后的配置发起对话，观察新的诊断日志：
   - `ANTHROPIC_MODEL` 应为 `deepseek-v4-pro[1M]`（选中 sonnet+1M 时）
   - `ANTHROPIC_DEFAULT_SONNET_MODEL` 应为 `deepseek-v4-pro[1M]`
   - `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME` 应为 `deepseek-v4-pro`
   - `betas` 应为 `null`
3. 对话能正常返回内容，不再报 "It may not exist"