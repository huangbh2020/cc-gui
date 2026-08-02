import { memo, useState, useMemo, useEffect, useDeferredValue, type ReactNode, type ComponentType } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconChevronDown,
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconTools,
  IconClipboard,
  IconFile,
  IconCopy,
  // Tool-kind icons (left glyph of each action card).
  IconBulb,
  IconTerminal,
  IconFileSearch,
  IconFilePlus,
  IconReplace,
  IconNotebook,
  IconSearch,
  IconListCheck,
  IconRobot,
  IconWorldWww,
  IconWorldSearch,
  IconHelpCircle,
} from "@renderer/lib/icons.js";
import { useNow } from "@renderer/hooks/useNow.js";
import type { Block, TurnMeta } from "@renderer/stores/sessionStore.js";
import { Markdown } from "./Markdown.js";
import { DiffView } from "./DiffView.js";
import { PlanStreamBlock } from "./PlanStreamBlock.js";
import { TurnFilesCard } from "./TurnFilesCard.js";
import { CurrentOpTicker } from "./CurrentOpTicker.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";

/** Map of absolute file path → its pre-turn content. Built from the
 *  `turn.files` event payload so the Write tool card can diff the new
 *  `input.content` against what was on disk before the turn. Empty when
 *  the turn is still running (no turn.files yet) or after a rewind — in
 *  those cases Write falls back to a plain new-content preview. */
export type BeforeContentMap = Map<string, string>;

/** Render the content blocks of a message.
 *
 *  In the turn-level aggregation model (ChatPane's `groupMessagesForRender`),
 *  a turn is split into a `TurnPanel` (all thinking + tool calls) and one or
 *  more "text messages" carrying only display blocks (text / plan /
 *  turn-files / error / attachment). MessageBlocks renders those display
 *  messages; the procedural surface is owned by TurnPanel.
 *
 *  A residual `groupBlocks` defense is kept: if a stray thinking/tool_use
 *  block ever reaches this path (legacy data, future invariant drift), it
 *  still collapses into a TurnPanel instead of polluting the prose stream. */
const MessageBlocks = memo(function MessageBlocks({
  blocks,
  beforeMap,
  isStreamingTail,
  onOpenPlan,
}: {
  blocks: Block[];
  /** Pre-turn file contents for Write-tool diffing. Forwarded down to any
   * procedural group rendered inside this message (the single-message
   * path - the cluster path in ChatPane passes beforeMap directly to
   * TurnPanel). */
  beforeMap?: BeforeContentMap;
  /** When true, this message is the last one in the stream and is still
   * receiving content deltas. Instructs text blocks to skip expensive
   * Markdown parsing and render as raw text until streaming settles. */
  isStreamingTail?: boolean;
  /** Called when the user clicks an inline plan block - opens the right-side
   *  PlanDrawer with that plan's full markdown content. Forwarded to
   *  PlanStreamBlock via BlockView. */
  onOpenPlan?: (plan: string) => void;
}) {
  if (blocks.length === 0) return null;
  const segments = groupBlocks(blocks);
  return (
    <div className="space-y-2">
      {segments.map((seg, i) =>
        seg.kind === "single" ? (
          <BlockView key={i} block={seg.block} defaultOpen={seg.defaultOpen} beforeMap={beforeMap} isStreamingTail={isStreamingTail} onOpenPlan={onOpenPlan} />
        ) : (
          <TurnPanel key={i} blocks={seg.blocks} beforeMap={beforeMap} turnActive={isStreamingTail} onOpenPlan={onOpenPlan} />
        ),
      )}
    </div>
  );
});
export { MessageBlocks };

export type ToolUseBlock = Extract<Block, { kind: "tool_use" }>;
export type ThinkingBlock = Extract<Block, { kind: "thinking" }>;
/** Procedural blocks are the "model action" surface — thinking and tool
 *  calls. They get grouped together so a turn that thinks + fires off N
 *  tools reads as one compact card, not a wall of cards. */
export type ProceduralBlock = ThinkingBlock | ToolUseBlock;
type Segment =
  | { kind: "single"; block: Block; defaultOpen?: boolean }
  | { kind: "procedural"; blocks: ProceduralBlock[] };

/** File-mutating tool calls (Edit / Write) render INLINE in the stream
 *  (collapsed by default), bypassing the "思考 + N 个操作" procedural-group
 *  collapse. Keeping them flat makes the actual file changes scannable as a
 *  one-line summary (+N -M) without burying the prose stream under diff
 *  bodies. Write gets the same treatment so a new/overwritten file is its
 *  own visible card rather than buried inside a group. */
function isInlineFileBlock(b: Block): boolean {
  return b.kind === "tool_use" && (b.toolName === "Edit" || b.toolName === "Write");
}

/** Linear scan: collect consecutive thinking / tool_use blocks into a run.
 *  Any text or error block flushes the run (and renders as its own segment).
 *  Edit / Write tool calls are pulled OUT of the run and emitted as their
 *  own single segment (collapsed) so their diff / content is available inline
 *  but doesn't dominate the stream. Even a single non-file tool_use with no
 *  surrounding text becomes a procedural group — that's the whole point:
 *  keep the prose stream clean. */
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
    if (isInlineFileBlock(b)) {
      // An inline Edit/Write breaks the procedural run: flush whatever has
      // accumulated, then emit the file tool as a standalone collapsed segment.
      flush();
      out.push({ kind: "single", block: b, defaultOpen: false });
    } else if (b.kind === "thinking" || b.kind === "tool_use") {
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

/** Status icon for tool calls: error→X, running/done→nothing. Running and
 *  done are the common states and don't need a glyph — when the status is
 *  empty the card's own tool icon occupies this slot, and the stream's
 *  single loading indicator already lives at the bottom (isStreamingTail
 *  spinner). Per-card spinners would only add noise, so only surface a glyph
 *  when something actually went wrong. */
function StatusIcon({ status }: { status: "running" | "done" | "error" }) {
  if (status === "error") {
    return <IconX size={12} className="text-danger" />;
  }
  return null;
}

/** A compact collapsible card for a run of consecutive procedural blocks
 *  (thinking + non-file tool calls) INSIDE an expanded TurnPanel. Mirrors the
 *  original pre-turn-aggregation "思考 + N 个操作" group: one summary line
 *  when collapsed, each child (thinking / tool card) folded underneath when
 *  expanded. File-mutating tools (Edit / Write) never land here — they're
 *  pulled out by groupBlocks to render as their own inline cards. */
function ProceduralRunCard({
  blocks,
  beforeMap,
  defaultOpen = false,
}: {
  blocks: ProceduralBlock[];
  beforeMap?: BeforeContentMap;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toolBlocks = blocks.filter((b): b is ToolUseBlock => b.kind === "tool_use");
  const thinkingCount = blocks.filter((b) => b.kind === "thinking").length;

  const aggregateStatus: "running" | "done" | "error" = toolBlocks.some((b) => b.status === "running")
    ? "running"
    : toolBlocks.some((b) => b.status === "error")
      ? "error"
      : "done";

  // Tool-name tally in first-invocation order.
  const counts = new Map<string, number>();
  for (const b of toolBlocks) counts.set(b.toolName, (counts.get(b.toolName) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([n, c]) => `${n} ×${c}`).join(" · ");

  const label =
    thinkingCount > 0 && toolBlocks.length > 0
      ? `思考 + ${toolBlocks.length} 个操作`
      : toolBlocks.length > 0
        ? `${toolBlocks.length} 个操作`
        : "思考";

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted/40"
      >
        {aggregateStatus === "done" ? (
          <IconCheck size={12} className="shrink-0 text-accent" />
        ) : (
          <StatusIcon status={aggregateStatus} />
        )}
        <span className="font-medium text-content-muted">{label}</span>
        {breakdown && <span className="truncate text-content-subtle">{breakdown}</span>}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="space-y-1.5 py-1 pl-4">
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} beforeMap={beforeMap} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Render the body of an expanded TurnPanel: run groupBlocks over the panel's
 *  blocks and emit each segment — procedural runs collapse into a
 *  ProceduralRunCard, file tools (Edit/Write) and text render as standalone
 *  inline blocks. This restores the pre-aggregation grouping behavior inside
 *  the panel.
 *
 *  Procedural run cards ALWAYS default to collapsed — the outer TurnPanel is
 *  what opens/closes with the turn lifecycle; the run cards inside are a
 *  drill-down the user opens on demand. `live` is unused for collapse but
 *  kept on the signature for callers that pass it. */
function PanelBody({
  blocks,
  beforeMap,
  onOpenPlan,
}: {
  blocks: Block[];
  beforeMap?: BeforeContentMap;
  onOpenPlan?: (plan: string) => void;
}) {
  const segments = groupBlocks(blocks);
  return (
    <div className="space-y-1.5">
      {segments.map((seg, i) =>
        seg.kind === "single" ? (
          <BlockView
            key={i}
            block={seg.block}
            defaultOpen={seg.defaultOpen}
            beforeMap={beforeMap}
            onOpenPlan={onOpenPlan}
          />
        ) : (
          <ProceduralRunCard key={i} blocks={seg.blocks} beforeMap={beforeMap} />
        ),
      )}
    </div>
  );
}

/** Collapsible panel that hides a whole turn's process data (thinking +
 *  tool calls + any text the model emitted between tool calls, like "let me
 *  read this file first") behind a one-line "开始 HH:MM:SS · 用时 NN.Ns"
 *  header. This is the boundary between "model process" and "model output
 *  for the user": everything up to and including the last tool call lives
 *  inside this panel, while only the final reply text (after the last tool)
 *  renders outside it and stays visible.
 *
 *  - While the turn is still running (turnMeta.endedAt undefined) the panel
 *    stays OPEN by default so the user can watch the model work; the header
 *    shows a live-ticking duration. `turnActive` additionally drives the live
 *    "current operation" ticker inside the expanded body.
 *  - The panel collapses ONLY when the turn ends (turn.done sets endedAt) —
 *    not when the final reply text starts streaming. The user can still
 *    re-expand by clicking.
 *  - The header is minimal: just "开始 HH:MM:SS · 用时 NN.Ns". An error
 *    anywhere in the turn surfaces an X before the label; running/completed
 *    states show no glyph (the live duration and the chevron already carry
 *    the state). */
export function TurnPanel({
  blocks,
  beforeMap,
  turnActive = false,
  turnMeta,
  onOpenPlan,
}: {
  /** The turn's process blocks in order: thinking, tool calls, and any text
   *  the model produced between tools. Text blocks are rendered inline inside
   *  the expanded panel (as process narration), NOT as the user-facing reply. */
  blocks: Block[];
  /** Pre-turn file contents for Write-tool diffing. Forwarded down to
   *  WriteToolCard so diffs render inside the expanded panel. */
  beforeMap?: BeforeContentMap;
  /** Whether this turn is the live streaming tail. Drives the "current
   *  operation" ticker inside the expanded body (shows what the model is
   *  doing right now). Does NOT control collapse — that's tied to
   *  turnMeta.endedAt so the panel stays open for the whole run. */
  turnActive?: boolean;
  /** The turn's timing metadata. `startedAt` feeds the header clock and the
   *  duration baseline; `endedAt` undefined means the turn is still running
   *  (duration ticks live via useNow). */
  turnMeta?: TurnMeta;
  /** Forwarded to BlockView for plan blocks (opens the PlanDrawer). */
  onOpenPlan?: (plan: string) => void;
}) {
  const completed = turnMeta?.endedAt !== undefined;
  // The panel defaults OPEN while the turn is still running (so the user can
  // watch the model work) and collapses only once the turn ends (turn.done).
  // Initial state follows `completed` so a freshly mounted running turn opens
  // and a historical (ended) turn starts collapsed. LegendList recycles/
  // remounts items during streaming — re-mounting a running turn re-seeds
  // open=true, keeping the process visible throughout.
  const [open, setOpen] = useState(!completed);

  // Collapse exactly when the turn ends (the false→true transition of
  // `completed`), regardless of whether the final reply text has started
  // streaming. The user can still re-expand by clicking.
  useEffect(() => {
    if (completed) setOpen(false);
  }, [completed]);

  const toolBlocks = blocks.filter((b): b is ToolUseBlock => b.kind === "tool_use");

  // Aggregate status: any running → running; else any error → error; else done.
  const aggregateStatus: "running" | "done" | "error" = toolBlocks.some((b) => b.status === "running")
    ? "running"
    : toolBlocks.some((b) => b.status === "error")
      ? "error"
      : "done";

  // The newest tool currently executing inside this panel (drives the ticker).
  const runningTool = useMemo(() => {
    for (let i = toolBlocks.length - 1; i >= 0; i--) {
      if (toolBlocks[i].status === "running") return toolBlocks[i];
    }
    return null;
  }, [toolBlocks]);

  // Live duration via the app-wide 1s clock. Frozen turns compute a static
  // value (endedAt - startedAt) and the useNow subscription is harmless
  // (returns the same value every tick). This mirrors TurnStatRow's approach.
  const now = useNow();
  const startedAt = turnMeta?.startedAt ?? now;
  const duration = Math.max(0, (turnMeta?.endedAt ?? now) - startedAt);
  const live = turnMeta?.endedAt === undefined;

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 border-b border-edge py-1.5 text-left text-[13px] text-content-subtle hover:bg-surface-muted/40"
      >
        {aggregateStatus === "error" && <IconX size={12} className="shrink-0 text-danger" />}
        <span>开始</span>
        <span className="tabular-nums text-content-muted">{fmtClock(startedAt)}</span>
        <span className="text-content-subtle">·</span>
        <span>用时</span>
        <span className="tabular-nums text-content-muted">{fmtDuration(duration)}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="space-y-1.5 py-2 pl-5">
          {/* While streaming, surface the current operation as a live ticker
              above the grouped body so the user sees what's happening now. */}
          {live && runningTool && (
            <div className="flex items-center gap-1.5 border-b border-edge pb-1 text-[11px] text-content-subtle">
              <CurrentOpTicker op={runningTool} turnActive={turnActive} />
            </div>
          )}
          <PanelBody blocks={blocks} beforeMap={beforeMap} onOpenPlan={onOpenPlan} />
        </div>
      )}
    </div>
  );
}

const BlockView = memo(function BlockView({
  block,
  defaultOpen = false,
  beforeMap,
  isStreamingTail,
  onOpenPlan,
}: {
  block: Block;
  defaultOpen?: boolean;
  beforeMap?: BeforeContentMap;
  /** Formerly drove a raw-text short-circuit for the streaming tail; now
   *  unused by the text branch (markdown renders progressively via
   *  useDeferredValue instead). Kept on the signature for interface
   *  stability - MessageBlocks still forwards it down. */
  isStreamingTail?: boolean;
  /** Forwarded to PlanStreamBlock - opens the PlanDrawer on click. */
  onOpenPlan?: (plan: string) => void;
}) {
  switch (block.kind) {
    case "text": {
      // useDeferredValue throttles the markdown re-parse: `block.text` updates
      // every delta (~60 Hz) but `deferredText` only advances when React has
      // idle time, so <Markdown> (memoized) re-renders at a paced cadence
      // instead of every frame. Markdown thus appears PROGRESSIVELY during
      // streaming and converges naturally when the turn ends - no more
      // "raw text until done, then flip to markdown" delay.
      //
      // We deliberately no longer fall back to whitespace-pre-wrap while
      // streaming (the old `isStreamingTail || isStale` short-circuit): that
      // held the whole message as plain text for the entire turn, which is
      // what users perceived as "markdown rendering lag". Shiki highlighting
      // of code blocks is itself deferred inside <Markdown> (lazy highlighter
      // singleton + LRU cache + useMemo on rawCode), so the expensive path is
      // already guarded without sacrificing live markdown formatting.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const deferredText = useDeferredValue(block.text);
      return <Markdown>{deferredText}</Markdown>;
    }

    case "thinking":
      return (
        <Collapsible label="Thinking" hint={summarize(block.text)} defaultOpen={defaultOpen}>
          {block.text}
        </Collapsible>
      );

    case "tool_use":
      return <ToolCard block={block} defaultOpen={defaultOpen} beforeMap={beforeMap} />;

    case "attachment":
      return (
        <AttachmentCard
          preview={block.preview}
          content={block.content}
          attachmentKind={block.attachmentKind}
          filePath={block.filePath}
        />
      );;

    case "error":
      return (
        <div className="flex items-start gap-1.5 rounded-md border border-danger bg-danger/30 px-3 py-2 text-danger [font-size:var(--chat-fs-sm)]">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{block.message}</span>
        </div>
      );

    case "plan":
      // Inline read-only plan card that lives in the message stream as a
      // per-turn trailing block (drafting -> 待审阅 -> 已就绪). Clicking it
      // opens the right-side PlanDrawer to view the full plan content; the
      // actionable approve/reject sheet stays above the composer in
      // PlanApprovalPrompt.
      return (
        <PlanStreamBlock
          plan={block.plan}
          phase={block.phase}
          hasApproval={block.hasApproval}
          onOpenPlan={onOpenPlan}
        />
      );

    case "turn-files":
      // Inline "本轮修改" card that lives in the message stream as a per-turn
      // trailing block. Frozen at turn.done so each turn keeps its own card in
      // history (new turns add new cards; old cards stay read-only). Only the
      // LATEST turn's card (isLatestTurn) shows the 撤销本轮 button; older
      // cards are display-only snapshots. TurnFilesCard pulls rewindTurn from
      // the store itself and gates the button on isLatestTurn.
      return (
        <TurnFilesCard files={block.files} isLatestTurn={block.isLatestTurn} />
      );
  }
});
export { BlockView };

/** A pasted-content or file-reference attachment shown as a chip-like card in
 *  the message stream. Mirrors the composer's ContentTagChip visual language
 *  (accent theme color) so an attachment reads the same before and after
 *  sending.
 *
 *  - Paste attachments (attachmentKind="paste" or undefined): clipboard icon,
 *    collapsed = one-line preview, expanded = full content + Copy button.
 *  - File attachments (attachmentKind="file"): file icon, collapsed = file
 *    name, expanded = the full file path (the `@path` reference sent to the
 *    model). No Copy button — a path is short enough to read inline.
 *
 *  Unlike the composer's TagPopover (fixed-positioned to the chip), this
 *  expands inline — the message stream is the stable anchor here, so a
 *  floating popover would be fragile on scroll. */
function AttachmentCard({
  preview,
  content,
  attachmentKind,
  filePath,
}: {
  preview: string;
  content: string;
  attachmentKind?: "paste" | "file";
  filePath?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isFile = attachmentKind === "file";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (sandbox) — silently no-op
    }
  };

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={() => setOpen((v) => !v)}
        title={isFile ? (filePath ?? preview) : open ? "收起内容" : "查看内容"}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
          open
            ? "border-accent bg-accent/20 text-accent"
            : "border-accent/40 bg-accent/10 text-accent hover:border-accent/70 hover:bg-accent/20",
        )}
      >
        {isFile ? (
          <IconFile size={12} className="opacity-80" />
        ) : (
          <IconClipboard size={12} className="opacity-80" />
        )}
        <span className="max-w-[220px] truncate font-normal">{preview}</span>
        <IconChevronDown
          size={11}
          className={cn("shrink-0 opacity-70 transition-transform", !open && "-rotate-90")}
        />
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {!isFile && (
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-accent transition-colors hover:bg-accent/30"
                title="复制完整内容"
              >
                {copied ? (
                  <>
                    <IconCheck size={11} /> 已复制
                  </>
                ) : (
                  <>
                    <IconCopy size={11} /> Copy
                  </>
                )}
              </button>
            </div>
          )}
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-surface/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
            {isFile ? (filePath ?? content) : content}
          </pre>
        </div>
      )}
    </div>
  );
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

/** Edit tool card: line-level diff view. Inside an expanded TurnPanel it
 *  defaults to collapsed (`defaultOpen` false); the user clicks to inspect
 *  the diff. The header stays clickable so an individual edit can still be
 *  folded away. */
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
        <ToolIcon name="Edit" className="text-content-subtle" />
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
        <ToolIcon name="Write" className="text-content-subtle" />
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
        <ToolIcon name={block.toolName} className="text-content-subtle" />
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
        <IconBulb size={13} className="shrink-0 text-content-subtle" />
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

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). Mirrors the
 *  same-named helper in ChatPane — duplicated here so TurnPanel is
 *  self-contained (ChatPane will stop rendering TurnStatRow above the
 *  panel, so the formatting ownership moves into the panel header). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a duration (ms) compactly: <1s → "<1s", <60s → "12.3s",
 *  <60m → "1m 23s", else → "1h 05m". Mirrors ChatPane's helper. */
function fmtDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}

/** Resolve a left-glyph icon for a tool-use block by its name. Unknown names
 *  (incl. MCP `mcp__*` tools) fall back to the generic toolbox (`IconTools`).
 *
 *  Mapping rationale:
 *   - Read / Glob   -> file-search (looking up files by path or pattern)
 *   - Write         -> file-plus  (creating / overwriting a file)
 *   - Edit          -> replace    (string-replace edit)
 *   - MultiEdit     -> replace    (batched string-replace edits)
 *   - NotebookEdit  -> notebook   (Jupyter notebook edit)
 *   - Bash / shell  -> terminal   (command shell)
 *   - Grep          -> search     (content search)
 *   - TodoWrite et al -> list-check (task list)
 *   - Task          -> robot      (subagent spawn)
 *   - WebSearch     -> world-search
 *   - WebFetch      -> world      (fetch a URL)
 *   - AskUserQuestion -> help-circle
 *   - Enter/ExitPlanMode -> clipboard (matches the plan card glyph)
 *   - default       -> tools      (generic) */
const TOOL_ICON_MAP: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  Read: IconFileSearch,
  Glob: IconFileSearch,
  Write: IconFilePlus,
  Edit: IconReplace,
  MultiEdit: IconReplace,
  NotebookEdit: IconNotebook,
  Bash: IconTerminal,
  PowerShell: IconTerminal,
  Grep: IconSearch,
  TodoWrite: IconListCheck,
  TaskCreate: IconListCheck,
  TaskUpdate: IconListCheck,
  Task: IconRobot,
  WebSearch: IconWorldSearch,
  WebFetch: IconWorldWww,
  AskUserQuestion: IconHelpCircle,
  EnterPlanMode: IconClipboard,
  ExitPlanMode: IconClipboard,
};

/** The left-side glyph of an action card. Sized 13 to sit between the 12px
 *  status icon and the label without dominating the row. Exported so the
 *  current-operation ticker (CurrentOpTicker) can reuse the same
 *  icon mapping instead of duplicating it. */
export function ToolIcon({ name, className }: { name: string; className?: string }) {
  const Icon = TOOL_ICON_MAP[name] ?? IconTools;
  return <Icon size={13} className={cn("shrink-0", className)} />;
}

/** A one-line hint for common tools (Read/Edit/Bash etc.) shown on the card header.
 *  Exported for reuse by the floating "current operation" card. */
export function toolSummary(name: string, input: unknown): string {
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
