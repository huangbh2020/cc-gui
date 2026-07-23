import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Block, ChatMessage } from "@renderer/stores/sessionStore.js";
import { MessageBlocks } from "./MessageBlocks.js";

/** Center pane: message stream + input box. P1: fully wired to the store. */
// Module-level constant: a stable empty-array reference so the messages
// selector never returns a new [] on each render (which would loop Zustand).
const EMPTY_MESSAGES: ChatMessage[] = [];

export function ChatPane() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    activeSessionId ? s.messagesBySession[activeSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );
  const isRunning = useSessionStore((s) => s.isRunning);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const interrupt = useSessionStore((s) => s.interrupt);
  const claudeInstalled = useSessionStore((s) => s.claudeInstalled);

  const [value, setValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom as messages grow.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

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
            <div className="space-y-2">
              <div className="text-amber-500">⚠ Claude Code CLI not detected</div>
              <p className="text-xs text-zinc-600">
                Install it first: <code className="rounded bg-zinc-800 px-1">npm i -g @anthropic-ai/claude-code</code>
              </p>
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
      {/* Message stream */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-800 px-6 py-12 text-center text-sm text-zinc-600">
              Send a message to start working with Claude.
            </div>
          ) : (
            messages.map((m) => <MessageRow key={m.id} msg={m} />)
          )}
        </div>
      </div>

      {/* Input box */}
      <div className="shrink-0 border-t border-pane-border px-6 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 focus-within:border-emerald-600">
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={isRunning ? "Claude is working…" : "Send a message…  (Enter to send, Shift+Enter for newline)"}
              disabled={isRunning}
              className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-60"
            />
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
          <div className="mt-1 flex items-center gap-3 px-1 text-[11px] text-zinc-600">
            <span>@ to reference files</span>
            <span>/ for slash commands</span>
            <span>drag to attach</span>
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
