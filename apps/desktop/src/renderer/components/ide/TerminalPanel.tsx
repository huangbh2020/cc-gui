import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconPlus,
  IconX,
  IconTerminal2,
  IconRefresh,
  IconPlayerStop,
  IconEraser,
} from "@renderer/lib/icons.js";
import {
  TerminalView,
  type TerminalSessionStatus,
  type TerminalViewHandle,
} from "./TerminalView.js";

/** One UI terminal tab. `key` is stable; the underlying PTY id lives in the view. */
interface TermSession {
  key: string;
  title: string;
  status: TerminalSessionStatus;
  detail?: string;
}

let nextSeq = 1;
function makeSession(): TermSession {
  const n = nextSeq++;
  return { key: `term-${n}-${Date.now().toString(36)}`, title: `终端 ${n}`, status: "starting" };
}

/**
 * Right-panel Terminal tab body.
 *
 * - Scoped to the active project's path (cwd = project root).
 * - Supports multiple local sessions (tabs); each mounts a TerminalView.
 * - Parent RightPanel keep-alives this component across tab switches so PTYs
 *   and scrollback survive leaving/returning to the Terminal tab.
 */
export function TerminalPanel({ active }: { active: boolean }) {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId)?.path ?? null;
  }, [activeProjectId, projects]);

  const [sessions, setSessions] = useState<TermSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Tracks which projectPath the current sessions belong to.
  const boundPathRef = useRef<string | null>(null);
  const handlesRef = useRef<Map<string, TerminalViewHandle>>(new Map());

  // Reset sessions when the active project changes.
  useEffect(() => {
    if (!projectPath) {
      // Kill any live handles via unmount of TerminalViews (below returns empty).
      boundPathRef.current = null;
      setSessions([]);
      setActiveKey(null);
      handlesRef.current.clear();
      return;
    }
    if (boundPathRef.current === projectPath) return;
    boundPathRef.current = projectPath;
    handlesRef.current.clear();
    const first = makeSession();
    setSessions([first]);
    setActiveKey(first.key);
  }, [projectPath]);

  const addSession = useCallback(() => {
    const s = makeSession();
    setSessions((prev) => [...prev, s]);
    setActiveKey(s.key);
  }, []);

  const closeSession = useCallback(
    (key: string) => {
      handlesRef.current.get(key)?.kill();
      handlesRef.current.delete(key);
      setSessions((prev) => {
        const next = prev.filter((s) => s.key !== key);
        if (next.length === 0 && projectPath) {
          const fresh = makeSession();
          // Defer activeKey update to keep React batching clean.
          queueMicrotask(() => setActiveKey(fresh.key));
          return [fresh];
        }
        if (activeKey === key) {
          const fallback = next[next.length - 1]?.key ?? null;
          queueMicrotask(() => setActiveKey(fallback));
        }
        return next;
      });
    },
    [activeKey, projectPath],
  );

  const updateStatus = useCallback(
    (key: string, status: TerminalSessionStatus, detail?: string) => {
      setSessions((prev) =>
        prev.map((s) => (s.key === key ? { ...s, status, detail } : s)),
      );
    },
    [],
  );

  if (!projectPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-content-subtle">
          <IconTerminal2 size={20} />
        </div>
        <p className="text-xs font-medium text-content-muted">还没有项目</p>
        <p className="text-[11px] leading-relaxed text-content-subtle">
          在左侧栏添加一个项目文件夹后,即可在此打开集成终端
        </p>
      </div>
    );
  }

  const activeSession = sessions.find((s) => s.key === activeKey) ?? sessions[0] ?? null;
  const activeHandle = activeSession ? handlesRef.current.get(activeSession.key) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Session tab strip + actions */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-edge px-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-0.5">
          {sessions.map((s) => {
            const isActive = s.key === activeKey;
            return (
              <div
                key={s.key}
                className={cn(
                  "group flex max-w-[9rem] shrink-0 items-center gap-0.5 rounded-t px-1.5 py-1 text-[11px]",
                  isActive
                    ? "bg-surface text-content"
                    : "text-content-subtle hover:bg-surface-hover hover:text-content-muted",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 truncate"
                  onClick={() => setActiveKey(s.key)}
                  title={s.detail ? `${s.title} — ${s.detail}` : s.title}
                >
                  <span
                    className={cn(
                      "mr-1 inline-block h-1.5 w-1.5 rounded-full",
                      s.status === "running" && "bg-accent",
                      s.status === "starting" && "bg-warning",
                      s.status === "exited" && "bg-content-subtle",
                      s.status === "error" && "bg-danger",
                    )}
                  />
                  {s.title}
                </button>
                <button
                  type="button"
                  className={cn(
                    "rounded p-0.5 text-content-subtle hover:bg-surface-hover hover:text-content",
                    !isActive && "opacity-0 group-hover:opacity-100",
                  )}
                  title="关闭终端"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.key);
                  }}
                >
                  <IconX size={11} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
            title="新建终端"
            onClick={addSession}
          >
            <IconPlus size={13} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 border-l border-edge pl-1">
          <IconBtn
            title="清屏"
            onClick={() => activeHandle?.clear()}
            disabled={!activeHandle}
          >
            <IconEraser size={13} />
          </IconBtn>
          <IconBtn
            title="终止进程"
            onClick={() => activeHandle?.kill()}
            disabled={!activeHandle || activeSession?.status !== "running"}
          >
            <IconPlayerStop size={13} />
          </IconBtn>
          <IconBtn
            title="重开"
            onClick={() => {
              // Clear scrollback then spawn a fresh PTY into the same view.
              activeHandle?.clear();
              activeHandle?.restart();
            }}
            disabled={!activeHandle}
          >
            <IconRefresh size={13} />
          </IconBtn>
        </div>
      </div>

      {/* Status line for exited/error */}
      {activeSession &&
        (activeSession.status === "exited" || activeSession.status === "error") && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-surface px-2 py-1 text-[11px] text-content-muted">
            <span className="truncate">
              {activeSession.detail ??
                (activeSession.status === "error" ? "启动失败" : "已退出")}
            </span>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-accent hover:bg-surface-hover"
              onClick={() => activeHandle?.restart()}
            >
              重开
            </button>
          </div>
        )}

      {/* Terminal hosts — keep all sessions mounted; hide inactive ones so
          scrollback + PTY survive tab switches inside this panel. */}
      <div className="relative min-h-0 flex-1 bg-surface-muted">
        {sessions.map((s) => {
          const isActive = s.key === activeKey;
          return (
            <div
              key={s.key}
              className={cn(
                "absolute inset-0",
                isActive ? "z-10" : "pointer-events-none invisible z-0",
              )}
              aria-hidden={!isActive}
            >
              <TerminalView
                sessionKey={s.key}
                projectPath={projectPath}
                active={active && isActive}
                onStatusChange={(status, detail) => updateStatus(s.key, status, detail)}
                onReady={(handle) => {
                  handlesRef.current.set(s.key, handle);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
