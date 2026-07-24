import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { log } from "@main/lib/logger.js";
import { CLAUDE_PATH_SETTING_KEY } from "@contracts/ipc";

/** Re-exported so main-side callers can import it from the resolver alongside
 * the functions they already use. (The renderer imports it from @contracts.) */
export { CLAUDE_PATH_SETTING_KEY };

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

/** Setting key under which the user's configured claude path is persisted
 * (see @contracts/ipc — re-exported above). */

/** Lazy import of SettingRepo to keep this module loadable before the DB is
 * open (the resolver is imported widely). The DB is always ready by the time
 * resolveClaude() actually runs (called from IPC handlers / runtime). */
async function readUserConfiguredPath(): Promise<string | null> {
  try {
    const { SettingRepo } = await import("@main/store/repositories.js");
    return SettingRepo.get(CLAUDE_PATH_SETTING_KEY);
  } catch (err) {
    // DB not ready yet (e.g. very early probe) — fall through to other sources.
    log.warn(`settings read deferred: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Turn an explicit filesystem path into a launch spec, deciding how to spawn
 * based on the file type. Returns null if the file doesn't exist or can't be
 * resolved to something spawnable.
 *
 *   *.exe / bare → spawn directly (native installer, or npm's bin/claude.exe)
 *   *.cmd        → npm shim: read it to find the underlying claude.exe and
 *                  spawn that directly. (Spawning the .cmd itself is unreliable
 *                  on Windows — its internal backslash paths get mangled by
 *                  cmd.exe, and Node can't spawn a .cmd without shell:true.)
 *   *.cjs        → `node <path>` (e.g. a hand-pointed cli-wrapper.cjs)
 *
 * The key insight: npm's `claude.cmd` shim just forwards to
 * `<prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, a native
 * executable we can spawn with zero shell/escaping issues. So we extract that
 * exe path from the shim and use it directly.
 */
export function resolveClaudeSpec(path: string): ClaudeLaunchSpec | null {
  if (!existsSync(path)) return null;
  const lower = path.toLowerCase();

  if (lower.endsWith(".cmd")) {
    const exe = claudeExeFromCmdShim(path);
    if (exe) return { command: exe, preArgs: [], source: "user config (.cmd → claude.exe)" };
    // Couldn't parse the shim — give up rather than spawn the .cmd unreliably.
    return null;
  }

  if (lower.endsWith(".cjs")) {
    return { command: process.execPath, preArgs: [path], source: "user config (.cjs)" };
  }

  // .exe / no extension / anything else: spawn directly.
  return { command: path, preArgs: [], source: "user config" };
}

/**
 * Parse a Windows npm `.cmd` shim and return the absolute path to the native
 * claude.exe it forwards to, if present and existing. npm shims look like:
 *   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
 * where %dp0% (a.k.a %~dp0) is the shim's own directory.
 */
function claudeExeFromCmdShim(cmdPath: string): string | null {
  try {
    const text = readFileSync(cmdPath, "utf8");
    // Match the claude.exe reference, with or without the %dp0% prefix.
    const m = text.match(/(node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude\.exe)/i);
    if (!m) return null;
    const exe = join(dirname(cmdPath), m[1]);
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** A no-arg probe: does invoking this actually produce a working claude? */
function isExecutable(command: string, preArgs: string[]): boolean {
  // We only do a filesystem check here; a real exec probe is expensive and
  // belongs in the test handler / ClaudeRuntime. existsSync on the target file
  // is enough for resolution.
  try {
    if (preArgs.length > 0) return existsSync(preArgs[0]);
    return existsSync(command);
  } catch {
    return false;
  }
}

const isWin = platform() === "win32";

/** Auto-detected candidate search order (used only as a fallback when the user
 * hasn't configured a path and CLAUDE_BIN is unset). Most reliable first. */
function autoCandidates(): ClaudeLaunchSpec[] {
  const home = homedir();
  const specs: ClaudeLaunchSpec[] = [];

  // CLAUDE_BIN env override.
  const envOverride = process.env["CLAUDE_BIN"];
  if (envOverride) specs.push({ command: envOverride, preArgs: [], source: "CLAUDE_BIN env" });

  if (isWin) {
    // Native installer: %USERPROFILE%\.local\bin\claude.exe
    const nativeExe = join(home, ".local", "bin", "claude.exe");
    specs.push({ command: nativeExe, preArgs: [], source: "native installer" });

    // npm global — the real entry is the native exe under node_modules, NOT the
    // claude.cmd shim (spawning the shim is unreliable on Windows; see
    // resolveClaudeSpec). Probe common npm prefix locations for bin/claude.exe.
    // NOTE: process.env["npm_config_prefix"] is only set under npm/pnpm scripts,
    // NOT in a running Electron app — hence the hardcoded fallbacks. Users on
    // non-default prefixes should configure the path in Settings.
    const npmPrefixes = [
      process.env["npm_config_prefix"],
      join(process.env["APPDATA"] ?? "", "npm"),
      join(process.env["LOCALAPPDATA"] ?? "", "npm"),
    ].filter(Boolean) as string[];
    for (const prefix of npmPrefixes) {
      const exe = join(prefix, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      specs.push({ command: exe, preArgs: [], source: `npm global (${prefix})` });
    }
  } else {
    // macOS / Linux
    specs.push({ command: join(home, ".local", "bin", "claude"), preArgs: [], source: "native installer" });
    specs.push({ command: "claude", preArgs: [], source: "PATH" });
  }

  return specs.filter((s) => isExecutable(s.command, s.preArgs));
}

/** Cached resolution of the auto-detected path (the user-configured path is
 * always re-read live, since it can change via Settings at any time). */
let autoCached: ClaudeLaunchSpec | null | undefined;

/**
 * Resolve how to launch claude. Priority (highest first):
 *   1. User-configured path (Settings, persisted in SQLite) — re-read each call
 *   2. CLAUDE_BIN env / auto-detected locations (cached)
 * Returns null if nothing usable is found.
 *
 * This is async because reading the user setting may touch the DB. Callers that
 * previously used the sync form are updated to await.
 */
export async function resolveClaude(): Promise<ClaudeLaunchSpec | null> {
  // 1. User config wins — re-read every time so Settings changes take effect
  //    immediately (without needing a restart).
  const userPath = await readUserConfiguredPath();
  if (userPath) {
    const spec = resolveClaudeSpec(userPath);
    if (spec) {
      log.info(`claude resolved via ${spec.source}: ${spec.command} ${spec.preArgs.join(" ")}`);
      return spec;
    }
    log.warn(`user-configured claude path not found, falling back: ${userPath}`);
  }

  // 2. Auto-detection (cached).
  if (autoCached !== undefined) return autoCached;
  const found = autoCandidates()[0] ?? null;
  autoCached = found;
  if (found) {
    log.info(`claude resolved via ${found.source}: ${found.command} ${found.preArgs.join(" ")}`);
  } else {
    log.warn("claude CLI not found in any known location");
  }
  return found;
}

/** Forget the auto-detection cache (e.g. after the user changes settings, or
 * installs claude at runtime). The user-configured path is always live, so it
 * doesn't need invalidation — but we clear auto cache too in case the user
 * cleared their setting and we should re-probe. */
export function resetClaudeResolution(): void {
  autoCached = undefined;
}

/** The directory of the resolved claude install, if any (for version display). */
export async function claudeInstallDir(): Promise<string | null> {
  const spec = await resolveClaude();
  if (!spec) return null;
  if (spec.preArgs.length > 0) return dirname(spec.preArgs[0]);
  return dirname(spec.command);
}
