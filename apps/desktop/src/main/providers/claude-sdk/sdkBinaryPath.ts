/**
 * Resolve the path to the Claude Agent SDK's bundled native binary.
 *
 * WHY THIS EXISTS
 * The SDK locates its native `claude`/`claude.exe` via
 * `createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]")`.
 * In a packaged Electron app that resolves to a path INSIDE `app.asar`.
 * Electron transparently handles `existsSync` on asar-internal paths (returns
 * true), but `child_process.spawn` CANNOT execute an `.exe` that lives inside
 * the asar virtual filesystem - the OS gets handed the asar file path, not a
 * real executable, and the launch fails with:
 *   "Claude Code native binary at ... exists but failed to launch."
 *
 * electron-builder's `asarUnpack` copies matching files to
 * `app.asar.unpacked/...` on disk. Electron's asar integration normally
 * rewrites file APIs to the unpacked path, but that rewrite is NOT applied to
 * the path the SDK hands to `spawn`. So we must do the rewrite ourselves and
 * pass the real on-disk path via `options.pathToClaudeCodeExecutable`.
 *
 * The canonical mapping (per Electron docs) is to replace the `app.asar`
 * segment with `app.asar.unpacked` in the resolved path.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** The platform subpackage suffix the SDK looks for, e.g. "win32-x64".
 *  Mirrors the SDK's own resolution (see its `getDefaultExecutable`/`FU`). */
function platformSuffix(): string {
  return `${process.platform}-${process.arch}`;
}

/** Candidates for the binary filename per platform. */
function binaryNames(): string[] {
  return process.platform === "win32" ? ["claude.exe"] : ["claude"];
}

/** Map an asar-internal path to its on-disk unpacked counterpart. Returns the
 *  original path if it isn't inside an asar. */
function toUnpackedPath(p: string): string {
  return p.includes("app.asar") ? p.replace("app.asar", "app.asar.unpacked") : p;
}

/**
 * Resolve the SDK binary path. In dev, returns null (let the SDK resolve it
 * itself from node_modules). In a packaged app, returns the real on-disk path
 * under `app.asar.unpacked`, or null if it can't be determined (in which case
 * the SDK falls back to its own resolution and we accept the spawn failure).
 */
export function resolveSdkBinaryPath(): string | null {
  // Only intervene in packaged Electron apps. In dev (running via electron-vite
  // with ELECTRON_RENDERER_URL set), the SDK resolves node_modules normally.
  if (!!process.env["ELECTRON_RENDERER_URL"]) return null;

  const suffix = platformSuffix();
  const pkg = `@anthropic-ai/claude-agent-sdk-${suffix}`;
  // Resolve relative to THIS module. createResolve needs a file URL / path;
  // import.meta.url is the ESM-standard way to get the current module's URL.
  const req = createRequire(import.meta.url);

  for (const name of binaryNames()) {
    // Primary path: require.resolve the subpackage (mirrors what the SDK does).
    let resolved: string | null = null;
    try {
      resolved = req.resolve(`${pkg}/${name}`);
    } catch {
      // resolve failed (e.g. node_modules layout differs) - fall through to the
      // resourcesPath-based construction below.
    }

    if (resolved) {
      const unpacked = toUnpackedPath(resolved);
      if (existsSync(unpacked)) return unpacked;
      // Asar path exists (Electron fakes existsSync) but unpacked copy is
      // missing - return the unpacked path anyway so the SDK error is accurate.
      if (existsSync(resolved)) return unpacked;
    }

    // Fallback: construct the path directly from process.resourcesPath. In a
    // packaged app this points at <app>/resources, and electron-builder unpacks
    // the subpackage to resources/app.asar.unpacked/node_modules/@anthropic-ai/...
    // This covers the case where require.resolve can't walk up to node_modules
    // (e.g. the main chunk's location doesn't have @anthropic-ai as a parent).
    if (process.resourcesPath) {
      const direct = join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        pkg, // already "@anthropic-ai/claude-agent-sdk-<plat>-<arch>"
        name,
      );
      if (existsSync(direct)) return direct;
    }
  }
  return null;
}

