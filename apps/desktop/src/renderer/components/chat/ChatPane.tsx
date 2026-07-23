import { useState, useRef, useEffect } from "react";

/** Center pane: message stream + input box.
 * P0 ships the empty state and a working input box (Enter to send logs to
 * console). P1 connects send() to window.api.claude.sendTurn and renders
 * streamed RuntimeEvents. */
export function ChatPane() {
  const [value, setValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the message stream pinned to the bottom.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, []);

  const handleSend = () => {
    const text = value.trim();
    if (!text) return;
    // P1: await window.api.claude.sendTurn({ sessionId, prompt: text })
    console.log("[chat] send (P1 wiring pending):", text);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Message stream */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        <div className="mx-auto max-w-3xl">
          <div className="rounded-md border border-dashed border-zinc-800 px-6 py-12 text-center text-sm text-zinc-600">
            Start a conversation.
            <br />
            <span className="text-zinc-700">
              Messages, tool calls, diffs and approvals render here.
            </span>
          </div>
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
              placeholder="Send a message…  (Enter to send, Shift+Enter for newline)"
              className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
            <button
              onClick={handleSend}
              disabled={!value.trim()}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            >
              Send
            </button>
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
