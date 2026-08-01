## 修复方案:macOS 打包后弹 Rosetta 的问题

### 根因回顾
CI 在单一 `macos-latest`(arm64) runner 上跑一次,但 `electron-builder.yml` 的 `mac.target.*.arch: [arm64, x64]` 让它同时出两个架构的 DMG/ZIP。由于:
1. `pnpm install` 只在 arm64 runner 上拉取了 `claude-agent-sdk-darwin-arm64` 子包(x64 子包没装),打出的 x64 包里 `claude` 二进制是 arm64 的;
2. `electron-builder install-app-deps` 只按 runner 架构(arm64)重建了 `node-pty`,x64 包里的 `.node` 也是 arm64 的。

Intel Mac 装了 x64 DMG -> spawn 出 arm64 的 `claude`/加载 arm64 的 `node-pty` -> 弹 Rosetta。

### 改动思路(方案 A:拆双 Mac job)
让 arm64 和 x64 各自在**对应架构的 runner** 上完成 install + rebuild + package,这样 pnpm 装对子包、`install-app-deps` 重建对架构。`latest-mac.yml` 同名覆盖的衍生问题用"build job 上传 artifact + publish job 合并"解决。

---

### 改动 1:`apps/desktop/electron-builder.yml` — 去掉 arch 数组

**当前(65-70 行):**
```yaml
mac:
  target:
    - target: dmg
      arch: [arm64, x64]
    - target: zip
      arch: [arm64, x64]
```

**改为:**
```yaml
mac:
  target:
    - target: dmg
    - target: zip
  category: public.app-category.developer-tools
  hardenedRuntime: false
  gatekeeperAssess: false
```

**理由(经源码核查):**
- 不指定 `arch` 时,electron-builder 默认构建 `process.arch`(宿主机架构)。arm64 runner 出 arm64,x64 runner 出 x64,无需任何 CLI 标志。
- 单架构构建下,产物命名安全:arm64 产物恒带 `-arm64` 后缀(`Mcode-0.1.0-arm64.dmg`、`Mcode-0.1.0-arm64-mac.zip`),x64 不带后缀(`Mcode-0.1.0.dmg`、`Mcode-0.1.0-mac.zip`)。两个 job 不会同名冲突。
- 顺带修复本地 `pnpm package` 在 arm64 mac 上错误地同时出 x64 包(内含 arm64 二进制)的隐患。

---

### 改动 2:`apps/desktop/package.json` — `rebuild:native` 接受 `--arch`

**当前(15 行):**
```json
"rebuild:native": "electron-builder install-app-deps && node build/fix-node-pty-conpty.cjs",
```

**改为:**
```json
"rebuild:native": "electron-builder install-app-deps$npm_config_arch_flag && node build/fix-node-pty-conpty.cjs",
```
其中 `$npm_config_arch_flag` 是空字符串(无 `--arch`)或 ` --arch=<arch>`。

**实际实现**:这个写法在跨平台 shell 上不可靠(Windows Git Bash vs macOS bash 对未定义环境变量展开处理不同)。改用更稳妥的方式:**新增一个辅助脚本 `build/rebuild-native.cjs`**,它读 `process.env.MCODE_ARCH`,组装 `electron-builder install-app-deps [--arch=X]` 命令并 spawn,然后跑 `fix-node-pty-conpty.cjs`。`package.json` 改为:
```json
"rebuild:native": "node build/rebuild-native.cjs",
```

`rebuild-native.cjs` 逻辑:
- 读 `process.env.MCODE_ARCH`(CI 传入 `arm64`/`x64`,本地不传 = 跟随宿主)。
- `electron-builder install-app-deps` 的 `--arch` 参数:本地(无 MCODE_ARCH)不传;CI 传 `--arch=arm64` 或 `--arch=x64`。
- spawn 上述命令,继承 stdio。
- 命令成功后 `require("./fix-node-pty-conpty.cjs")`(该脚本已读 `npm_config_arch`,需在调用前设好)。
- 设置 `process.env.npm_config_arch = arch`(若 CI 传了),让 `fix-node-pty-conpty.cjs` 第 48 行的 `process.env["npm_config_arch"]` 拿到正确值。

**`--arch` 参数合法性**:已核查 `install-app-deps` 子命令确实接受 `--arch`(`node_modules/electron-builder/out/cli/install-app-deps.js:30`),与 `build` 命令不同。

---

### 改动 3:`.github/workflows/release.yml` — 拆双 Mac job + 加 publish job

**当前结构:** 单 `release` job,矩阵 `macos-latest` + `windows-2022`,各自构建并直接上传 Release。

**改为三段式:**

#### 3.1 build job(矩阵扩展)
```yaml
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest      # arm64 runner
            platform: mac
            arch: arm64
          - os: macos-13          # Intel runner (GitHub 提供的 x64 镜像)
            platform: mac
            arch: x64
          - os: windows-2022
            platform: win
            arch: x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Setup pnpm
        uses: pnpm/action-setup@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      # setuptools(Mac/Win 都需要,条件不变)
      - name: Install setuptools (distutils shim for node-gyp)
        if: runner.os == 'macOS'
        run: python3 -m pip install --user --break-system-packages setuptools
      - name: Install setuptools (distutils shim for node-gyp)
        if: runner.os == 'Windows'
        run: python -m pip install setuptools
      - name: Setup MSVC dev cmd (Windows)
        if: runner.os == 'Windows'
        uses: ilammy/msvc-dev-cmd@v1
        with:
          arch: x64
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Rebuild native modules
        shell: bash
        env:
          MCODE_ARCH: ${{ matrix.arch }}
        run: pnpm --filter @mcode/desktop rebuild:native
      - name: Set version from tag
        # ... 完全不变 ...
      - name: Build & package
        shell: bash
        env:
          NODE_OPTIONS: --max-old-space-size=4096
        run: pnpm --filter @mcode/desktop package
      # 产物上传为 artifact(publish job 统一处理 Release)
      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-${{ matrix.platform }}-${{ matrix.arch }}
          path: |
            apps/desktop/release/*.dmg
            apps/desktop/release/*.zip
            apps/desktop/release/*.exe
            apps/desktop/release/*.blockmap
            apps/desktop/release/latest*.yml
          if-no-files-found: error
          retention-days: 1
```

**关键点:**
- `macos-13` 是 GitHub 官方提供的 Intel (x64) macOS runner(`macos-latest` 已是 arm64)。两个 Mac job 各自在原生架构上 install + rebuild,装对 `claude-agent-sdk` 子包、重建对 `node-pty`。
- `rebuild:native` 通过 `MCODE_ARCH` 环境变量告诉辅助脚本按指定架构重建。
- **不再在 build job 里上传 GitHub Release**,改为上传 artifact,交给 publish job。
- `permissions: contents: write` 移到 publish job。

#### 3.2 publish job(新增,合并 latest-mac.yml + 上传 Release)
```yaml
  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts
          merge-multiple: false   # 保持各 artifact 独立目录
      - name: Merge latest-mac.yml
        shell: bash
        run: node .github/scripts/merge-mac-update-yml.cjs artifacts release-staging
      - name: Upload release assets
        uses: softprops/action-gh-release@v2
        with:
          files: |
            release-staging/*.dmg
            release-staging/*.zip
            release-staging/*.exe
            release-staging/*.blockmap
            release-staging/latest*.yml
          generate_release_notes: true
          fail_on_unmatched_files: false
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

#### 3.3 新增合并脚本:`.github/scripts/merge-mac-update-yml.cjs`

读取 `artifacts/build-mac-arm64/latest-mac.yml` 和 `artifacts/build-mac-x64/latest-mac.yml`,合并 `files` 数组(arm64 条目 url 含 `-arm64-mac.zip`,x64 条目 url 为 `-mac.zip`),写出到 `release-staging/latest-mac.yml`。同时把所有 dmg/zip/exe/blockmap/latest.yml 拷到 `release-staging/`。

**合并后的 `latest-mac.yml` 形态(经源码核查 electron-updater 行为确认有效):**
```yaml
version: 0.1.4
files:
  - url: Mcode-0.1.0-arm64-mac.zip   # 来自 arm64 job
    sha512: <arm64 hash>
  - url: Mcode-0.1.0-mac.zip          # 来自 x64 job
    sha512: <x64 hash>
path: Mcode-0.1.0-mac.zip
sha512: <x64 hash>
releaseDate: '...'
```

**为什么这对 electron-updater 有效(已核查源码):**
- `Provider.getChannelFilePrefix()`(Provider.js:30-38):Mac 恒读 `latest-mac.yml`,与架构无关。两架构都查同一个文件。✅
- `findFile()`(Provider.js:74-90):从 `files` 数组里优先选 `url.includes(process.arch)` 的条目。
  - arm64 机器:`Mcode-0.1.0-arm64-mac.zip` 含 `arm64` -> 选中。✅
  - x64 机器:两个 url 都不含 `x64` 字面量 -> 回退 `shift()` 取第一个 -> 选 `Mcode-0.1.0-arm64-mac.zip`?❌

**这里有坑,需要处理**:x64 机器上 `findFile` 的 `process.arch` = `"x64"`,两个 url 都不含 `"x64"`,会 fallback 到 `filteredFiles.shift()`(数组第一个)。所以**合并时必须把 x64 条目放第一个**,arm64 放第二个。我会在合并脚本里按"url 不含 arm64 的排前"排序,确保 x64 条目在 `shift()` 时被选中。

> 这也呼应了 electron-builder 自己 `writeUpdateInfoFiles` 的做法:它把 `.zip` 排前,因为 x64 是默认架构。我们合并时复用同样语义。

---

### 改动文件清单
| 文件 | 操作 |
|------|------|
| `apps/desktop/electron-builder.yml` | 改:去掉 `mac.target.*.arch` 数组 |
| `apps/desktop/package.json` | 改:`rebuild:native` 指向新脚本 |
| `apps/desktop/build/rebuild-native.cjs` | 新增:按 `MCODE_ARCH` 组装 install-app-deps + 调 fix-conpty |
| `.github/workflows/release.yml` | 改:拆 build/publish 双 job,矩阵加 macos-13 |
| `.github/scripts/merge-mac-update-yml.cjs` | 新增:合并双架构 latest-mac.yml(x64 条目排前)|

### 不改动
- `updater.ts` / electron-updater 使用方式:经核查,运行时按架构自动匹配 `latest-mac.yml` 的 `files` 条目,代码无需动。
- `fix-node-pty-conpty.cjs`:已支持 `npm_config_arch`,只是 CI 之前没传。新脚本会设好。
- Windows 流程:不变,矩阵里仍是一个 x64 条目。

### 验证方式
1. **本地 typecheck**:`cd apps/desktop && npx tsc --noEmit -p tsconfig.json`(改了 package.json 脚本,无 TS 影响,但跑一遍确认)。
2. **本地单架构打包验证**:`cd apps/desktop && pnpm package`,确认只出一个架构的产物(本机 arm64 -> 只出 `Mcode-0.1.0-arm64.dmg` + `Mcode-0.1.0-arm64-mac.zip`,不再出 x64)。
3. **YAML 语法校验**:对 release.yml 做 `yamllint` 或用 `actionlint`。
4. **合并脚本单测**:本地造两份假 `latest-mac.yml`,跑合并脚本,确认输出 x64 在前。
5. **CI 实跑**:推一个 `v0.1.5-rc1` 测试 tag,确认 Release 上有 arm64 + x64 两套 dmg/zip,且 `latest-mac.yml` 含两个 files 条目、x64 在前。

### 风险与回滚
- 风险:`macos-13` runner 若 GitHub 后续下线(Intel Mac runner 逐步退场是趋势),x64 构建会失败。届时可切回单 runner + `--arch x64` 跨架构构建方案(配合 `npm_config_arch` 让 pnpm 装 x64 子包),但那是后续的事。
- 回滚:改动集中在 5 个文件,revert 即可恢复原状。