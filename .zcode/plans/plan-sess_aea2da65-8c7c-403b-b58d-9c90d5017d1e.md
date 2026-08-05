## Mac 端自动更新失效修复方案

### 根因回顾
macOS 上 electron-updater 的 `quitAndInstall` 依赖 Squirrel.Mac 执行替换安装，Squirrel.Mac 会校验代码签名。本项目用 ad-hoc 签名（`TeamIdentifier=not set`），导致 Squirrel.Mac 静默失败——`ShipIt` 目录为空，app 不退出、不报错，UI 表现为"点击没反应"。Windows 走 NSIS 安装程序，无此问题。

### 改动策略
**macOS + ad-hoc 签名时，放弃 Squirrel.Mac 自动安装，改为引导用户手动下载**（VS Code/Zed 等无 Apple 证书应用的做法）。有 Developer ID 签名时仍走原生 Squirrel 流程，保持向前兼容。

### 改动文件（4 个）

#### 1. `packages/contracts/src/ipc.ts` — 扩展消息类型
- `UpdateDownloadedMessage` 新增可选字段 `manualInstallRequired?: boolean`
- `PersistedUpdateState` 新增可选字段 `manualInstallRequired?: boolean`（持久化，避免重开 app 后丢失）
- 不新增 IPC 通道（复用现有 `update:downloaded`）

#### 2. `apps/desktop/src/main/updater.ts` — 核心逻辑
- 新增 `detectManualInstallRequired(): boolean`：在 macOS 上执行 `codesign -dv` 检查 `TeamIdentifier`，`not set` 返回 true（ad-hoc）；缓存结果避免重复 spawn。非 macOS 返回 false。
- `initUpdater()` 的 `update-downloaded` 监听器：调用 `detectManualInstallRequired()`，结果随 `UpdateDownloadedMessage` 推送给 renderer，并写入持久化快照。
- `quitAndInstall()`：macOS + ad-hoc 时**不调用** `autoUpdater.quitAndInstall()`（注定失败），直接返回（renderer 会改为打开 releases 页面，不依赖此调用）。
- `getPersistedUpdateState()` 透传 `manualInstallRequired` 字段。

#### 3. `apps/desktop/src/renderer/components/settings/AboutPanel.tsx` — UI 适配
- `UpdateState` 的 `downloaded` 变体新增 `manualInstallRequired: boolean`。
- `stateFromPersisted` / 订阅 `updateDownloaded` 时读取该字段。
- `UpdateBanner` 的 `downloaded` 分支：
  - `manualInstallRequired === false`（默认）：维持现有"重启安装"按钮（调用 `quitAndInstall`）。
  - `manualInstallRequired === true`：按钮文案改为"前往下载"，行为改为 `openExternal(RELEASES_URL)`，消息文案改为"v{version} 已下载,需手动安装"。
- 新增 `RELEASES_URL` 常量 = `https://github.com/huangbh2020/mcode/releases/latest`（与现有 `REPO_URL` 同源）。

#### 4. 不改动 `ipc/updater.ts`、`preload/index.ts`
现有 RPC 通道和 preload 桥接完全复用，无需改动。

### 不改动的部分
- Windows 流程完全不变（`detectManualInstallRequired` 在 win32 直接返回 false）
- 未来若接入 Apple Developer ID 签名，无需改代码——`codesign -dv` 会返回真实 TeamIdentifier，自动回到 Squirrel 原生流程
- `electron-builder.yml` 签名配置不变

### 验证方式
1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` 类型检查通过
2. 在本机（arm64 Mac + ad-hoc 签名 app）测试：检查更新 → 下载完成 → banner 显示"前往下载"按钮而非"重启安装"
3. 行为对比：点击"前往下载"在浏览器打开 releases 页面（不再无反应）

### 注意事项
- `codesign -dv` 在非 mac 平台或开发模式下不会被调用（`is.prod` 守卫 + `process.platform === 'darwin'` 双重判断）
- 该检测在 `update-downloaded` 事件触发时执行一次并缓存，不增加每次检查的开销