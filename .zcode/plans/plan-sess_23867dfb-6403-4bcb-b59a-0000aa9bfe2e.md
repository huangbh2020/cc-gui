# 修复：/compact 压缩后上下文占比不更新

## Bug 根因

`/compact` 执行后，SDK emit `compact_boundary` 系统消息，其中 `compact_metadata.post_tokens` 携带了压缩后的窗口占用。但当前 `handleCompactBoundary()` 只 emit 了 `compact.result` 事件（用于显示压缩卡片），**没有 emit `token-usage.updated` 事件**。

导致三个连锁问题：
1. **前端 ContextRing 不更新** — `compact.result` 在 sessionStore 中只追加 compact-summary block，不更新 `contextSnapshotBySession`
2. **turn 结束时被旧值覆盖** — path C 合并用 `state.lastKnownTokenUsage`（压缩前读数）作为 `usedTokens`
3. **持久化不更新** — `RuntimeManager.emit()` 只在 `token-usage.updated` 时调 `SessionRepo.updateSnapshot()`，重载 session 会 hydrate 到压缩前快照

## 修复方案

在 `handleCompactBoundary` 中，用 `post_tokens` 构建一个压缩后的 `ContextSnapshot`，emit `token-usage.updated` 事件，并更新 `state.lastKnownTokenUsage`。

### 改动 1：`claudeTokenUsage.ts` — 新增 `buildCompactSnapshot` 函数

`normalizeClaudeTokenUsage` 接收的是 raw usage 字段（inputTokens/cacheRead 等），内部计算 `usedTokens = input + cacheCreation + cacheRead`。而 `post_tokens` 是 SDK 已经算好的窗口占用数，语义不同，不能直接复用。新增专用函数：

```typescript
/** Build a post-compaction snapshot from the SDK's `compact_metadata.
 *  post_tokens`. Unlike `normalizeClaudeTokenUsage` (which takes raw usage
 *  fields and computes occupancy), `post_tokens` is already the resolved
 *  window occupancy after compaction — we just clamp it to the ceiling and
 *  recompute pct/warning. Throughput/cost/cache fields are carried over from
 *  `lastKnown` (the pre-compaction snapshot) since compaction doesn't reset
 *  billing counters. */
export function buildCompactSnapshot(opts: {
  postTokens: number;
  lastKnown?: ContextSnapshot;
  model?: string;
}): ContextSnapshot | undefined
```

逻辑：
- `maxTokens` = `lastKnown.maxTokens`（保留窗口上限，永不降级）
- `usedTokens` = `min(postTokens, maxTokens)`
- `pct` / `warning` 重新计算
- `totalProcessedTokens` / `outputTokens` / `cacheReadTokens` / `cacheCreationTokens` / `costUsd` / `model` 从 `lastKnown` 继承（压缩不改计费累计）
- `warnings` 重新计算（用 `decideClaudeContextUsageWarnings`，构造一个 `RawClaudeUsage` 使 `inputTokens = postTokens`）
- `post_tokens` 为 0 或缺失时返回 `undefined`（跳过 emit，避免幽灵快照）

### 改动 2：`SdkMessageAdapter.ts` — `handleCompactBoundary` emit token-usage

在现有 `handleCompactBoundary` 中，emit `compact.result` 之后，追加：

```typescript
// Build a post-compaction snapshot from post_tokens and emit it so the
// context ring / persistence / path-C merge all see the reduced occupancy.
// Without this, the ring stays at the pre-compact value until the next
// assistant response (which may never come if the user just runs /compact).
const snapshot = buildCompactSnapshot({
  postTokens: meta.post_tokens,
  lastKnown: this.state.lastKnownTokenUsage,
  model: this.state.lastKnownTokenUsage?.model,
});
if (snapshot) {
  this.publishTokenUsageSnapshot(snapshot);
}
```

`publishTokenUsageSnapshot` 已做三件事：更新 `lastKnownContextWindow`（永不降级）、更新 `lastKnownTokenUsage`、emit `token-usage.updated`。这样：
- ✅ 前端 ring 立即更新（`contextSnapshotBySession` 被替换）
- ✅ 持久化更新（`RuntimeManager.emit` 拦截 `token-usage.updated` → `SessionRepo.updateSnapshot`）
- ✅ path C 合并正确（`lastKnownTokenUsage` 已是压缩后值）

### 不需要改动的部分

- **runtime.ts 契约** — 不新增事件类型，复用现有 `token-usage.updated`
- **sessionStore.ts** — `token-usage.updated` 的 ingest 逻辑已经正确（替换 snapshot）
- **MessageBlocks.tsx** — compact-summary 卡片渲染不变
- **RuntimeManager.ts** — emit 闭包的持久化分支已经覆盖 `token-usage.updated`

## 验证

```bash
cd apps/desktop && npx tsc --noEmit -p tsconfig.json
```

手动验证：启动应用 → 发几条消息让 ring 升高 → 执行 `/compact` → ring 应立即降到 post_tokens 对应的百分比，压缩卡片正常显示，重载 session 后 ring 保持压缩后值。