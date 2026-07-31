/**
 * Dereference pnpm WORKSPACE symlinks that point outside the app dir.
 *
 * electron-builder's asar packager walks node_modules and follows symlinks.
 * pnpm workspaces symlink the workspace package (e.g. @mcode/contracts)
 * to ../../../../packages/contracts, which resolves OUTSIDE apps/desktop and
 * whose path contains no "node_modules" segment. The packager then throws
 * "path must be under appDir" because the real path neither starts with the app
 * dir nor contains node_modules (the two cases getRelativePath allows).
 *
 * Regular .pnpm symlinks are fine - their paths contain "node_modules", which
 * the packager handles. Only workspace packages (under @mcode/) point
 * outside via a packages/ path, so we dereference ONLY those.
 *
 * This script replaces just the @mcode/* symlinks with real directory
 * copies. It's idempotent and leaves native modules (.pnpm symlinks) intact so
 * @electron/rebuild can still rebuild them.
 *
 * Run from apps/desktop: `node build/dereference-workspace-symlinks.cjs`
 */
"use strict";
const { readdirSync, readlinkSync, rmSync, lstatSync, cpSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const appDir = resolve(__dirname, "..");
const scopedDir = join(appDir, "node_modules", "@mcode");

let count = 0;
let entries;
try {
  entries = readdirSync(scopedDir);
} catch {
  console.log("[dereference] no @mcode scope in node_modules - nothing to do");
  process.exit(0);
}

for (const name of entries) {
  const full = join(scopedDir, name);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    continue;
  }
  if (!st.isSymbolicLink()) continue;

  let target;
  try {
    target = resolve(dirname(full), readlinkSync(full));
  } catch {
    continue;
  }

  // Only dereference if the symlink resolves outside the app dir. Workspace
  // packages point to ../../../../packages/* (outside); regular deps stay put.
  if (!target.startsWith(appDir)) {
    try {
      rmSync(full, { recursive: true, force: true });
      cpSync(target, full, { recursive: true, dereference: true });
      count++;
      console.log(`[dereference] ${name}: ${target} -> real copy`);
    } catch (err) {
      console.warn(`[dereference] ${name}: failed to copy -> ${err.message}`);
    }
  }
}

console.log(`[dereference] replaced ${count} workspace symlink(s) with real copies`);
