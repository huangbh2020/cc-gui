/**
 * Binary PATH lookup shared by the terminal shell resolver and the LSP
 * manager. Extracted from `terminal/shellResolve.ts` so the LSP code can reuse
 * the same cross-platform `which()` without pulling terminal concerns.
 *
 * Returns an absolute path to the first matching executable found, or null.
 * Callers should still handle spawn failures gracefully - the resolved binary
 * may not be executable at runtime (permissions, broken symlink, etc.).
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";

/** Try to locate `name` on PATH (and a few well-known install dirs on Win).
 *
 *  `name` may be:
 *   - a bare command (`typescript-language-server`) -> PATH search
 *   - an absolute or relative path -> existence check (no PATH lookup)
 *
 *  On Windows, appends `.exe` to bare names when probing well-known dirs, and
 *  shells out to `where.exe` for the PATH search (matches cmd's resolution). */
export function which(name: string): string | null {
  // Absolute / relative path that already exists - trust the caller.
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
    // Well-known install locations not always on PATH (e.g. npm global bin).
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    const appdata = process.env["APPDATA"] ?? "";
    const candidates = [
      join(pf, "PowerShell", "7", `${name}.exe`),
      join(pf, "PowerShell", "7-preview", `${name}.exe`),
      join(local, "Microsoft", "WindowsApps", `${name}.exe`),
      join(pf, "Git", "bin", `${name}.exe`),
      join(pf, "Git", "usr", "bin", `${name}.exe`),
      join(pf86, "Git", "bin", `${name}.exe`),
      // npm global bin (where language servers like typescript-language-server
      // get installed by `npm i -g`).
      join(appdata, "npm", `${name}.cmd`),
      join(appdata, "npm", `${name}`),
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

/** Locate the first of `names` that exists on PATH. Useful when a language
 *  server ships under multiple binary names across versions/distros. */
export function whichAny(names: string[]): string | null {
  for (const n of names) {
    const found = which(n);
    if (found) return found;
  }
  return null;
}
