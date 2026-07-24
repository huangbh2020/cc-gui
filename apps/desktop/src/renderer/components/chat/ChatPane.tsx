import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Block, ChatMessage, TodoItem, SessionUsage } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { MessageBlocks } from "./MessageBlocks.js";
import { TodosPopover } from "./TodosPopover.js";
import { ComposerToolbar } from "./ComposerToolbar.js";
import { QuestionPrompt } from "./QuestionPrompt.js";

/** Center pane: message stream + input box. */
// Module-level constants: stable empty-array references so selectors never
// return a fresh [] on each render (which would loop Zustand's Object.is).
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_TODOS: TodoItem[] = [];

/** Compact token count, e.g. 12345 → "12.3k". */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Rough context-window assumption for the occupancy bar/color (claude doesn't
 *  report the window; 200k is a common default for these models). */
const CONTEXT_WINDOW = 200_000;

/** Token usage chip with a mini occupancy bar; color escalates as the window
 *  fills (ZCode-style status tint). */
function UsageChip({ usage }: { usage: SessionUsage }) {
  const pct = Math.min(100, (usage.inputTokens / CONTEXT_WINDOW) * 100);
  const color =
    pct >= 90 ? "text-red-400" : pct >= 70 ? "text-amber-400" : "text-zinc-400";
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <span
      className={`pointer-events-auto flex items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/70 px-2 py-1 text-[11px] backdrop-blur ${color}`}
      title={`Approx. context occupancy: ${usage.inputTokens.toLocaleString()} input tokens / ${CONTEXT_WINDOW.toLocaleString()} window`}
    >
      <span className="font-medium tabular-nums">{fmtTokens(usage.inputTokens)}</span>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-zinc-700/70">
        <span className={`block h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/** Tiny 12px progress ring showing task completion. */
function TaskRing({ done, total }: { done: number; total: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  const allDone = done > 0 && done === total;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
      <circle cx="6" cy="6" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-25" />
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        transform="rotate(-90 6 6)"
        className={allDone ? "text-emerald-400" : "text-current"}
      />
    </svg>
  );
}

export function ChatPane() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    activeSessionId ? s.messagesBySession[activeSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );
  const isRunning = useSessionStore((s) => s.isRunning);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const interrupt = useSessionStore((s) => s.interrupt);
  const claudeInstalled = useSessionStore((s) => s.claudeInstalled);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Tasks capsule + usage (both keyed by the active session).
  const todos = useSessionStore((s) =>
    activeSessionId ? s.todosBySession[activeSessionId] ?? EMPTY_TODOS : EMPTY_TODOS,
  );
  const usage = useSessionStore((s) => (activeSessionId ? s.usageBySession[activeSessionId] : undefined));
  // Pending AskUserQuestion (only show if it belongs to the active session).
  const pendingQuestion = useSessionStore((s) => s.pendingQuestion);
  const dismissQuestion = useSessionStore((s) => s.dismissQuestion);
  const activeQuestion =
    pendingQuestion && pendingQuestion.sessionId === activeSessionId ? pendingQuestion.questions : null;

  const [value, setValue] = useState("");
  const [todosOpen, setTodosOpen] = useState(false);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** When set, an @ mention is pending a file picker; the number is the caret
   * index where the triggering "@" sits, so we can splice the path in there. */
  const pendingAtRef = useRef<number | null>(null);

  /** Insert an @file reference at the stored caret, replacing the trigger "@". */
  const completeAtMention = async () => {
    const at = pendingAtRef.current;
    if (at === null) return;
    pendingAtRef.current = null;
    const { path } = await api.pickFile();
    if (!path) return; // user canceled
    // Splice `@path` in at the "@" position. Backslash paths work but forward
    // slashes read better and claude accepts them; normalize for display.
    const insert = "@" + path.replace(/\\/g, "/");
    setValue((v) => v.slice(0, at) + insert + v.slice(at + 1));
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    const caret = e.target.selectionStart ?? v.length;
    setValue(v);
    // Detect a freshly-typed "@" (the char just before the caret) and trigger
    // the file picker once. Avoid retriggering while a pick is already pending.
    const justTypedAt = v.length > value.length && v[caret - 1] === "@" && value[caret - 1] !== "@";
    if (justTypedAt && pendingAtRef.current === null) {
      pendingAtRef.current = caret - 1;
      void completeAtMention();
    }
  };

  // Track whether the user is near the bottom, so we only auto-scroll on new
  // messages when they're already following along (don't yank them down while
  // they're reading older history). Also drives the "jump to bottom" button.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setShowJumpBottom(!nearBottom);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll to bottom as messages grow — but only if already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const jumpToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const handleSend = () => {
    const text = value.trim();
    if (!text || isRunning) return;
    void sendPrompt(text);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // No session open yet.
  if (!activeSessionId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center text-sm text-zinc-500">
          {claudeInstalled === false ? (
            <div className="space-y-3">
              <div className="text-amber-500">⚠ Claude Code CLI not detected</div>
              <p className="text-xs text-zinc-600">
                Install it (<code className="rounded bg-zinc-800 px-1">npm i -g @anthropic-ai/claude-code</code>),
                or point the app at an existing install:
              </p>
              <button
                onClick={() => setSettingsOpen(true)}
                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-500"
              >
                Configure CLI path →
              </button>
            </div>
          ) : (
            <p>Open a project and start a session to begin.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Message stream. The capsule row is sticky top-right (ZCode-style: stays
          put while scrolling, glassy, compact) so it overlays content without
          taking a layout row. */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {(todos.length > 0 || usage) && (
          <div className="pointer-events-none sticky top-0 z-20 -mx-2 flex items-center justify-end gap-1.5 bg-gradient-to-b from-zinc-950/90 to-transparent pb-2 pt-1">
            {usage && <UsageChip usage={usage} />}
            {todos.length > 0 && (
              <div className="pointer-events-auto relative">
                <button
                  onClick={() => setTodosOpen((v) => !v)}
                  className={`pointer-events-auto flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium backdrop-blur transition-all ${
                    todosOpen
                      ? "border-emerald-500/40 bg-emerald-950/60 text-emerald-300"
                      : "border-white/10 bg-zinc-900/70 text-zinc-300 hover:border-white/20 hover:bg-zinc-800/80"
                  }`}
                  title="Show claude's task list"
                >
                  <TaskRing done={todos.filter((t) => t.status === "completed").length} total={todos.length} />
                  <span>
                    {todos.filter((t) => t.status === "completed").length}/{todos.length}
                  </span>
                </button>
                {todosOpen && <TodosPopover todos={todos} />}
              </div>
            )}
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-800 px-6 py-12 text-center text-sm text-zinc-600">
              Send a message to start working with Claude.
            </div>
          ) : (
            messages.map((m) => <MessageRow key={m.id} msg={m} />)
          )}
        </div>
        {/* Jump-to-bottom button: appears when the user has scrolled up. */}
        {showJumpBottom && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-zinc-800/90 px-3 py-1.5 text-[11px] text-zinc-200 shadow-lg backdrop-blur transition-colors hover:bg-zinc-700"
            title="Jump to latest"
          >
            ↓ Latest
          </button>
        )}
      </div>

      {/* Input box — Codex-style: a single rounded container holding the
          textarea on top and a bottom row (option chips left, send button
          right) inside the same border. */}
      <div className="shrink-0 border-t border-pane-border px-6 py-3">
        <div className="mx-auto max-w-3xl">
          {activeQuestion && (
            <QuestionPrompt
              questions={activeQuestion}
              onSubmit={(text) => {
                dismissQuestion();
                void sendPrompt(text);
              }}
              onDismiss={dismissQuestion}
            />
          )}
          <div className="flex flex-col rounded-xl border border-zinc-700 bg-zinc-900 focus-within:border-emerald-600">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={isRunning ? "Claude is working…" : "Send a message…  (@ to attach a file)"}
              disabled={isRunning}
              className="max-h-40 min-h-[28px] flex-1 resize-none bg-transparent px-3 pt-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-60"
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-1">
              <ComposerToolbar />
              {isRunning ? (
                <button
                  onClick={() => void interrupt()}
                  className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!value.trim()}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One row in the stream, with role styling. */
function MessageRow({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : ""}>
      <div className={isUser ? "max-w-[85%]" : "w-full"}>
        <div className="mb-1 flex items-center gap-2 px-1">
          <span className={`text-[11px] font-semibold ${isUser ? "text-sky-400" : "text-emerald-400"}`}>
            {isUser ? "You" : "Claude"}
          </span>
        </div>
        <div
          className={
            isUser
              ? "rounded-lg bg-sky-950/40 px-3 py-2 text-sm text-zinc-200"
              : "text-sm text-zinc-200"
          }
        >
          <MessageBlocks blocks={msg.blocks} />
        </div>
      </div>
    </div>
  );
}

export type { Block };
