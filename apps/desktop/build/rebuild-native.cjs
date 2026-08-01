/**
 * Rebuild native modules for a specific target architecture.
 *
 * WHY THIS EXISTS
 * The old `rebuild:native` script was a flat shell command:
 *   `electron-builder install-app-deps && node build/fix-node-pty-conpty.cjs`
 * `electron-builder install-app-deps` rebuilds for process.arch (the runner's
 * native arch) only. That was fine when CI built a single arch, but now macOS
 * builds split into arm64 and x64 jobs, each on a matching runner. The x64
 * job (macos-13) needs node-pty rebuilt for x64; the arm64 job
 * (macos-latest) for arm64. On a matching runner install-app-deps already
 * targets the right arch, but we also need fix-node-pty-conpty.cjs to pick
 * the right conpty/<arch> binaries - it reads `npm_config_arch`.
 *
 * This script:
 *   1. Reads MCODE_ARCH (set by CI). When unset (local dev), rebuilds for the
 *      host arch - same behavior as before.
 *   2. Sets `npm_config_arch` so downstream tooling (fix-node-pty-conpty.cjs)
 *      resolves the matching arch-specific binaries.
 *   3. Spawns `electron-builder install-app-deps` (with `--arch` when
 *      MCODE_ARCH is set), inheriting stdio so CI logs stream through.
 *   4. Runs fix-node-pty-conpty.cjs (no-op on non-Windows).
 *
 * Run via `pnpm --filter @mcode/desktop rebuild:native`.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const arch = process.env.MCODE_ARCH || process.arch;
const supported = ["arm64", "x64", "arm", "ia32"];
if (!supported.includes(arch)) {
  console.error(`[rebuild-native] unsupported arch: ${arch}`);
  process.exit(1);
}

// Set npm_config_arch so fix-node-pty-conpty.cjs (which reads it) resolves the
// matching conpty/<arch> binaries. Only override when MCODE_ARCH was explicit;
// leaving it unset preserves the old behavior for local dev.
if (process.env.MCODE_ARCH) {
  process.env.npm_config_arch = arch;
}

// electron-builder is on PATH via pnpm/node_modules/.bin. spawnSync resolves
// binaries from the parent's PATH, which pnpm sets up for script execution.
const args = ["install-app-deps"];
if (process.env.MCODE_ARCH) {
  args.push("--arch", arch);
}

console.log(`[rebuild-native] electron-builder ${args.join(" ")} (host=${process.arch}, target=${arch})`);
const result = spawnSync("electron-builder", args, { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
if (result.error) {
  throw result.error;
}

// Run the conpty fixer. require()-ing it executes its top-level code (it's a
// plain script that calls process.exit). Resolve relative to this file so it
// works regardless of cwd.
require(resolve(__dirname, "fix-node-pty-conpty.cjs"));
