# 自定义模型设置界面重构:角色绑定表格 + 1M 声明

## 目标(参考图片)

把"扁平 `models[]` 列表 + 可折叠 3 角色 alias 区"重构为**统一的 5 角色绑定表格**。一个配置 = 端点(baseUrl + token + authMode)+ 5 个角色槽。每行:

| 角色 | 显示名称 | 实际请求模型 | 1M |
|------|---------|------------|----|

会话不再"选某个模型名",而是**选某个角色**(Sonnet/Opus/...)。该角色的 `requestModel` 成为 `ANTHROPIC_MODEL`,该角色的 `supports1m` 决定是否传 `betas=['context-1m-2025-08-07']`。

## 关键 SDK 事实(已验证)

- `ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS/FABLE_MODEL` 均在 `claude.exe` 中存在(48–80 次命中),Fable 是一等 tier。
- Subagent 用 `CLAUDE_CODE_SUBAGENT_MODEL`(13 次),不是 `ANTHROPIC_SUBAGENT_MODEL`(0 次)。
- 1M 通过 `options.betas = ['context-1m-2025-08-07']`(`sdk.d.ts:1488`,类型 `SdkBeta`),**没有 env var**。

---

## 改动清单(11 个文件)

### 1. `packages/contracts/src/customModel.ts` — 类型大改

新增类型,删除 `AliasMap`、`defaultModel`、`models`:

```ts
export type CustomModelRoleKey = "haiku" | "sonnet" | "opus" | "fable" | "subagent";

export interface RoleBinding {
  /** 网关侧显示名(下拉框用),如 "pro"。可选。 */
  displayName?: string;
  /** 实际请求模型名,如 "deepseek-v4-pro"。映射到对应 env var。
   *  当会话选此角色时,同时作为 ANTHROPIC_MODEL。 */
  requestModel?: string;
  /** 声明 1M 上下文。选中此角色时传 betas=['context-1m-2025-08-07']。 */
  supports1m?: boolean;
}

export interface RoleBindings {
  haiku?: RoleBinding;
  sonnet?: RoleBinding;
  opus?: RoleBinding;
  fable?: RoleBinding;
  subagent?: RoleBinding;
}

export const CUSTOM_MODEL_ROLES: CustomModelRoleKey[] =
  ["haiku", "sonnet", "opus", "fable", "subagent"];
export const CUSTOM_MODEL_ROLE_LABELS: Record<CustomModelRoleKey, string> = {
  haiku: "Haiku", sonnet: "Sonnet", opus: "Opus", fable: "Fable", subagent: "Subagent",
};
```

更新 `ApiConfig`:删除 `defaultModel`、`models`、`alias`;新增 `roles: RoleBindings`、`selectedRole: CustomModelRoleKey`。`CustomModel` / `CustomModelMeta` / `CustomModelPublic` / `CustomModelInput`:删 `models`、`alias`,加 `roles`。

### 2. `packages/contracts/src/ipc.ts` — Zod schema

- 删 `AliasMapSchema`,加 `RoleBindingSchema`(`displayName/requestModel/supports1m` 均 `.optional()`)和 `RoleBindingsSchema`(5 角色键)。
- `SaveCustomModelSchema`:删 `models`、`alias`,加 `roles: RoleBindingsSchema`。
- `TestCustomModelSchema`:保留 `model`(要探测的 `requestModel`),加 `supports1m: z.boolean().optional()`。`RpcMap` / `IPC` 通道常量不变。

### 3. `apps/desktop/src/main/lib/secretStore.ts` — 迁移 + resolveApiConfig

- 新增 `migrateMeta(meta)`:检测旧格式(有 `models`/`alias` 无 `roles`),合成:
  - `roles.sonnet = { requestModel: models[0] }`(主模型默认放 Sonnet 槽)
  - `roles.{haiku,opus} = alias.{haiku,opus} ? { requestModel } : undefined`
  - `fable/subagent` 留空
- 在 `readMeta()` 返回前 map 一遍 `migrateMeta`。
- `resolveApiConfig(id, selectedRole?: string)`:用 `migrateMeta` 读;`selectedRole` 落到匹配的 role,否则回退第一个有 `requestModel` 的角色。返回 `{ …, roles, selectedRole }`。
- `listPublic()` / `save()` 同步改成读写 `roles`(save 输入已是新格式)。
- 保留 `resolveModels` 仅给 `migrateMeta` 内部用(读旧 `models`)。

### 4. `apps/desktop/src/main/providers/claude-sdk/customEnv.ts` — env 重写

按 `cfg.roles` + `cfg.selectedRole` 构造:
- 主模型 = `roles[selectedRole]?.requestModel` ?? 第一个有 `requestModel` 的角色 → `ANTHROPIC_MODEL`。
- 每个有 `requestModel` 的角色 → 对应 env var(haiku/sonnet/opus/fable → `ANTHROPIC_DEFAULT_<TIER>_MODEL`;subagent → `CLAUDE_CODE_SUBAGENT_MODEL`)。
- 其余字段(baseUrl/auth/遥测/timeout)逻辑不变。

### 5. `apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts` — 注入 betas

`options` 构造处:若 `req.apiConfig` 且 `roles[selectedRole]?.supports1m` → `options.betas = ["context-1m-2025-08-07"]`。`SdkBeta` 类型已存在,直接用。

### 6. `apps/desktop/src/main/ipc/customModel.ts` — probeEndpoint

`probeEndpoint` 把 `input.supports1m` 透传到 `query({ ...options, betas: input.supports1m ? ["context-1m-2025-08-07"] : undefined })`,使"测试连接"与实跑配置一致。

### 7. `apps/desktop/src/main/claude/RuntimeManager.ts` — 调用点

`resolveApiConfig(customModelId, session.model)` 调用处:参数语义从"模型名"变"角色 key"。`session.model` 在自定义路径下存的就是角色 key,无需改 DB schema;首次升级时旧值(`"deepseek-v4-pro"`)不匹配任何角色 → 回退首角色(可接受)。

### 8. `apps/desktop/src/renderer/components/settings/CustomModelsPanel.tsx` — UI 大改

- 列表行摘要改为:`名称 · 主机 · 已配置角色数`(从 `roles` 计算)。
- 表单:`名称/BaseURL/Token+authMode` 区保留。
- 中间放**角色表格**(5 固定行):列 = 角色 / 显示名称(input) / 实际请求模型(input) / 1M(toggle switch) / 单选圆点(选"测试连接"用哪个角色)。
- 高级区(超时/禁遥测)改为可折叠。
- `runTest` 用所选角色的 `requestModel` + `supports1m` 调 `api.customModel.test`。
- 表格样式沿用 `inputCls` / `Field` 与现有 design token(`bg-surface`/`border-edge`/`text-content-*`)。

### 9. `apps/desktop/src/renderer/components/chat/ModelDropdown.tsx` — 选角色而非模型

- `m.models.map(...)` → `CUSTOM_MODEL_ROLES.map(role => m.roles[role]).filter(r => r?.requestModel)`。
- 每条目 label = `cfg.name / {displayName ?? 角色名}`;选择 = `setCustomModel(cfg.id, roleKey)`。
- chip 显示同样映射。

### 10. `apps/desktop/src/renderer/stores/sessionStore.ts` — setCustomModel 语义

`setCustomModel(id, roleKey)`:第二个参数从"模型名"变"角色 key",注释更新。`session.model` 在自定义路径下存角色 key;`model` 字段语义对内置仍是 `"default"|"sonnet"|...`,对自定义是 `CustomModelRoleKey`(集合重叠,不冲突)。

### 11. `docs/tech-stack.md` — 简短说明

加一节"自定义模型角色绑定 + 1M",说明 5 角色→env var 映射、`betas` 注入点、旧配置自动迁移。

---

## 不改动 / 后续

- `claudeTokenUsage.ts` 不动:启用 `betas` 后 SDK 会在 `modelUsage` 报 `contextWindow: 1000000`,现有 `resolveEffectiveContextWindow` 自动消费,上下文环自动正确。`configured?: "1m"` 钩子仍保留未启用(可作为后续"强制声明"开关)。
- `AGENTS.md` 已写"`AliasMap` 3 键",我会一并更新为新模型说明。
- preload 通道不变(`customModel.{list,save,delete,test}` 结构未变)。

## 验收

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 0 error。
2. `pnpm dev`:设置面板显示 5 角色表格,填 DeepSeek 测试通过;选某个角色进会话,日志/上下文环反映 1M(若该角色 supports1m=on)。
3. 旧配置(若有)自动出现在表格里,可编辑保存为新格式。
4. 下拉框按角色分组显示,选中后状态栏 chip 正确。

## 回滚

全部改动集中在这 11 个文件 + contracts 类型。回滚 = `git revert` 单个 commit;旧数据未删,只是下次读时再迁移一次。