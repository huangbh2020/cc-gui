/**
 * Declarative per-language server specifications.
 *
 * This is the single place to extend LSP support: add a new `LanguageServerSpec`
 * entry and the LspManager picks up install / detect / start / sync behavior
 * automatically. Each spec declares:
 *
 *  - `binaryNames`  - executables probed via `which()` (PATH lookup).
 *  - `install`      - package-manager command per platform, run by `lsp.install`.
 *  - `uninstall`    - matching removal command per platform.
 *  - `startCommand` - given the resolved binary path, the {cmd, args} to spawn
 *                     the server in stdio JSON-RPC mode.
 *  - `initOptions`  - optional LSP `initializationOptions` payload.
 *  - `languageId`   - the Monaco language id this server claims (used to map
 *                     file extensions and register Monaco providers).
 *  - `extensions`   - file extensions (lowercased, with dot) this server owns.
 *
 * Java is special: it has no universal package-manager entry on win/linux, so
 * its install is implemented as a direct download in `LspManager.installJava`
 * (the `install` entries here are only used on darwin, which has brew). The
 * spec still carries the binary name + startCommand so detection/start work
 * uniformly once installed.
 */
import type { LspLanguageId } from "@contracts/ipc";

export interface LanguageServerSpec {
  language: LspLanguageId;
  displayName: string;
  /** Executable names to probe (first hit wins). E.g. pyright ships both
   *  `pyright-langserver` and `pyright`; we prefer the langserver. */
  binaryNames: string[];
  /** Per-platform install command (argv[0] = package manager). */
  install: { win32: string[]; darwin: string[]; linux: string[] };
  /** Per-platform uninstall command. */
  uninstall: { win32: string[]; darwin: string[]; linux: string[] };
  /** Given the resolved binary path, return the spawn command + args. */
  startCommand: (resolved: string) => { cmd: string; args: string[] };
  /** Optional LSP initialize `initializationOptions`. */
  initOptions?: unknown;
  /** Monaco language id this server maps to (for provider registration). */
  languageId: string;
  /** Lowercased extensions (with leading dot) this server handles. */
  extensions: string[];
  /** Download page URL for manual download (used when the package-manager
   *  install fails due to network issues). Null if not applicable (e.g. the
   *  npm/pip/go install is the only path). */
  downloadUrl?: string;
  /** Human-readable hint shown in the UI next to the download button. */
  downloadHint?: string;
}

/** The four supported language server specs, indexed by language id. */
export const LANGUAGE_SPECS: Record<LspLanguageId, LanguageServerSpec> = {
  typescript: {
    language: "typescript",
    displayName: "TypeScript / JavaScript",
    binaryNames: ["typescript-language-server"],
    install: {
      // `typescript` peer dep provides tsserver under the hood.
      win32: ["npm", "install", "-g", "typescript-language-server", "typescript"],
      darwin: ["npm", "install", "-g", "typescript-language-server", "typescript"],
      linux: ["npm", "install", "-g", "typescript-language-server", "typescript"],
    },
    uninstall: {
      win32: ["npm", "uninstall", "-g", "typescript-language-server"],
      darwin: ["npm", "uninstall", "-g", "typescript-language-server"],
      linux: ["npm", "uninstall", "-g", "typescript-language-server"],
    },
    startCommand: (p) => ({ cmd: p, args: ["--stdio"] }),
    languageId: "typescript",
    // JS files share the TS server (tsserver handles both).
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    downloadUrl: "https://github.com/typescript-language-server/typescript-language-server/releases",
    downloadHint: "下载 typescript-language-server 的可执行文件,解压后在高级中指定路径",
  },

  python: {
    language: "python",
    displayName: "Python",
    // basedpyright is a actively-maintained pyright fork; falls back to the
    // upstream pyright-langserver if only that is installed.
    binaryNames: ["basedpyright-langserver", "pyright-langserver"],
    install: {
      win32: ["pip", "install", "basedpyright"],
      darwin: ["pip", "install", "basedpyright"],
      linux: ["pip", "install", "basedpyright"],
    },
    uninstall: {
      win32: ["pip", "uninstall", "-y", "basedpyright"],
      darwin: ["pip", "uninstall", "-y", "basedpyright"],
      linux: ["pip", "uninstall", "-y", "basedpyright"],
    },
    startCommand: (p) => ({ cmd: p, args: ["--stdio"] }),
    languageId: "python",
    extensions: [".py"],
    downloadUrl: "https://github.com/DetachHead/basedpyright/releases",
    downloadHint: "下载基于 pyright 的二进制包,解压后在高级中指定路径",
  },

  go: {
    language: "go",
    displayName: "Go",
    binaryNames: ["gopls"],
    install: {
      win32: ["go", "install", "golang.org/x/tools/gopls@latest"],
      darwin: ["go", "install", "golang.org/x/tools/gopls@latest"],
      linux: ["go", "install", "golang.org/x/tools/gopls@latest"],
    },
    uninstall: {
      // `go clean -i` is the closest; gopls has no dedicated uninstall.
      win32: ["go", "clean", "-i", "golang.org/x/tools/gopls@latest"],
      darwin: ["go", "clean", "-i", "golang.org/x/tools/gopls@latest"],
      linux: ["go", "clean", "-i", "golang.org/x/tools/gopls@latest"],
    },
    startCommand: (p) => ({ cmd: p, args: ["serve"] }),
    languageId: "go",
    extensions: [".go"],
    downloadUrl: "https://github.com/golang/tools/releases/tag/gopls%2Fv0.17.1",
    downloadHint: "下载对应平台的 gopls 二进制,解压后在高级中指定路径",
  },

  java: {
    language: "java",
    displayName: "Java",
    binaryNames: ["jdtls"],
    // darwin has brew; win/linux install is handled specially (direct download
    // + extract) in LspManager.installJava - these commands are only the
    // package-manager path.
    install: {
      win32: [], // handled by installJava()
      darwin: ["brew", "install", "jdtls"],
      linux: [], // handled by installJava()
    },
    uninstall: {
      win32: [], // handled by uninstallJava()
      darwin: ["brew", "uninstall", "jdtls"],
      linux: [], // handled by uninstallJava()
    },
    startCommand: (p) => ({ cmd: p, args: [] }),
    languageId: "java",
    extensions: [".java"],
    downloadUrl: "https://download.eclipse.org/jdtls/milestones/",
    downloadHint: "下载 .tar.gz 压缩包,选择该文件安装(自动解压);需要本机有 JDK 17+",
  },
};

/** All specs in declaration order (for UI listing). */
export const ALL_LANGUAGE_SPECS: LanguageServerSpec[] = [
  LANGUAGE_SPECS.typescript,
  LANGUAGE_SPECS.python,
  LANGUAGE_SPECS.go,
  LANGUAGE_SPECS.java,
];

/** Look up the spec owning a given file extension (lowercased, with dot). */
export function specForExtension(ext: string): LanguageServerSpec | null {
  for (const spec of ALL_LANGUAGE_SPECS) {
    if (spec.extensions.includes(ext)) return spec;
  }
  return null;
}

/** The current platform key into the per-platform install/uninstall tables. */
export function currentPlatform(): "win32" | "darwin" | "linux" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
