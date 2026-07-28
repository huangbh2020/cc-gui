import { useState, useMemo, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconChevronDown,
  IconCheck,
  IconX,
  IconLoader2,
  IconAlertTriangle,
  IconTools,
} from "@renderer/lib/icons.js";
import type { Block } from "@renderer/stores/sessionStore.js";
import { Markdown } from "./Markdown.js";
import { DiffView } from "./DiffView.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";

/** Map of absolute file path → its pre-turn content. Built from the
 *  `turn.files` event payload so the Write tool card can diff the new
 *  `input.content` against what was on disk before the turn. Empty when
 *  the turn is still running (no turn.files yet) or after a rewind — in
 *  those cases Write falls back to a plain new-content preview. */
export type BeforeContentMap = Map<string, string>;

/** Render the content blocks of a message.
 *
 *  Purely procedural content (thinking + tool calls, no prose) is collapsed
 *  into a single boxed `ProceduralGroup` so the message stream stays calm
 *  — one summary line instead of N cards. Text and error blocks render
 *  inline as before. */
export function MessageBlocks({
  blocks,
  beforeMap,
}: {
  blocks: Block[];
  /** Pre-turn file contents for Write-tool diffing. Forwarded down to any
   *  procedural group rendered inside this message (the single-message
   *  path — the cluster path in ChatPane passes beforeMap directly to
   *  ProceduralGroup). */
  beforeMap?: BeforeContentMap;
}) {
  if (blocks.length === 0) return null;
  const segments = groupBlocks(blocks);
  return (
    <div className="space-y-2">
      {segments.map((seg, i) =>
        seg.kind === "single" ? (
          <BlockView key={i} block={seg.block} beforeMap={beforeMap} />
        ) : (
          <ProceduralGroup key={i} blocks={seg.blocks} beforeMap={beforeMap} />
        ),
      )}
    </div>
  );
}

export type ToolUseBlock = Extract<Block, { kind: "tool_use" }>;
export type ThinkingBlock = Extract<Block, { kind: "thinking" }>;
/** Procedural blocks are the "model action" surface — thinking and tool
 *  calls. They get grouped together so a turn that thinks + fires off N
 *  tools reads as one compact card, not a wall of cards. */
export type ProceduralBlock = ThinkingBlock | ToolUseBlock;
type Segment =
  | { kind: "single"; block: Block }
  | { kind: "procedural"; blocks: ProceduralBlock[] };

/** Linear scan: collect consecutive thinking / tool_use blocks into a run.
 *  Any text or error block flushes the run (and renders as its own segment).
 *  Even a single tool_use with no surrounding text becomes a procedural
 *  group — that's the whole point: keep the prose stream clean. */
function groupBlocks(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  let run: ProceduralBlock[] = [];
  const flush = () => {
    if (run.length > 0) {
      out.push({ kind: "procedural", blocks: run });
      run = [];
    }
  };
  for (const b of blocks) {
    if (b.kind === "thinking" || b.kind === "tool_use") {
      run.push(b);
    } else {
      flush();
      out.push({ kind: "single", block: b });
    }
  }
  flush();
  return out;
}

/** Render a collapsible chevron icon (▾ when open, ▸ when closed). */
function Chevron({ open }: { open: boolean }) {
  return (
    <IconChevronDown
      size={12}
      className={cn(
        "shrink-0 text-content-subtle transition-transform",
        !open && "-rotate-90",
      )}
    />
  );
}

/** Status icon for tool calls: running→spinner, error→X, done→check. */
function StatusIcon({ status }: { status: "running" | "done" | "error" }) {
  if (status === "running") {
    return <IconLoader2 size={12} className="animate-spin text-warning" />;
  }
  if (status === "error") {
    return <IconX size={12} className="text-danger" />;
  }
  return <IconCheck size={12} className="text-accent" />;
}

/** Collapsible box for a run of procedural blocks (thinking + tool calls).
 *  Collapsed: one summary line — aggregate status icon + a compact
 *  "N 个操作 · Bash ×2 · Read ×1" breakdown. Expanded: each child renders
 *  in its normal form (thinking as Collapsible, tool calls as ToolCard),
 *  all starting collapsed — the user drills in further only if they want. */
export function ProceduralGroup({
  blocks,
  beforeMap,
}: {
  blocks: ProceduralBlock[];
  /** Pre-turn file contents for Write-tool diffing. Optional — omitted in
   *  the single-message (non-cluster) render path where diffs aren't
   *  shown. Forwarded down to WriteToolCard. */
  beforeMap?: BeforeContentMap;
}) {
  const [open, setOpen] = useState(false);

  const toolBlocks = blocks.filter((b): b is ToolUseBlock => b.kind === "tool_use");
  const thinkingCount = blocks.filter((b) => b.kind === "thinking").length;

  // Aggregate status: any running → running; else any error → error; else done.
  // Thinking blocks have no status of their own, so only tools drive this.
  const aggregateStatus: "running" | "done" | "error" = toolBlocks.some((b) => b.status === "running")
    ? "running"
    : toolBlocks.some((b) => b.status === "error")
      ? "error"
      : "done";

  // Tool-name tally in first-invocation order (Map preserves insertion).
  const counts = new Map<string, number>();
  for (const b of toolBlocks) counts.set(b.toolName, (counts.get(b.toolName) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([n, c]) => `${n} ×${c}`).join(" · ");

  // Summary label: "思考 + N 个操作" / "N 个操作" / "思考".
  let label: string;
  if (thinkingCount > 0 && toolBlocks.length > 0) {
    label = `思考 + ${toolBlocks.length} 个操作`;
  } else if (toolBlocks.length > 0) {
    label = `${toolBlocks.length} 个操作`;
  } else {
    label = "思考";
  }

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-1 py-1.5 text-left hover:bg-surface-muted/40"
      >
        <StatusIcon status={aggregateStatus} />
        <IconTools size={14} className="shrink-0 text-content-muted" />
        <span className="font-medium text-content-muted">{label}</span>
        {breakdown && <span className="truncate text-content-subtle">{breakdown}</span>}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="space-y-1.5 py-2 pl-5">
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} beforeMap={beforeMap} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockView({
  block,
  defaultOpen = false,
  beforeMap,
}: {
  block: Block;
  defaultOpen?: boolean;
  beforeMap?: BeforeContentMap;
}) {
  switch (block.kind) {
    case "text":
      return <Markdown>{block.text}</Markdown>;

    case "thinking":
      return (
        <Collapsible label="Thinking" hint={summarize(block.text)} defaultOpen={defaultOpen}>
          {block.text}
        </Collapsible>
      );

    case "tool_use":
      return <ToolCard block={block} defaultOpen={defaultOpen} beforeMap={beforeMap} />;

    case "error":
      return (
        <div className="flex items-start gap-1.5 rounded-md border border-danger bg-danger/30 px-3 py-2 text-danger [font-size:var(--chat-fs-sm)]">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{block.message}</span>
        </div>
      );
  }
}

/** Dispatcher for tool_use blocks. Edit and Write get dedicated renderers
 *  (diff + content preview) because their input shape is rich enough to
 *  deserve more than a JSON dump. Everything else falls through to the
 *  generic ToolCard. `defaultOpen` lets the parent ToolGroup force all
 *  contained cards to render their body at once. */
function ToolCard({
  block,
  defaultOpen = false,
  beforeMap,
}: {
  block: Extract<Block, { kind: "tool_use" }>;
  defaultOpen?: boolean;
  beforeMap?: BeforeContentMap;
}) {
  if (block.toolName === "Edit" && isEditInput(block.input)) {
    return (
      <EditToolCard
        filePath={block.input.file_path}
        oldString={block.input.old_string}
        newString={block.input.new_string}
        status={block.status}
        result={block.result}
        defaultOpen={defaultOpen}
      />
    );
  }
  if (block.toolName === "Write" && isWriteInput(block.input)) {
    return (
      <WriteToolCard
        filePath={block.input.file_path}
        content={block.input.content}
        status={block.status}
        result={block.result}
        defaultOpen={defaultOpen}
        beforeMap={beforeMap}
      />
    );
  }
  return <GenericToolCard block={block} defaultOpen={defaultOpen} />;
}

/** Edit tool card: line-level diff view, collapsed by default. */
function EditToolCard({
  filePath,
  oldString,
  newString,
  status,
  result,
  defaultOpen = false,
}: {
  filePath: string;
  oldString: string;
  newString: string;
  status: "running" | "done" | "error";
  result?: unknown;
  defaultOpen?: boolean;
}) {
  // Seed the open state from defaultOpen so ToolGroup can force-open all
  // children on group expand. The card's own state still wins after
  // first render (user can collapse an individual card even inside an
  // open group).
  const [open, setOpen] = useState(defaultOpen);
  const diff = useMemo(() => lineDiff(oldString, newString), [oldString, newString]);
  const { adds, dels } = useMemo(() => diffSummary(diff), [diff]);

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={status} />
        <span className="font-medium text-content-muted">Edit</span>
        <span className="truncate font-mono text-content-subtle">{filePath}</span>
        <span className="ml-auto flex items-center gap-1.5 [font-size:var(--chat-fs-xxs)]">
          {adds > 0 && <span className="text-accent">+{adds}</span>}
          {dels > 0 && <span className="text-danger">−{dels}</span>}
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 py-2 px-1">
          <DiffView diff={diff} />
          {result !== undefined && (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">Result</div>
              <pre className="max-h-40 overflow-auto rounded bg-surface/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
                {truncateResult(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Write tool card: shows the new file content preview. No diff because
 *  Write is a full-file replace. Collapsed by default like the other cards —
 *  the user expands to see the content preview. */
function WriteToolCard({
  filePath,
  content,
  status,
  result,
  defaultOpen = false,
  beforeMap,
}: {
  filePath: string;
  content: string;
  status: "running" | "done" | "error";
  result?: unknown;
  defaultOpen?: boolean;
  beforeMap?: BeforeContentMap;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const lineCount = content ? content.split("\n").length : 0;

  // Look up the pre-turn content for this file. The turn.files payload
  // carries absolute paths, but the Write tool's file_path may be relative
  // — try an exact match first, then a suffix match (absolute path ending
  // with the given path segments). Undefined → no before available (turn
  // still running, or file is brand-new), and we fall back to a plain
  // new-content preview instead of a diff.
  const before = useMemo(() => {
    if (!beforeMap || beforeMap.size === 0) return undefined;
    if (beforeMap.has(filePath)) return beforeMap.get(filePath);
    for (const [abs, b] of beforeMap) {
      if (abs === filePath || abs.endsWith(filePath)) return b;
    }
    return undefined;
  }, [beforeMap, filePath]);

  // Diff old (pre-turn on-disk) vs new (Write input). Recomputed only when
  // the inputs actually change. When `before` is undefined we render the
  // raw new content preview instead.
  const diff = useMemo(() => (before !== undefined ? lineDiff(before, content) : null), [before, content]);
  const { adds, dels } = useMemo(() => (diff ? diffSummary(diff) : { adds: 0, dels: 0 }), [diff]);

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={status} />
        <span className="font-medium text-content-muted">Write</span>
        <span className="truncate font-mono text-content-subtle">{filePath}</span>
        <span className="ml-auto flex items-center gap-1.5 [font-size:var(--chat-fs-xxs)]">
          {diff && adds > 0 && <span className="text-accent">+{adds}</span>}
          {diff && dels > 0 && <span className="text-danger">−{dels}</span>}
          {!diff && <span className="text-content-subtle">{lineCount} 行</span>}
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 py-2 px-1">
          {diff ? (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">
                {before === "" ? "New file" : "Diff vs pre-turn"}
              </div>
              <DiffView diff={diff} />
            </div>
          ) : (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">New file content</div>
              <pre className="max-h-80 overflow-auto rounded bg-surface/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
                {content || "(empty)"}
              </pre>
            </div>
          )}
          {result !== undefined && (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">Result</div>
              <pre className="max-h-40 overflow-auto rounded bg-surface/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
                {truncateResult(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Generic tool card for everything not Edit/Write (Bash, Read, Grep…). */
function GenericToolCard({
  block,
  defaultOpen = false,
}: {
  block: Extract<Block, { kind: "tool_use" }>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={block.status} />
        <span className="font-medium text-content-muted">{block.toolName}</span>
        <span className="truncate text-content-subtle">{toolSummary(block.toolName, block.input)}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="space-y-2 py-2 px-1">
          <div>
            <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">Input</div>
            <pre className="overflow-x-auto rounded bg-surface/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
              {safeStringify(block.input)}
            </pre>
          </div>
          {block.result !== undefined && (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">Result</div>
              <pre className="max-h-60 overflow-auto rounded bg-surface/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
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
function Collapsible({
  label,
  hint,
  defaultOpen = false,
  children,
}: {
  label: string;
  hint: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1.5 text-left text-content-muted hover:bg-surface-muted/40"
      >
        <Chevron open={open} />
        <span className="font-medium text-content-muted">{label}</span>
        <span className="ml-1 truncate text-content-subtle">{hint}</span>
      </button>
      {open && (
        <div className="py-2 px-1 text-content-muted">
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

/* ─── type guards ───
 * Edit and Write have well-known input shapes from the Claude Agent SDK
 * (verified against docs/claude-stream-json.md). We narrow the generic
 * `unknown` Block input here so EditToolCard/WriteToolCard can render
 * structured content instead of falling back to the JSON dump. */

/** Edit tool input: { file_path, old_string, new_string }. */
function isEditInput(
  i: unknown,
): i is { file_path: string; old_string: string; new_string: string } {
  if (!i || typeof i !== "object") return false;
  const o = i as Record<string, unknown>;
  return (
    typeof o.file_path === "string" &&
    typeof o.old_string === "string" &&
    typeof o.new_string === "string"
  );
}

/** Write tool input: { file_path, content }. */
function isWriteInput(i: unknown): i is { file_path: string; content: string } {
  if (!i || typeof i !== "object") return false;
  const o = i as Record<string, unknown>;
  return typeof o.file_path === "string" && typeof o.content === "string";
}
