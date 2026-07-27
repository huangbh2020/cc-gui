import { useState, useMemo, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconCheck,
  IconX,
  IconLoader2,
  IconClock,
  IconAlertTriangle,
  IconTools,
} from "@renderer/lib/icons.js";
import type { Block } from "@renderer/stores/sessionStore.js";
import { Markdown } from "./Markdown.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";

/** Render the content blocks of a message. */
export function MessageBlocks({ blocks }: { blocks: Block[] }) {
  if (blocks.length === 0) return null;
  // Group consecutive tool_use blocks so a turn that fired off N tool
  // calls doesn't dump N cards into the stream. groupBlocks() splits the
  // block list into "single" segments (one block, no grouping) and
  // "group" segments (a contiguous run of tool_use blocks >= threshold)
  // that render as a single collapsible ToolGroup.
  const segments = groupBlocks(blocks);
  return (
    <div className="space-y-2">
      {segments.map((seg, i) =>
        seg.kind === "single" ? (
          <BlockView key={i} block={seg.block} />
        ) : (
          <ToolGroup key={i} blocks={seg.blocks} />
        ),
      )}
    </div>
  );
}

/** Minimum run length to qualify for grouping. A single tool_use stays
 *  inline (no extra click) — only when 2+ run together do we collapse. */
const TOOL_GROUP_THRESHOLD = 2;

type ToolUseBlock = Extract<Block, { kind: "tool_use" }>;
type Segment = { kind: "single"; block: Block } | { kind: "group"; blocks: ToolUseBlock[] };

/** Linear scan: collect consecutive tool_use blocks into a run. Any
 *  non-tool_use block flushes the run (or emits a single if the run
 *  was just one block). Cross-message grouping is not done — a
 *  message is its own semantic segment, runs don't span messages. */
function groupBlocks(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  let run: ToolUseBlock[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= TOOL_GROUP_THRESHOLD) {
      out.push({ kind: "group", blocks: run });
    } else {
      out.push({ kind: "single", block: run[0] });
    }
    run = [];
  };
  for (const b of blocks) {
    if (b.kind === "tool_use") {
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

/** Summary card for a run of 2+ tool_use blocks. Renders a single
 *  "Claude 进行了 N 个操作 · Bash ×2 · Read ×1" line; expanding forces
 *  every child card open so the user gets the full picture at once
 *  (per the design: 点开才全展开). The per-card state is uncontrolled
 *  (useState) but seeded from `defaultOpen={true}` from the group. */
function ToolGroup({ blocks }: { blocks: ToolUseBlock[] }) {
  const [open, setOpen] = useState(false);
  // Tally toolName occurrences for the breakdown. Map preserves insertion
  // order, so the breakdown reads in the order tools were first invoked.
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.toolName, (counts.get(b.toolName) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([n, c]) => `${n} ×${c}`).join(" · ");

  return (
    <div className="rounded-md border border-edge bg-surface-muted/60 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <IconTools size={14} className="shrink-0 text-content-muted" />
        <span className="font-medium text-content-muted">
          Claude 进行了 {blocks.length} 个操作
        </span>
        <span className="truncate text-content-subtle">{breakdown}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-edge px-3 py-2">
          {/* defaultOpen=true forces each child card to render its body.
              The cards' own useState is seeded with this on first render
              and stays open for the life of the message. */}
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} defaultOpen />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockView({ block, defaultOpen = false }: { block: Block; defaultOpen?: boolean }) {
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
      return <ToolCard block={block} defaultOpen={defaultOpen} />;

    case "error":
      return (
        <div className="flex items-start gap-1.5 rounded-md border border-danger bg-danger/30 px-3 py-2 text-xs text-danger">
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
}: {
  block: Extract<Block, { kind: "tool_use" }>;
  defaultOpen?: boolean;
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
    <div className="rounded-md border border-edge bg-surface-muted/60 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={status} />
        <span className="font-medium text-content-muted">Edit</span>
        <span className="truncate font-mono text-content-subtle">{filePath}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px]">
          {adds > 0 && <span className="text-accent">+{adds}</span>}
          {dels > 0 && <span className="text-danger">−{dels}</span>}
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-edge px-3 py-2">
          <DiffView diff={diff} />
          {result !== undefined && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase text-content-subtle">Result</div>
              <pre className="max-h-40 overflow-auto rounded bg-surface/60 p-2 text-[11px] text-content-muted">
                {truncateResult(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Render a flat diff list as a monospace line column with per-op coloring.
 *  Includes gutter line numbers for old/new so reviewers can correlate
 *  changes. */
function DiffView({ diff }: { diff: ReturnType<typeof lineDiff> }) {
  if (diff.length === 0) {
    return (
      <div className="rounded bg-surface/60 p-2 text-[11px] text-content-subtle">
        (no changes)
      </div>
    );
  }
  // Compute old/new line numbers in a single pass: an inserted line has
  // no old-side number; a deleted line has no new-side; equal lines have
  // both. Numbers give the user a stable "where am I" reference while
  // reviewing the patch.
  const rows = annotateDiffWithLineNumbers(diff);

  return (
    <div className="overflow-x-auto rounded bg-surface/60 font-mono text-[11px] leading-relaxed">
      {rows.map((d, i) => {
        const opBg =
          d.op === "delete"
            ? "bg-danger/15 text-danger"
            : d.op === "insert"
            ? "bg-accent/15 text-accent"
            : "text-content-muted";
        return (
          <div key={i} className={cn("flex items-start whitespace-pre", opBg)}>
            <span className="w-10 shrink-0 select-none border-r border-edge/40 px-1.5 text-right text-content-subtle">
              {d.oldNo ?? ""}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-edge/40 px-1.5 text-right text-content-subtle">
              {d.newNo ?? ""}
            </span>
            <span className="w-3 shrink-0 select-none pl-1 text-content-subtle">
              {d.op === "delete" ? "−" : d.op === "insert" ? "+" : " "}
            </span>
            <span className="flex-1 pl-1 pr-2">{d.text || "\u00A0"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Build a per-line record with old/new line numbers. A single pass keeps
 *  the numbering correct regardless of which side contributes to each
 *  line. The accumulator is local so the function is safe to call from
 *  any render without stateful side effects. */
function annotateDiffWithLineNumbers(
  diff: ReturnType<typeof lineDiff>,
): Array<ReturnType<typeof lineDiff>[number] & { oldNo: number | null; newNo: number | null }> {
  let oldNo = 0;
  let newNo = 0;
  return diff.map((d) => {
    const oldN = d.op === "insert" ? null : ++oldNo;
    const newN = d.op === "delete" ? null : ++newNo;
    return { ...d, oldNo: oldN, newNo: newN };
  });
}

/** Write tool card: shows the new file content preview. No diff because
 *  Write is a full-file replace. defaultOpen lets ToolGroup expand all
 *  contained cards together; standalone (no group) keeps the prior
 *  behavior of opening the body so the content preview is the story. */
function WriteToolCard({
  filePath,
  content,
  status,
  result,
  defaultOpen = true,
}: {
  filePath: string;
  content: string;
  status: "running" | "done" | "error";
  result?: unknown;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const lineCount = content ? content.split("\n").length : 0;

  return (
    <div className="rounded-md border border-edge bg-surface-muted/60 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={status} />
        <span className="font-medium text-content-muted">Write</span>
        <span className="truncate font-mono text-content-subtle">{filePath}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-content-subtle">
          {lineCount} 行
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-edge px-3 py-2">
          <div>
            <div className="mb-0.5 text-[10px] uppercase text-content-subtle">New file content</div>
            <pre className="max-h-80 overflow-auto rounded bg-surface/60 p-2 text-[11px] text-content-muted">
              {content || "(empty)"}
            </pre>
          </div>
          {result !== undefined && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase text-content-subtle">Result</div>
              <pre className="max-h-40 overflow-auto rounded bg-surface/60 p-2 text-[11px] text-content-muted">
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
    <div className="rounded-md border border-edge bg-surface-muted/60 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={block.status} />
        <span className="font-medium text-content-muted">{block.toolName}</span>
        <span className="truncate text-content-subtle">{toolSummary(block.toolName, block.input)}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-edge px-3 py-2">
          <div>
            <div className="mb-0.5 text-[10px] uppercase text-content-subtle">Input</div>
            <pre className="overflow-x-auto rounded bg-surface/60 p-2 text-[11px] text-content-muted">
              {safeStringify(block.input)}
            </pre>
          </div>
          {block.result !== undefined && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase text-content-subtle">Result</div>
              <pre className="max-h-60 overflow-auto rounded bg-surface/60 p-2 text-[11px] text-content-muted">
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
    <div className="rounded-md border border-edge bg-surface/40 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-content-muted hover:bg-surface-muted/40"
      >
        <Chevron open={open} />
        <span className="font-medium text-content-muted">{label}</span>
        <span className="ml-1 truncate text-content-subtle">{hint}</span>
      </button>
      {open && (
        <div className="border-t border-edge px-3 py-2 text-content-muted">
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
