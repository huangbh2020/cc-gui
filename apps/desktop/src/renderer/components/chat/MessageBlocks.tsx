import { useState, type ReactNode } from "react";
import type { Block } from "@renderer/stores/sessionStore.js";
import { Markdown } from "./Markdown.js";

/** Render the content blocks of a message. */
export function MessageBlocks({ blocks }: { blocks: Block[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "text":
      return <Markdown>{block.text}</Markdown>;

    case "thinking":
      return <Collapsible label="Thinking" hint={summarize(block.text)}>{block.text}</Collapsible>;

    case "tool_use":
      return <ToolCard block={block} />;

    case "error":
      return (
        <div className="rounded-md border border-red-800 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          ⚠ {block.message}
        </div>
      );
  }
}

/** Tool call card: collapsible, shows status + input + result. */
function ToolCard({ block }: { block: Extract<Block, { kind: "tool_use" }> }) {
  const [open, setOpen] = useState(false);
  const statusIcon =
    block.status === "running" ? "⏳" : block.status === "error" ? "✗" : "✓";
  const statusColor =
    block.status === "running" ? "text-amber-400" : block.status === "error" ? "text-red-400" : "text-emerald-400";

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900/60 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800/50"
      >
        <span className={statusColor}>{statusIcon}</span>
        <span className="font-medium text-zinc-300">{block.toolName}</span>
        <span className="truncate text-zinc-500">{toolSummary(block.toolName, block.input)}</span>
        <span className="ml-auto text-zinc-600">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2">
          <div>
            <div className="mb-0.5 text-[10px] uppercase text-zinc-600">Input</div>
            <pre className="overflow-x-auto rounded bg-zinc-950/60 p-2 text-[11px] text-zinc-300">
              {safeStringify(block.input)}
            </pre>
          </div>
          {block.result !== undefined && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase text-zinc-600">Result</div>
              <pre className="max-h-60 overflow-auto rounded bg-zinc-950/60 p-2 text-[11px] text-zinc-300">
                {truncateResult(block.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A collapsible section (used for thinking blocks). */
function Collapsible({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-400 hover:bg-zinc-800/40"
      >
        <span className="text-zinc-500">{open ? "▾" : "▸"}</span>
        <span className="font-medium text-zinc-400">{label}</span>
        <span className="ml-1 truncate text-zinc-600">{hint}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800 px-3 py-2 text-zinc-400">
          <p className="whitespace-pre-wrap break-words">{children as unknown as string}</p>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────── helpers ──────────────────────────── */

function summarize(text: string): string {
  const t = text.trim();
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

/** A one-line hint for common tools (Read/Edit/Bash etc.) shown on the card header. */
function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(obj.file_path ?? "");
    case "Bash":
    case "PowerShell":
      return String(obj.command ?? obj.description ?? "");
    case "Glob":
      return String(obj.pattern ?? "");
    case "Grep":
      return String(obj.pattern ?? "");
    case "TodoWrite":
      return "todos";
    default:
      return Object.values(obj).slice(0, 1).map(String).join("").slice(0, 60);
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function truncateResult(v: unknown): string {
  const s = safeStringify(v);
  return s.length > 2000 ? s.slice(0, 2000) + "\n…(truncated)" : s;
}
