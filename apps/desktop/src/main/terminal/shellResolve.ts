/**
 * Resolve which shell executable to spawn for an integrated terminal.
 *
 * Order:
 *  1. Explicit override (per-create or settings key)
 *  2. Platform smart defaults (pwsh → powershell → git-bash → cmd on Windows;
 *     $SHELL → bash → zsh → sh on POSIX)
 *
 * Returns an absolute-ish path (or bare command name that spawn can find) plus
 * argv. Callers should still handle spawn failures gracefully — the resolved
 * binary may not exist on PATH at runtime.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { log } from "@main/lib/logger.js";

export interface ResolvedShell {
  /** Executable path or command name passed to node-pty. */
  file: string;
  /** argv (not including the executable). */
  args: string[];
  /** Display label for UI / TerminalInfo.shell. */
  label: string;
}

/** Try to locate `name` on PATH (and a few well-known install dirs on Win). */
function which(name: string): string | null {
  // Absolute / relative path that already exists.
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : null;
  }

  if (process.platform === "win32") {
    try {
      const out = execFileSync("where.exe", [name], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0);
      if (out && existsSync(out)) return out;
    } catch {
      // not on PATH
    }
    // Well-known install locations not always on PATH.
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    const candidates = [
      join(pf, "PowerShell", "7", `${name}.exe`),
      join(pf, "PowerShell", "7-preview", `${name}.exe`),
      join(local, "Microsoft", "WindowsApps", `${name}.exe`),
      join(pf, "Git", "bin", `${name}.exe`),
      join(pf, "Git", "usr", "bin", `${name}.exe`),
      join(pf86, "Git", "bin", `${name}.exe`),
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", `${name}.exe`),
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", `${name}.exe`),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  // POSIX: search PATH manually (avoid shelling out).
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  // Common absolute locations.
  for (const full of [`/bin/${name}`, `/usr/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (existsSync(full)) return full;
  }
  return null;
}

function winShellFromPath(file: string): ResolvedShell {
  const lower = file.toLowerCase();
  if (lower.endsWith("pwsh.exe") || lower.endsWith("\\pwsh") || lower.endsWith("/pwsh")) {
    return { file, args: ["-NoLogo"], label: file };
  }
  if (lower.includes("powershell")) {
    return { file, args: ["-NoLogo"], label: file };
  }
  if (lower.endsWith("bash.exe") || lower.endsWith("\\bash") || lower.endsWith("/bash")) {
    return { file, args: ["--login", "-i"], label: file };
  }
  if (lower.endsWith("cmd.exe") || lower.endsWith("\\cmd") || lower.endsWith("/cmd")) {
    return { file, args: [], label: file };
  }
  return { file, args: [], label: file };
}

function posixShellFromPath(file: string): ResolvedShell {
  // Login shell keeps user PATH/profile; -i is interactive.
  const base = file.split("/").pop() ?? file;
  if (base === "bash" || base === "zsh") {
    return { file, args: ["-l"], label: file };
  }
  return { file, args: [], label: file };
}

/** Resolve shell from an explicit user override (setting or per-create). */
function resolveOverride(override: string): ResolvedShell | null {
  const trimmed = override.trim();
  if (!trimmed) return null;
  const found = which(trimmed) ?? (existsSync(trimmed) ? trimmed : null);
  if (!found) {
    log.warn(`terminal.shell override not found: ${trimmed}`);
    return null;
  }
  return process.platform === "win32" ? winShellFromPath(found) : posixShellFromPath(found);
}

/** Platform smart-default shell. Always returns something spawnable-ish;
 *  last resort is `cmd.exe` / `/bin/sh` even if which() missed them. */
export function resolveDefaultShell(override?: string | null): ResolvedShell {
  if (override) {
    const o = resolveOverride(override);
    if (o) return o;
  }

  if (process.platform === "win32") {
    const order: Array<{ name: string; args: string[] }> = [
      { name: "pwsh", args: ["-NoLogo"] },
      { name: "powershell", args: ["-NoLogo"] },
      { name: "bash", args: ["--login", "-i"] },
      { name: "cmd", args: [] },
    ];
    for (const cand of order) {
      const file = which(cand.name);
      if (file) return { file, args: cand.args, label: file };
    }
    // Last resort — node-pty on Windows can usually find cmd via COMSPEC.
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: [], label: comspec };
  }

  const shellEnv = process.env.SHELL;
  if (shellEnv) {
    const found = which(shellEnv) ?? (existsSync(shellEnv) ? shellEnv : null);
    if (found) return posixShellFromPath(found);
  }
  for (const name of ["bash", "zsh", "sh"]) {
    const file = which(name);
    if (file) return posixShellFromPath(file);
  }
  return { file: "/bin/sh", args: [], label: "/bin/sh" };
}
