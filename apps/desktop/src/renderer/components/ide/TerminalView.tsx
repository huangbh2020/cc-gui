import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { ITheme } from "@xterm/xterm";

export type TerminalSessionStatus = "starting" | "running" | "exited" | "error";

export interface TerminalViewHandle {
  clear: () => void;
  focus: () => void;
  fit: () => void;
  restart: () => void;
  kill: () => void;
  getTerminalId: () => string | null;
  getStatus: () => TerminalSessionStatus;
}

interface Props {
  /** Opaque UI session id (stable across PTY restarts). */
  sessionKey: string;
  projectPath: string;
  /** When false the host is hidden (right-tab keep-alive) — skip fit spam. */
  active: boolean;
  onStatusChange?: (status: TerminalSessionStatus, detail?: string) => void;
  onReady?: (handle: TerminalViewHandle) => void;
  className?: string;
}

/** Zinc/emerald mirrors of styles.css tokens — xterm needs explicit hex. */
function buildTheme(dark: boolean): ITheme {
  if (dark) {
    return {
      background: "#18181b", // surface zinc-900
      foreground: "#f4f4f5", // content zinc-100
      cursor: "#10b981", // accent emerald-500
      cursorAccent: "#18181b",
      selectionBackground: "#3f3f46", // surface-hover
      selectionForeground: "#f4f4f5",
      black: "#18181b",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#a78bfa",
      cyan: "#22d3ee",
      white: "#e4e4e7",
      brightBlack: "#52525b",
      brightRed: "#fca5a5",
      brightGreen: "#6ee7b7",
      brightYellow: "#fcd34d",
      brightBlue: "#93c5fd",
      brightMagenta: "#c4b5fd",
      brightCyan: "#67e8f9",
      brightWhite: "#fafafa",
    };
  }
  return {
    background: "#ffffff", // surface white
    foreground: "#18181b", // content zinc-900
    cursor: "#059669", // accent emerald-600
    cursorAccent: "#ffffff",
    selectionBackground: "#d4d4d8",
    selectionForeground: "#18181b",
    black: "#18181b",
    red: "#dc2626",
    green: "#059669",
    yellow: "#d97706",
    blue: "#2563eb",
    magenta: "#7c3aed",
    cyan: "#0891b2",
    white: "#e4e4e7",
    brightBlack: "#71717a",
    brightRed: "#ef4444",
    brightGreen: "#10b981",
    brightYellow: "#f59e0b",
    brightBlue: "#3b82f6",
    brightMagenta: "#8b5cf6",
    brightCyan: "#06b6d4",
    brightWhite: "#fafafa",
  };
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : true,
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(el.classList.contains("dark"));
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/**
 * One xterm instance bound to one main-side PTY.
 *
 * Lifecycle:
 *  - Mount → create Terminal + FitAddon, spawn PTY via api.terminal.create
 *  - Stay mounted across right-tab switches (parent keep-alive); `active`
 *    only controls fit/focus
 *  - Unmount or explicit kill → api.terminal.kill + xterm.dispose
 *  - Shell exit → status "exited"; restart() spawns a fresh PTY into the
 *    same xterm (buffer cleared)
 */
export function TerminalView({
  sessionKey,
  projectPath,
  active,
  onStatusChange,
  onReady,
  className,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const statusRef = useRef<TerminalSessionStatus>("starting");
  const disposedRef = useRef(false);
  const writingRef = useRef(false);
  // Bumps to force a fresh PTY spawn while keeping the same xterm instance.
  const [spawnGen, setSpawnGen] = useState(0);
  const dark = useIsDark();
  // Right-panel base font size drives the xterm fontSize (kept in sync with
  // the --right-panel-font-size CSS var used by the files/git tabs). Read
  // here so the Terminal constructor picks up the user's preference and the
  // effect below keeps a live instance in sync on change.
  const rightPanelFontSize = useSessionStore((s) => s.rightPanelFontSize);

  const setStatus = (s: TerminalSessionStatus, detail?: string) => {
    statusRef.current = s;
    onStatusChange?.(s, detail);
  };

  // Create xterm once per sessionKey.
  useEffect(() => {
    disposedRef.current = false;
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: rightPanelFontSize,
      // Bundled JetBrains Mono Variable heads the stack (same face as the
      // rest of the app's `font-mono` surfaces - see tailwind.config.js) so
      // the terminal matches code blocks/diffs; OS monospace is the fallback.
      fontFamily:
        '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      lineHeight: 1.2,
      scrollback: 5000,
      theme: buildTheme(document.documentElement.classList.contains("dark")),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Defer first fit until layout has real size.
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* host may be display:none */
      }
    });

    termRef.current = term;
    fitRef.current = fit;

    const dataDisp = term.onData((data) => {
      const id = terminalIdRef.current;
      if (!id || statusRef.current !== "running") return;
      if (writingRef.current) return;
      writingRef.current = true;
      void api.terminal
        .write({ terminalId: id, data })
        .catch(() => {
          /* ignore — exited races */
        })
        .finally(() => {
          writingRef.current = false;
        });
    });

    const handle: TerminalViewHandle = {
      clear: () => term.clear(),
      focus: () => term.focus(),
      fit: () => {
        try {
          fit.fit();
          const id = terminalIdRef.current;
          if (id && term.cols > 0 && term.rows > 0) {
            void api.terminal.resize({
              terminalId: id,
              cols: term.cols,
              rows: term.rows,
            });
          }
        } catch {
          /* ignore */
        }
      },
      restart: () => setSpawnGen((g) => g + 1),
      kill: () => {
        const id = terminalIdRef.current;
        if (id) {
          terminalIdRef.current = null;
          void api.terminal.kill({ terminalId: id });
        }
        setStatus("exited", "已终止");
      },
      getTerminalId: () => terminalIdRef.current,
      getStatus: () => statusRef.current,
    };
    onReady?.(handle);

    return () => {
      disposedRef.current = true;
      dataDisp.dispose();
      const id = terminalIdRef.current;
      terminalIdRef.current = null;
      if (id) {
        void api.terminal.kill({ terminalId: id });
      }
      try {
        fit.dispose();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitRef.current = null;
    };
    // sessionKey identity — remount only when the UI session is new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // Keep the live xterm fontSize in sync with the right-panel setting
  // (the constructor above only applies it at creation time). xterm supports
  // updating fontSize at runtime + a refit to recompute cols/rows, so we
  // avoid tearing down the instance on every slider drag.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = rightPanelFontSize;
    try {
      fit.fit();
    } catch {
      /* host may be display:none while the tab is hidden */
    }
  }, [rightPanelFontSize]);

  // Spawn / re-spawn PTY whenever spawnGen changes (initial + restart).
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    let cancelled = false;
    setStatus("starting");

    // Kill previous PTY if any (restart path).
    const prevId = terminalIdRef.current;
    terminalIdRef.current = null;
    if (prevId) {
      void api.terminal.kill({ terminalId: prevId });
    }

    const unsubData = api.on.terminalData((msg) => {
      if (cancelled || disposedRef.current) return;
      if (msg.terminalId !== terminalIdRef.current) return;
      term.write(msg.data);
    });
    const unsubExit = api.on.terminalExit((msg) => {
      if (cancelled || disposedRef.current) return;
      if (msg.terminalId !== terminalIdRef.current) return;
      terminalIdRef.current = null;
      const code = msg.exitCode;
      setStatus("exited", code === null ? "进程已结束" : `进程已退出 (code ${code})`);
      term.writeln("");
      term.writeln(
        `\r\n\x1b[90m[进程已退出${code === null ? "" : ` code=${code}`}] 点击工具栏「重开」可重新启动\x1b[0m`,
      );
    });

    const boot = async () => {
      try {
        // Ensure we have dimensions before spawn so the shell starts at the
        // right size (avoids a garbled first prompt).
        try {
          fit.fit();
        } catch {
          /* host may be hidden */
        }
        const cols = Math.max(term.cols || 80, 2);
        const rows = Math.max(term.rows || 24, 2);
        const result = await api.terminal.create({
          projectPath,
          cols,
          rows,
        });
        if (cancelled || disposedRef.current) {
          if (result.ok) void api.terminal.kill({ terminalId: result.terminalId });
          return;
        }
        if (!result.ok) {
          setStatus("error", result.error);
          term.writeln(`\r\n\x1b[31m[启动失败] ${result.error}\x1b[0m`);
          return;
        }
        terminalIdRef.current = result.terminalId;
        setStatus("running");
        // Sync size once more after create (layout may have settled).
        try {
          fit.fit();
          if (term.cols > 0 && term.rows > 0) {
            void api.terminal.resize({
              terminalId: result.terminalId,
              cols: term.cols,
              rows: term.rows,
            });
          }
        } catch {
          /* ignore */
        }
        if (active) term.focus();
      } catch (err) {
        if (cancelled || disposedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setStatus("error", msg);
        term.writeln(`\r\n\x1b[31m[启动失败] ${msg}\x1b[0m`);
      }
    };
    void boot();

    return () => {
      cancelled = true;
      unsubData();
      unsubExit();
    };
    // projectPath + spawnGen drive re-spawn; active only affects focus above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, projectPath, spawnGen]);

  // Theme updates.
  useEffect(() => {
    termRef.current?.options && (termRef.current.options.theme = buildTheme(dark));
  }, [dark]);

  // ResizeObserver + active visibility → fit + pty.resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let raf = 0;
    const doFit = () => {
      if (!active) return;
      const term = termRef.current;
      const fit = fitRef.current;
      const id = terminalIdRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
        if (id && term.cols > 0 && term.rows > 0) {
          void api.terminal.resize({
            terminalId: id,
            cols: term.cols,
            rows: term.rows,
          });
        }
      } catch {
        /* ignore */
      }
    };

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(doFit);
    });
    ro.observe(host);

    // When becoming active again, fit immediately and focus.
    if (active) {
      raf = requestAnimationFrame(() => {
        doFit();
        termRef.current?.focus();
      });
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active, sessionKey]);

  return (
    <div
      ref={hostRef}
      className={cn("h-full min-h-0 w-full overflow-hidden", className)}
      data-terminal-session={sessionKey}
      // xterm needs a non-zero box; parent supplies flex-1 min-h-0.
      style={{ padding: "4px 6px 6px" }}
    />
  );
}
