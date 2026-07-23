import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { log } from "@main/lib/logger.js";

/** How to launch the claude CLI. We may need `node <wrapper.cjs>` (npm global
 * install) or just `claude.exe` / `claude` (native installer). The resolver
 * returns a command + leading args so the runtime can spawn uniformly. */
export interface ClaudeLaunchSpec {
  /** The executable to spawn. */
  command: string;
  /** Extra args prepended before the CLI flags (e.g. ["path/to/cli.js"]). */
  preArgs: string[];
  /** Where it was found, for display. */
  source: string;
}

/** A no-arg probe: does invoking this actually produce a working claude? */
function isExecutable(command: string, preArgs: string[]): boolean {
  // We only do a filesystem check here; a real exec probe is expensive and
  // belongs in ClaudeRuntime.healthCheck(). existsSync on the target file is
  // enough for resolution.
  try {
    if (preArgs.length > 0) return existsSync(preArgs[0]);
    return existsSync(command);
  } catch {
    return false;
  }
}

const isWin = platform() === "win32";

/** Candidate search order, most reliable first. */
function candidates(): ClaudeLaunchSpec[] {
  const home = homedir();
  const specs: ClaudeLaunchSpec[] = [];

  // 1. Custom env override (highest priority — lets users point at anything).
  const envOverride = process.env["CLAUDE_BIN"];
  if (envOverride) specs.push({ command: envOverride, preArgs: [], source: "CLAUDE_BIN env" });

  if (isWin) {
    // 2. Native installer: %USERPROFILE%\.local\bin\claude.exe
    const nativeExe = join(home, ".local", "bin", "claude.exe");
    specs.push({ command: nativeExe, preArgs: [], source: "native installer" });

    // 3. npm global — claude.cmd shim (needs shell:true to spawn, so prefer the
    //    underlying node + cli-wrapper.cjs to avoid the .cmd ENOENT trap).
    //    Walk common npm prefix locations. The real entry is cli-wrapper.cjs.
    const npmPrefixes = [
      process.env["npm_config_prefix"], // this machine: D:\soft\nodejs\node_global
      join(process.env["APPDATA"] ?? "", "npm"),
      join(process.env["LOCALAPPDATA"] ?? "", "npm"),
    ].filter(Boolean) as string[];
    for (const prefix of npmPrefixes) {
      const wrapper = join(prefix, "node_modules", "@anthropic-ai", "claude-code", "cli-wrapper.cjs");
      if (existsSync(wrapper)) {
        specs.push({ command: process.execPath, preArgs: [wrapper], source: `npm global (${prefix})` });
      }
      // also the plain cmd shim as a last resort
      specs.push({ command: join(prefix, "claude.cmd"), preArgs: [], source: `npm shim (${prefix})` });
    }
  } else {
    // macOS / Linux
    specs.push({ command: join(home, ".local", "bin", "claude"), preArgs: [], source: "native installer" });
    specs.push({ command: "claude", preArgs: [], source: "PATH" });
  }

  return specs.filter((s) => isExecutable(s.command, s.preArgs));
}

let cached: ClaudeLaunchSpec | null | undefined;

/** Resolve how to launch claude. Returns null if not found anywhere. */
export function resolveClaude(): ClaudeLaunchSpec | null {
  if (cached !== undefined) return cached;
  const found = candidates()[0] ?? null;
  cached = found;
  if (found) {
    log.info(`claude resolved via ${found.source}: ${found.command} ${found.preArgs.join(" ")}`);
  } else {
    log.warn("claude CLI not found in any known location");
  }
  return found;
}

/** Forget the cache (e.g. after the user installs claude at runtime). */
export function resetClaudeResolution(): void {
  cached = undefined;
}

/** The directory of the resolved claude install, if any (for version display). */
export function claudeInstallDir(): string | null {
  const spec = resolveClaude();
  if (!spec) return null;
  if (spec.preArgs.length > 0) return dirname(spec.preArgs[0]);
  return dirname(spec.command);
}
