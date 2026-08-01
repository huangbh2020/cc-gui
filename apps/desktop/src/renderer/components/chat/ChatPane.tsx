import { useState, useRef, useEffect, useMemo, memo, useCallback } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconPlayerStop,
  IconSend2,
  IconChevronDown,
  IconArrowDown,
  IconAlertTriangle,
  IconSettings,
  IconArrowRight,
  IconCopy,
  IconCheck,
  IconLoader2,
  IconPaperclip,
  IconX,
  IconPencil,
} from "@renderer/lib/icons.js";
import { useSessionStore, EMPTY_MESSAGES, EMPTY_TODOS, EMPTY_SUBAGENTS, EMPTY_CHAT_QUEUE, EMPTY_PROMPT_QUEUE, type Block, type ChatMessage, type TodoItem, type TurnMeta, type QueuedPrompt } from "@renderer/stores/sessionStore.js";
import { useNow } from "@renderer/hooks/useNow.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { PermissionMode } from "@contracts/runtime";
import type { FileSearchEntry } from "@contracts/ipc";
import {
  type ContentTag,
  appendUniqueFileTags,
  composePromptWithTags,
  makeContentTag,
  makeFileTag,
  shouldPromoteToTag,
  FILE_DRAG_MIME,
} from "@renderer/lib/contentTag.js";
import {
  executeSlashCommand,
  type SlashCommandContext,
} from "@renderer/lib/slashCommands.js";
import { MessageBlocks, ProceduralGroup, type ProceduralBlock, type BeforeContentMap } from "./MessageBlocks.js";
import { ComposerToolbar } from "./ComposerToolbar.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { ApprovalPrompt } from "./ApprovalPrompt.js";
import { PlanApprovalPrompt } from "./PlanApprovalPrompt.js";
import { ContentTagChip } from "./ContentTagChip.js";
import { TagPopover } from "./TagPopover.js";
import { FileMentionPicker, type FileMentionPickerMode } from "./FileMentionPicker.js";
import { ProjectBranchIndicator } from "./ProjectBranchIndicator.js";
import { EmptyThreadWelcome } from "./EmptyThreadWelcome.js";
import { SlashCommandPicker } from "./SlashCommandPicker.js";
import { StatusCapsule } from "./StatusCapsule.js";
import { PlanDrawer } from "./PlanDrawer.js";
import { MessageTimeline, type UserItemIndexMap } from "./MessageTimeline.js";
import { LegendList, type LegendListRef } from "@legendapp/list/react";

/**
 * Center pane: message stream + input box for a SINGLE session.
 *
 * The component receives its target sessionId as a prop so the same
 * instance type can be reused under different render strategies
 * (currently the active session only, but the signature is ready for
 * multiple simultaneous mounts if we ever want to keep hidden tabs
 * alive). All per-session state is read by keying into the store's
 * per-session buckets with this prop — no `activeSessionId` lookups
 * inside the component, so the running turn / composer / scroll
 * position are all 100% bound to this sessionId.
 */

/** 第一条消息与顶部(标签条 / 标题栏)之间的留白。作为滚动内容的顶部
 *  padding,停在顶部时可见,向下滚动后随内容滚走。 */
const MESSAGE_LIST_TOP_PADDING = 10;

/** Distance from the bottom (px) under which the list is considered "at the
 *  bottom" - the jump-to-bottom button is hidden, and new content auto-follows.
 *  The button appears once the user scrolls more than this far below the
 *  latest content, i.e. as soon as they scroll up past one screenful. */
const NEAR_BOTTOM_THRESHOLD = 80;

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a wall-clock ms timestamp as a full local date-time string
 *  "YYYY-MM-DD HH:MM:SS". Used for the user-bubble hover tooltip so the user
 *  can see exactly when a prompt was sent. */
function fmtFullDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a duration (ms) as a compact human string:
 *  < 1s → "<1s", < 60s → "12.3s", < 60m → "1m 23s", else → "1h 05m". */
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

/** Per-turn stat row shown ABOVE the first assistant message of a turn:
 *  "开始 14:32:05 · 用时 12.3s". While the turn is still streaming
 *  (turnMeta.endedAt undefined) the duration ticks live; once the turn ends it
 *  freezes at its final value.
 *
 *  IMPORTANT: the live duration is driven by `useNow` (a single app-wide
 *  1s interval shared via useSyncExternalStore), NOT a component-local
 *  setInterval. This component renders inside a LegendList virtualized item,
 *  and during streaming the list recycles/remounts its containers on nearly
 *  every delta flush. A local setInterval would be torn down by each remount's
 *  cleanup before its first 1000ms tick ever fires - leaving the duration
 *  stuck at "<1s" for the whole turn. The global clock survives remounts.
 *  Rendered larger than the body text and separated from the content below by
 *  a hairline border so it reads as a distinct turn header. */
function TurnStatRow({ meta }: { meta: TurnMeta }) {
  const live = meta.endedAt === undefined;
  // Only subscribe to the global ticker while the turn is still running -
  // frozen turns compute a static duration and pay nothing.
  const now = useNow();
  const end = meta.endedAt ?? now;
  const duration = Math.max(0, end - meta.startedAt);

  return (
    <div className="mb-2 flex items-center gap-1.5 border-b border-edge pb-2 text-[13px] text-content-subtle">
      <span>开始</span>
      <span className="tabular-nums text-content-muted">{fmtClock(meta.startedAt)}</span>
      <span className="text-content-subtle">·</span>
      <span>用时</span>
      <span className="tabular-nums text-content-muted">{fmtDuration(duration)}</span>
      {live && (
        <IconLoader2 size={13} className="ml-0.5 animate-spin text-accent" />
      )}
    </div>
  );
}

/** A "purely procedural" assistant message is one whose blocks are all
 *  thinking and/or tool_use — no text reply, no error. The SDK splits a
 *  single multi-step turn into many such messages (one per content-block
 *  group); without merging they'd each render as a separate "思考 + N 个操作"
 *  card stacked down the stream. We group consecutive ones into a single
 *  cluster so a whole turn reads as one compact card. */
function isProceduralMessage(m: ChatMessage): boolean {
  if (m.role !== "assistant") return false;
  if (m.blocks.length === 0) return false;
  return m.blocks.every((b) => b.kind === "thinking" || b.kind === "tool_use");
}

/** Render item after grouping: either a standalone message (user prompts,
 *  assistant text replies, error bubbles) or a cluster of consecutive
 *  procedural messages that belong to the same turn. The precomputed
 *  isStreamingTail / isTurnTail flags carry the original per-message
 *  semantics into the grouped dimension:
 *  - isStreamingTail: this item is the live streaming end of the running turn.
 *  - isTurnTail: this item is the LAST assistant item of a COMPLETED turn
 *    (the turn ended, and the next item is a user message or the stream end).
 *    Drives the copy button - we only show copy on a finished turn's final
 *    assistant message, not on every intermediate assistant message. */
type RenderItem =
  | {
      kind: "single";
      msg: ChatMessage;
      isStreamingTail: boolean;
      isTurnTail: boolean;
    }
  | {
      kind: "proceduralCluster";
      msgs: ChatMessage[];
      turnMeta?: TurnMeta;
      isStreamingTail: boolean;
      isTurnTail: boolean;
    }
  | {
      // Synthesized "开始 · 用时" row shown between send and the first
      // assistant content block. Not a real message - it's derived in
      // groupMessagesForRender from runningTurnStartedAt so the user sees
      // immediate running feedback (stat row + spinner) before any token
      // lands. Disappears the moment a real assistant turnMeta appears.
      kind: "pendingTurn";
      turnMeta: TurnMeta;
    };

/** Flatten a cluster's messages into a single procedural-block stream for
 *  ProceduralGroup. All members are guaranteed procedural by
 *  isProceduralMessage, so a flat concat yields one contiguous
 *  thinking+tool sequence. */
function flattenCluster(msgs: ChatMessage[]): ProceduralBlock[] {
  const out: ProceduralBlock[] = [];
  for (const m of msgs) {
    for (const b of m.blocks) {
      if (b.kind === "thinking" || b.kind === "tool_use") out.push(b);
    }
  }
  return out;
}

/** Whether the assistant message at index `i` is the tail of a COMPLETED turn:
 *  the turn is not still running (either because a later user message started
 *  a new turn, or because the stream ended and isRunning is false), AND the
 *  next message is not another assistant message of the same turn. In
 *  practice: it's an assistant message followed by a user message, or the
 *  last assistant message when no turn is running. */
function isCompletedTurnTail(
  messages: ChatMessage[],
  i: number,
  isRunning: boolean,
): boolean {
  const m = messages[i];
  if (!m || m.role !== "assistant") return false;
  // If this is the very last message, the turn is completed only when nothing
  // is running.
  if (i === messages.length - 1) return !isRunning;
  // Otherwise the turn is completed when the next message starts a new turn
  // (a user prompt) - the assistant run that ended here is finalized.
  const next = messages[i + 1];
  return next?.role === "user";
}

/** Group the raw message stream into render items, merging consecutive
 *  purely-procedural assistant messages into a single cluster. Pure
 *  function over the message list - no store mutation. */
function groupMessagesForRender(
  messages: ChatMessage[],
  isRunning: boolean,
  /** Send-time anchor (runningTurnStartedAt[sid]) used to synthesize a
   *  pendingTurn row before the first assistant block arrives. Undefined
   *  when no turn is in flight or the anchor wasn't stamped. */
  runningTurnStartedAt?: number,
): RenderItem[] {
  const items: RenderItem[] = [];
  let run: ChatMessage[] = [];

  const flush = () => {
    if (run.length === 0) return;
    // The cluster's tail/last flags follow its LAST member - that's the
    // message that was at the end of the raw stream.
    const lastInRun = run[run.length - 1];
    const tailIndex = messages.indexOf(lastInRun);
    const isStreamingTail =
      isRunning && lastInRun.role === "assistant" && tailIndex === messages.length - 1;
    const isTurnTail =
      lastInRun.role === "assistant" && isCompletedTurnTail(messages, tailIndex, isRunning);
    // turnMeta: take the first member that carries one (the turn-opener).
    const turnMeta = run.find((m) => m.turnMeta)?.turnMeta;
    items.push({
      kind: "proceduralCluster",
      msgs: run,
      turnMeta,
      isStreamingTail,
      isTurnTail,
    });
    run = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isStreamingTail = isRunning && m.role === "assistant" && i === messages.length - 1;
    const isTurnTail = m.role === "assistant" && isCompletedTurnTail(messages, i, isRunning);

    if (isProceduralMessage(m)) {
      run.push(m);
    } else {
      flush();
      items.push({ kind: "single", msg: m, isStreamingTail, isTurnTail });
    }
  }
  flush();

  // Synthesize a pendingTurn row when a turn is in flight but no real
  // assistant content has arrived yet (no open turnMeta exists). This gives
  // the user immediate "开始 · 用时" + spinner feedback right after send,
  // instead of a blank gap until the first token lands. The moment a real
  // assistant message is created (with its own turnMeta), the open-turn
  // check below becomes false and this row stops rendering - the real
  // TurnStatRow takes over with the same startedAt (the isNewTurn sites
  // fall back to runningTurnStartedAt), so timing is continuous.
  if (isRunning && runningTurnStartedAt != null) {
    const hasOpenTurn = messages.some(
      (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
    );
    if (!hasOpenTurn) {
      items.push({
        kind: "pendingTurn",
        turnMeta: { startedAt: runningTurnStartedAt },
      });
    }
  }

  return items;
}

export function ChatPane({ sessionId }: { sessionId: string | null }) {
  // `sessionId` is the prop — store lookups go through it directly, not
  // through `activeSessionId`. The store still tracks `activeSessionId`
  // for global single-slot concerns (model / effort / permissionMode
  // config, sendPrompt target, etc.) and those are kept in sync by the
  // caller (the CenterPane router in App.tsx). `null` means "no session
  // open" — we render the empty-state placeholder and skip all the
  // per-session store reads.
  if (sessionId === null) {
    return <EmptyCenterPane />;
  }
  return <ChatPaneForSession sessionId={sessionId} />;
}

/** Empty-state shown when there's no active session to render (no tabs
 *  open, or the project has no sessions yet). Kept inline so the
 *  CenterPane router can mount a single component without us threading
 *  separate "empty" / "with-session" branches. */
function EmptyCenterPane() {
  const claudeInstalled = useSessionStore((s) => s.claudeInstalled);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        {claudeInstalled === false ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-1.5 text-base font-semibold text-warning">
              <IconAlertTriangle size={18} />
              <span>未检测到 Claude Code CLI</span>
            </div>
            <p className="text-sm text-content-muted">
              请先安装（
              <code className="rounded bg-surface-muted px-1 text-content">npm i -g @anthropic-ai/claude-code</code>
              ），或指定已有的安装路径：
            </p>
            <button
              onClick={() => setSettingsOpen(true)}
              className={cn(
                "inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-sm font-medium text-surface",
                "hover:brightness-110",
              )}
            >
              <IconSettings size={14} />
              配置 CLI 路径
              <IconArrowRight size={14} />
            </button>
          </div>
        ) : (
          <p className="text-base font-medium text-content">打开一个项目并开始会话以继续</p>
        )}
      </div>
    </div>
  );
}

/** The actual per-session chat pane. Extracted into its own function so
 *  the prop-typed parent (ChatPane) can short-circuit on `sessionId ===
 *  null` without forcing every selector to handle the empty case. */
function ChatPaneForSession({ sessionId }: { sessionId: string }) {
  const messages = useSessionStore((s) =>
    s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  // Per-thread "is running" — only true when THIS thread has a turn in flight.
  // A different thread's running turn must not lock the composer here.
  const isRunning = useSessionStore((s) => !!s.runningBySession[sessionId]);
  // Backgrounded subagents may still be running after the parent turn's
  // stream closes (their lifecycle is independent). While any is running we
  // keep the composer locked so the user can't start a competing prompt —
  // the stop button stays available to interrupt.
  const hasRunningSubagents = useSessionStore(
    (s) => (s.subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS).some((a) => a.status === "running"),
  );
  const sessionBusy = isRunning || hasRunningSubagents;
  // Send-time anchor for the synthesized pendingTurn row (see
  // groupMessagesForRender). Subscribed so the row appears the instant
  // sendPrompt stamps it, before any assistant token arrives. Returns
  // undefined when idle - a stable primitive, no referential churn.
  const runningTurnStartedAt = useSessionStore((s) => s.runningTurnStartedAt[sessionId]);
  // Merge consecutive purely-procedural assistant messages (thinking + tool
  // only, no text) into single render clusters so a multi-step turn reads
  // as one compact "思考 + N 个操作" card instead of N stacked cards.
  const renderItems = useMemo(
    () => groupMessagesForRender(messages, isRunning, runningTurnStartedAt),
    [messages, isRunning, runningTurnStartedAt],
  );
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const interrupt = useSessionStore((s) => s.interrupt);
  const editAndResendMessage = useSessionStore((s) => s.editAndResendMessage);
  const claudeInstalled = useSessionStore((s) => s.claudeInstalled);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Tasks capsule + usage (both keyed by this sessionId).
  const todos = useSessionStore((s) =>
    s.todosBySession[sessionId] ?? EMPTY_TODOS,
  );
  // Subagent roster for this session.
  const subagents: SubagentSnapshot[] = useSessionStore((s) =>
    s.subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS,
  );
  // Plan drawer: the plan text currently selected for viewing in the
  // right-side drawer (null = drawer closed). Clicking a plan title in the
  // activity popover opens this.
  const drawerPlan = useSessionStore(
    (s) => s.planDrawerPlanBySession[sessionId] ?? null,
  );
  const openPlanDrawer = useSessionStore((s) => s.openPlanDrawer);
  const closePlanDrawer = useSessionStore((s) => s.closePlanDrawer);
  // Project root absolute path for this session (used by the @ / add-context
  // file pickers). Resolved through the session's projectId → projects[].
  const projectPath = useSessionStore((s) => {
    let pid: string | undefined;
    for (const list of Object.values(s.sessionsByProject)) {
      const found = list?.find((x) => x.id === sessionId);
      if (found) {
        pid = found.projectId;
        break;
      }
    }
    if (!pid) return null;
    return s.projects.find((p) => p.id === pid)?.path ?? null;
  });
  // Project display name (same resolution as projectPath, but returns the
  // name). Shown in the empty-thread project/branch indicator above the
  // composer. Falls back to the path basename when the project has no name.
  const projectName = useSessionStore((s) => {
    let pid: string | undefined;
    for (const list of Object.values(s.sessionsByProject)) {
      const found = list?.find((x) => x.id === sessionId);
      if (found) {
        pid = found.projectId;
        break;
      }
    }
    if (!pid) return "";
    const p = s.projects.find((pr) => pr.id === pid);
    return p?.name ?? "";
  });
  // Pending AskUserQuestion (per-session bucket — another tab's question
  // does not clobber this one).
  const pendingQuestion = useSessionStore((s) => s.pendingQuestionBySession[sessionId] ?? null);
  const dismissQuestion = useSessionStore((s) => s.dismissQuestion);
  const submitQuestion = useSessionStore((s) => s.submitQuestion);
  // (No sessionId filter needed — the bucket lookup above already scopes
  // to this session.)
  const activeQuestion = pendingQuestion?.questions ?? null;
  // Pending tool-approval queue. The store holds approvals for all
  // sessions in one flat array; filter to this one before rendering.
  // Head = element 0 of the filtered sub-array.
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals);
  const decideApproval = useSessionStore((s) => s.decideApproval);
  const headApproval = pendingApprovals.find((p) => p.sessionId === sessionId) ?? null;
  // Pending ExitPlanMode plan approval (one-at-a-time per session). The
  // model drafted a plan in plan mode and is awaiting the user's
  // approve/reject decision before executing.
  const pendingPlanApproval = useSessionStore(
    (s) => s.pendingPlanApprovalBySession[sessionId] ?? null,
  );
  const submitPlanApproval = useSessionStore((s) => s.submitPlanApproval);
  // Pre-turn file contents for the Write-tool diff. Built from the per-turn
  // `kind: "turn-files"` blocks in the message stream — each turn records the
  // `before` of every file it touched, so scanning all of them (later turns
  // overwrite earlier ones per filePath) yields the most recent pre-turn
  // content for each path. This is exactly what the Write card's before/after
  // diff wants. Empty until the first turn.files block arrives.
  const beforeMap = useMemo<BeforeContentMap>(() => {
    const m: BeforeContentMap = new Map();
    for (const msg of messages) {
      for (const b of msg.blocks) {
        if (b.kind === "turn-files") {
          for (const f of b.files) m.set(f.filePath, f.before);
        }
      }
    }
    return m;
  }, [messages]);
  // All plan blocks across this session's message history. Used by the
  // StatusCapsule (count) and the ActivityPopover (title list). Frozen plan
  // blocks survive turn.done, so this includes every approved plan in the
  // session - not just the current one.
  const planBlocks = useMemo(
    () =>
      messages
        .flatMap((m) => m.blocks)
        .filter((b): b is Extract<Block, { kind: "plan" }> => b.kind === "plan"),
    [messages],
  );
  // The textarea is blocked while a turn is running, a backgrounded subagent
  // is still in flight, or a tool approval is awaiting the user's decision —
  // the approval panel takes the place of the input area entirely so the user
  // can't type a competing prompt.
  const inputBlocked = sessionBusy || !!headApproval;
  // The TEXTAREA specifically: unlocked while a turn is running so the user
  // can type ahead and enqueue the next prompt. Still hard-locked when an
  // approval / AskUserQuestion is pending (that panel owns the input area).
  const textareaLocked = !!headApproval || !!pendingQuestion;

  // Per-session prompt queue (FIFO). Survives tab switches — it lives in the
  // store, not component state, so draining from the turn-done handler can
  // reach it without a component reference. Stable EMPTY_PROMPT_QUEUE ref so
  // the selector never returns a fresh [] (would re-render forever).
  const queue: QueuedPrompt[] = useSessionStore(
    (s) => s.promptQueueBySession[sessionId] ?? EMPTY_PROMPT_QUEUE,
  );
  const enqueuePrompt = useSessionStore((s) => s.enqueuePrompt);
  const removeQueuedPrompt = useSessionStore((s) => s.removeQueuedPrompt);
  const clearPromptQueue = useSessionStore((s) => s.clearPromptQueue);

  const [value, setValue] = useState("");
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  // Inline-edit mode for a user message. When set, the MessageRow with this id
  // swaps its bubble for an inline editor. Cleared on submit/cancel. Null when
  // no message is being edited.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const virtualListRef = useRef<LegendListRef>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Guards the one-shot "scroll to bottom on session open" effect. Reset to
   *  false on mount (keyed by sessionId upstream, so a switch re-mounts us).
   *  Set true after the first successful scroll so streaming appends after that
   *  respect the user's scroll position (maintainScrollAtEnd handles the
   *  follow-along case) instead of yanking them back down. */
  const initialScrollDoneRef = useRef(false);
  // ── Composer inline pickers (@ mention / / slash) ──
  // "picker" drives a single floating list above the textarea. Only one of
  // mention/slash is active at a time. `triggerStart` is the index of the
  // leading @ or / so we can delete the whole token on pick / cancel.
  type PickerKind = "mention" | "slash" | null;
  const [pickerKind, setPickerKind] = useState<PickerKind>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const triggerStartRef = useRef<number | null>(null);
  // Anchor rect for the floating picker (the textarea's box, refreshed on open).
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  // "attach" mode: opened by the bottom-left + button (not by typing @). Same
  // UI as mention but multi-select and not tied to a textarea token.
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);
  const [attachPickerQuery, setAttachPickerQuery] = useState("");
  const [attachAnchor, setAttachAnchor] = useState<DOMRect | null>(null);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  // Content tags: long/multi-line pastes promoted to chips above the
  // textarea so they don't bury the input area. Ephemeral per-turn UI
  // state (cleared on send). See lib/contentTag.ts for the promote rules.
  const [tags, setTags] = useState<ContentTag[]>([]);
  // Whether a file-tree drag is currently hovering over the composer —
  // drives a highlight ring so the drop target is discoverable.
  const [dragOver, setDragOver] = useState(false);
  // Which tag's preview popover is open (by id); null = none.
  const [openTagId, setOpenTagId] = useState<string | null>(null);
  // Refs to each chip's DOM node, keyed by tag id. Used to measure the
  // clicked chip's bounding box so the preview popover can anchor to its
  // top-right corner.
  const chipRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  // Bounding box of the chip that opened the current popover. Captured at
  // toggle time (not re-read every render) so the popover stays put even
  // if the chips row reflows while it's open.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // User-message id → render-item index mapping for the virtual-list-based
  // MessageTimeline. Built once per renderItems change from the grouped data.
  const userMsgToRenderIndex = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < renderItems.length; i++) {
      const item = renderItems[i];
      if (item.kind === "single" && item.msg.role === "user") {
        m.set(item.msg.id, i);
      }
    }
    return m;
  }, [renderItems]);
  // Current virtual-list scroll offset, updated on each scroll event.
  // Used by MessageTimeline to compute which user message is active.
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);

  // Auto-resize the textarea to fit its content. Resets height to "auto"
  // first so scrollHeight measures the full content, then sets an explicit
  // pixel height. The textarea must NOT be `flex-1` — a flex item's height
  // is driven by the flex algorithm and would override this inline height,
  // leaving the outer box stuck while a scrollbar appears inside. With a
  // content-driven height (capped by max-h-72 on the element), the outer
  // border grows with the text.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  /** Detect an @ or / trigger token at the caret and drive the inline picker.
   *  - `@` (mention): must be at line start or preceded by whitespace.
   *  - `/` (slash): same boundary rule. Query = chars after the trigger up to
   *    the caret, stopping at whitespace.
   *  Closing the picker happens when the token is broken (space / delete /
   *  caret leaves). */
  const recomputePicker = useCallback(
    (v: string, caret: number) => {
      if (inputBlocked) {
        if (pickerKind !== null) setPickerKind(null);
        return;
      }
      // Walk back from the caret to find a trigger char at a valid position.
      let i = caret;
      while (i > 0) {
        const ch = v[i - 1];
        if (ch === "@" || ch === "/") {
          const atLineStart = i - 1 === 0 || /\s/.test(v[i - 2]);
          if (!atLineStart) {
            if (pickerKind !== null) setPickerKind(null);
            return;
          }
          const token = v.slice(i, caret);
          // A space inside the token means the user moved past it — close.
          if (/\s/.test(token)) {
            if (pickerKind !== null) setPickerKind(null);
            return;
          }
          const kind: "mention" | "slash" = ch === "@" ? "mention" : "slash";
          if (pickerKind !== kind) {
            triggerStartRef.current = i - 1;
            const rect = textareaRef.current?.getBoundingClientRect();
            if (rect) setPickerAnchor(rect);
            setPickerKind(kind);
          }
          setPickerQuery(token);
          return;
        }
        if (/\s/.test(ch)) break;
        i -= 1;
      }
      if (pickerKind !== null) setPickerKind(null);
    },
    [inputBlocked, pickerKind],
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    const caret = e.target.selectionStart ?? v.length;
    setValue(v);
    recomputePicker(v, caret);
  };

  /** Remove the trigger token (`@query` or `/query`) from the textarea. */
  const clearTriggerToken = useCallback(() => {
    const start = triggerStartRef.current;
    const el = textareaRef.current;
    if (start === null || !el) {
      setPickerKind(null);
      return;
    }
    const caret = el.selectionStart ?? value.length;
    const next = value.slice(0, start) + value.slice(caret);
    setValue(next);
    setPickerKind(null);
    triggerStartRef.current = null;
    // Restore focus + caret to the trigger position.
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(start, start);
    });
  }, [value]);

  /** Add files (from mention or attach picker) as file tags. */
  const addFileTags = useCallback(
    (files: FileSearchEntry[]) => {
      if (files.length > 0) {
        setTags((prev) => appendUniqueFileTags(prev, files.map((f) => f.path)));
      }
    },
    [],
  );

  // Drain the per-session "add to chat" queue. Other surfaces (e.g. the
  // file-tree context menu) push absolute paths into the queue via
  // `enqueueChatFile`; this effect materializes them as file-reference tags
  // in the composer. Subscribe to this session's queue so the effect fires
  // whenever it becomes non-empty, then drain (read + clear) and convert.
  const chatFileQueue = useSessionStore((s) =>
    sessionId ? s.chatFileQueueBySession[sessionId] ?? EMPTY_CHAT_QUEUE : EMPTY_CHAT_QUEUE,
  );
  const drainChatFileQueue = useSessionStore((s) => s.drainChatFileQueue);
  useEffect(() => {
    if (chatFileQueue.length === 0) return;
    const paths = drainChatFileQueue();
    if (paths.length === 0) return;
    setTags((prev) => appendUniqueFileTags(prev, paths));
  }, [chatFileQueue, drainChatFileQueue]);

  /** Mention picker confirm: drop the @token, add a file tag, refocus. */
  const handleMentionPick = useCallback(
    (files: FileSearchEntry[]) => {
      addFileTags(files);
      clearTriggerToken();
    },
    [addFileTags, clearTriggerToken],
  );

  /** Slash picker confirm: run the command via the shared context. */
  const handleSlashPick = useCallback(
    (cmd: Parameters<typeof executeSlashCommand>[0]) => {
      const ctx: SlashCommandContext = {
        clearToken: clearTriggerToken,
        clearDraft: () => {
          setValue("");
          setTags([]);
        },
        sendPrompt: (p) => {
          void sendPrompt(p);
        },
        setPermissionMode: (mode: PermissionMode) => setPermissionMode(mode),
        openModelPicker: () => {
          /* no-op: model dropdown isn't externally focusable yet */
        },
      };
      executeSlashCommand(cmd, ctx);
    },
    [clearTriggerToken, sendPrompt, setPermissionMode],
  );

  /** Open the attach picker from the bottom-left + button. */
  const openAttachPicker = useCallback(() => {
    if (inputBlocked) return;
    const rect = textareaRef.current?.getBoundingClientRect();
    if (rect) setAttachAnchor(rect);
    setAttachPickerQuery("");
    setAttachPickerOpen(true);
  }, [inputBlocked]);

  const handleAttachPick = useCallback(
    (files: FileSearchEntry[]) => {
      addFileTags(files);
      setAttachPickerOpen(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [addFileTags],
  );

  /** Intercept pastes that are long or multi-line and promote them to a
   *  content-tag chip instead of dumping the text into the textarea. Short
   *  single-line pastes pass through normally. Prevents a giant log / stack
   *  trace from burying the input area. */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    if (!shouldPromoteToTag(text)) return; // let the default paste happen
    e.preventDefault();
    setTags((prev) => [...prev, makeContentTag(text)]);
  };

  // Recompute the "jump to bottom" button visibility from the live scroll
  // state. Returns true if the list is near the bottom (button hidden), false
  // otherwise. Used both by the onScroll handler and the data-change effect so
  // the button stays correct when content grows without a scroll event (e.g.
  // streaming deltas append while the user is parked mid-history).
  //
  // LegendList's `getState()` exposes three relevant values:
  //   - scroll        : current scroll offset from the top
  //   - scrollLength  : the *viewport* height (NOT total content height!)
  //   - contentLength : total scrollable content height
  // Distance from the bottom is therefore `contentLength - scroll - scrollLength`
  // (mirrors the library's own `distanceFromEnd` in checkAtBottom.ts). The
  // previous code used `scrollLength - scroll`, which treats the viewport
  // height as the content height and only surfaces the button after scrolling
  // up past ~one viewport minus 80px.
  const recomputeNearBottom = useCallback((): boolean => {
    const state = virtualListRef.current?.getState();
    if (!state) return true; // no list yet -> treat as "at bottom" (no button)
    const distanceFromEnd = state.contentLength - state.scroll - state.scrollLength;
    return distanceFromEnd < NEAR_BOTTOM_THRESHOLD;
  }, []);

  // Scroll callback from LegendList: update scroll position for MessageTimeline
  // and jump-to-bottom button state.
  const handleVirtualScroll = useCallback(() => {
    const state = virtualListRef.current?.getState();
    if (!state) return;
    setVirtualScrollTop(state.scroll);
    const distanceFromEnd = state.contentLength - state.scroll - state.scrollLength;
    setShowJumpBottom(distanceFromEnd >= NEAR_BOTTOM_THRESHOLD);
  }, []);

  // Whether the session has any messages yet. Computed early (before the
  // scroll effects below) because they reference it.
  const empty = messages.length === 0;

  // Keep the jump-to-bottom button in sync when content changes (new messages
  // arrive / streaming grows the list) even if no scroll event fires. After the
  // initial jump-to-bottom lands we re-check: if the user is at the bottom the
  // button stays hidden; if they've scrolled up and new content pushed the
  // bottom further away, the button appears. Runs after paint so LegendList has
  // applied the new item sizes.
  useEffect(() => {
    if (empty) {
      setShowJumpBottom(false);
      return;
    }
    let raf = 0;
    raf = requestAnimationFrame(() => {
      setShowJumpBottom(!recomputeNearBottom());
    });
    return () => cancelAnimationFrame(raf);
  }, [renderItems, empty, recomputeNearBottom]);

  const jumpToBottom = () => {
    void virtualListRef.current?.scrollToEnd({ animated: true });
  };

  const handleSend = () => {
    const text = value.trim();
    // Nothing to send if both the textarea and the tag list are empty.
    if (!text && tags.length === 0) return;
    // Don't allow sending while a turn (or a backgrounded subagent from a
    // prior turn) is still in flight — the stop button is the only valid
    // action in that state.
    if (sessionBusy) return;
    // Compose the final prompt: typed text + each tag's content as a
    // delimited block (see composePromptWithTags).
    const prompt = composePromptWithTags(text, tags);
    if (!prompt) return;
    // Forward the tags as attachments so the sent user message keeps the
    // same chip-card presentation in the stream as it had in the composer.
    // displayText = just the typed text; the attachment content is shown
    // via the cards, so we must NOT also inline it into the text block
    // (the full prompt, with attachments inlined, is still sent to the SDK).
    const attachments = tags.map((t) => ({
      preview: t.preview,
      content: t.content,
      attachmentKind: t.kind,
      filePath: t.filePath,
    }));
    void sendPrompt(
      prompt,
      attachments.length > 0 ? attachments : undefined,
      attachments.length > 0 ? text : undefined,
    );
    setValue("");
    setTags([]);
    setOpenTagId(null);
    setAnchorRect(null);
  };

  /** Queue the typed prompt while a turn is running, instead of sending it.
   *  Mirrors handleSend's payload assembly (prompt + attachments + displayText)
   *  so a drained queue item flows through the normal sendPrompt path and the
   *  user message looks identical to a live send. No-op when not busy. */
  const handleEnqueue = () => {
    const text = value.trim();
    if (!text && tags.length === 0) return;
    // Only meaningful while busy — when idle, Enter/click routes to handleSend.
    if (!sessionBusy) return;
    const prompt = composePromptWithTags(text, tags);
    if (!prompt) return;
    const attachments = tags.map((t) => ({
      preview: t.preview,
      content: t.content,
      attachmentKind: t.kind,
      filePath: t.filePath,
    }));
    enqueuePrompt(sessionId, {
      prompt,
      displayText: text,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setValue("");
    setTags([]);
    setOpenTagId(null);
    setAnchorRect(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // While busy, Enter enqueues the prompt; when idle, it sends.
      if (sessionBusy) handleEnqueue();
      else handleSend();
    }
  };

  /** Submit an inline-edited user message. Reconstructs the full prompt from
   *  the edited text + the original message's attachment blocks (preserved
   *  as-is), then calls editAndResendMessage which truncates the session
   *  history at the edited message and resends. */
  const handleEditSubmit = async (msg: ChatMessage, newText: string) => {
    const text = newText.trim();
    if (!text) return;
    setEditingMessageId(null);
    // Reconstruct attachment tags from the original message's attachment
    // blocks so composePromptWithTags can re-inline them into the prompt.
    const attachmentBlocks = msg.blocks.filter((b) => b.kind === "attachment");
    const tags: ContentTag[] = attachmentBlocks.map((b, i) => {
      const ab = b as Extract<Block, { kind: "attachment" }>;
      return {
        id: `edit-tag-${i}`,
        kind: ab.attachmentKind ?? "paste",
        preview: ab.preview,
        content: ab.content,
        filePath: ab.filePath,
      };
    });
    const prompt = composePromptWithTags(text, tags);
    const attachments = tags.map((t) => ({
      preview: t.preview,
      content: t.content,
      attachmentKind: t.kind,
      filePath: t.filePath,
    }));
    void editAndResendMessage(
      sessionId,
      msg.id,
      prompt,
      attachments.length > 0 ? attachments : undefined,
      attachments.length > 0 ? text : undefined,
    );
  };

  // On opening a session, jump to the bottom so the latest exchange is in view
  // (the keyed remount above starts the list scrolled to the top). This fires
  // once per mount: it waits for messages to load, then scrolls and latches
  // `initialScrollDoneRef` so subsequent streaming appends don't yank the view
  // back down if the user has scrolled up to read history.
  useEffect(() => {
    if (empty || initialScrollDoneRef.current) return;
    // LegendList measures item heights asynchronously on first layout, so a
    // single rAF may run before the list has real scroll length. Two rAFs give
    // it a layout pass + a settle pass; scrollToEnd is a no-op if the list
    // still isn't ready, so we retry within the second frame as a fallback.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        virtualListRef.current?.scrollToEnd({ animated: false });
        initialScrollDoneRef.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [empty]);

  // The id of the last user message in this session. Only this message is
  // editable - editing an earlier user message would require forking the
  // conversation at a non-tail point, which the current truncation-based
  // resend doesn't support cleanly (the SDK's resume keeps server-side
  // history that we can't rewind to an arbitrary point).
  const lastUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  }, [messages]);

  // Render a single item for LegendList's renderItem.
  const renderListItem = useCallback(
    ({ item }: { item: RenderItem }) => {
      if (item.kind === "single") {
        const m = item.msg;
        const isUser = m.role === "user";
        return (
          <div className="px-[var(--chat-gutter)]">
            <div className="mx-auto max-w-5xl">
              <MessageRow
                msg={m}
                isStreamingTail={item.isStreamingTail}
                isTurnTail={item.isTurnTail}
                beforeMap={beforeMap}
                canEdit={isUser && !sessionBusy && m.id === lastUserMessageId}
                isEditing={editingMessageId === m.id}
                onStartEdit={(msg) => setEditingMessageId(msg.id)}
                onSubmitEdit={handleEditSubmit}
                onCancelEdit={() => setEditingMessageId(null)}
                onOpenPlan={(p) => openPlanDrawer(sessionId, p)}
              />
            </div>
          </div>
        );
      }
      if (item.kind === "pendingTurn") {
        // Synthesized pre-token running row: just the stat row (which carries
        // its own spinner via the `live` branch) plus a streaming-tail
        // spinner, mirroring a real streaming assistant message's tail so the
        // feedback reads as "the model is working". Disappears once a real
        // assistant turnMeta exists (groupMessagesForRender stops emitting it).
        return (
          <div className="px-[var(--chat-gutter)]">
            <div className="mx-auto max-w-5xl">
              <TurnStatRow meta={item.turnMeta} />
              <div className="mt-1.5 flex items-center gap-1.5">
                <IconLoader2 size={12} className="animate-spin text-accent" />
              </div>
            </div>
          </div>
        );
      }
      const blocks = flattenCluster(item.msgs);
      return (
        <div key={item.msgs[0].id} className="px-[var(--chat-gutter)]">
          <div className="mx-auto max-w-5xl">
            {item.turnMeta && <TurnStatRow meta={item.turnMeta} />}
            <ProceduralGroup
              blocks={blocks}
              beforeMap={beforeMap}
              turnActive={item.isStreamingTail}
              turnMeta={item.turnMeta}
            />
            {item.isStreamingTail && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <IconLoader2 size={12} className="animate-spin text-accent" />
              </div>
            )}
          </div>
        </div>
      );
    },
    [beforeMap, sessionBusy, editingMessageId, lastUserMessageId, handleEditSubmit],
  );

  // Footer content rendered after all message items. Both the plan card and
  // the per-turn modified-files card used to live here as session-global
  // singletons; both now render INLINE in the stream as per-turn blocks
  // (kind: "plan" and kind: "turn-files" — see MessageBlocks + the store's
  // plan.update / turn.files handlers). There is nothing left to render in
  // the footer, so it stays null. Kept as a stable null to avoid churning
  // the LegendList prop on every render.
  const listFooter = null;

  return (
    <div className="relative flex h-full flex-col" data-chat-root>
      {/* Message stream area */}
      <div className={cn("relative flex min-h-0", empty ? "h-0" : "flex-1")}>
      {/* Left-edge timeline of user messages */}
      {!empty && (
        <MessageTimeline
          messages={messages}
          scrollTop={virtualScrollTop}
          userItemIndices={userMsgToRenderIndex}
          onJumpToIndex={(index) => {
            void virtualListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
          }}
        />
      )}
      {/* Virtual message list */}
      {!empty && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1" style={{ position: "relative" }}>
            <LegendList
              ref={virtualListRef}
              data={renderItems}
              renderItem={renderListItem}
              keyExtractor={(item) => {
                if (item.kind === "single") return item.msg.id;
                if (item.kind === "pendingTurn") return "pending-turn";
                return `cluster:${item.msgs[0].id}`;
              }}
              maintainScrollAtEnd
              // extraData drives LegendList's "should re-render all visible
              // items" check. renderItems alone isn't enough: toggling the
              // inline editor (editingMessageId) doesn't change renderItems,
              // so without including it here the list won't swap a row into
              // its edit form until something else forces a re-render.
              extraData={editingMessageId ? `${editingMessageId}|${renderItems.length}` : renderItems}
              estimatedItemSize={80}
              onScroll={handleVirtualScroll}
              drawDistance={400}
              ListFooterComponent={listFooter}
              contentContainerStyle={{ paddingTop: MESSAGE_LIST_TOP_PADDING }}
              style={{ height: "100%", width: "100%" }}
            />
          </div>
        </div>
      )}

      {/* StatusCapsule - floating overlay pinned to the top-right. Sits
          ABOVE the list (absolute) so it never takes layout space; only the
          pill itself is clickable, the rest of the overlay passes pointer
          events through to the scroll surface beneath. The popover drops
          down from the pill inside this non-clipping wrapper. Renders when
          there are todos, subagents, OR any plan blocks in the session
          history (the plan shows as an icon + count in the pill). */}
      {!empty && (todos.length > 0 || subagents.length > 0 || planBlocks.length > 0) && (
        <div className="pointer-events-none absolute right-8 top-2 z-30 flex justify-end">
          <StatusCapsule
            subagents={subagents}
            todos={todos}
            planCount={planBlocks.length}
            planBlocks={planBlocks}
            onPickPlan={(p) => openPlanDrawer(sessionId, p)}
          />
        </div>
      )}

      {/* Jump-to-bottom button */}
      {showJumpBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center">
          <button
            onClick={jumpToBottom}
            className={cn(
              "pointer-events-auto flex items-center gap-1 rounded-full",
              "border border-content-subtle/40 bg-surface-hover px-2.5 py-1.5 shadow-md transition-all",
              "hover:brightness-95 dark:hover:brightness-110",
            )}
            title="回到底部"
          >
            <IconArrowDown size={14} className="text-content" />
          </button>
        </div>
      )}
      </div>

      {/* Input box — fixed at the bottom (outside the scroll container) so
          the user always has access to the composer. No border-t divider:
          the box sits flush against the message area. When the session is
          empty the wrapper takes flex-1 and centers the box vertically. */}
      <div className={cn(
        "px-[var(--chat-gutter)]",
        empty
          ? "flex flex-1 items-center justify-center"
          : "shrink-0 pb-3",
      )}>
        <div className={cn("w-full", empty ? "max-w-3xl" : "mx-auto max-w-5xl pt-2")}>
          {/* Empty-thread indicator: project name + current git branch (with a
              branch switcher). Only on a brand-new/empty thread; hidden once
              the conversation has messages. Non-git projects show project name
              only. Rendered above the composer, centered. */}
          {empty && projectPath && (
            <div className="mb-2 flex justify-center">
              <ProjectBranchIndicator projectPath={projectPath} projectName={projectName} />
            </div>
          )}
          {empty && (
            <EmptyThreadWelcome
              projectName={projectName}
              disabled={inputBlocked}
              onPickPrompt={(prompt) => {
                setValue(prompt);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          )}
          {headApproval && (
            <ApprovalPrompt
              key={headApproval.requestId}
              toolName={headApproval.toolName}
              input={headApproval.input}
              description={headApproval.description}
              queuePosition={
                pendingApprovals.filter((p) => p.sessionId === sessionId).findIndex(
                  (p) => p.requestId === headApproval.requestId,
                ) + 1
              }
              queueTotal={
                pendingApprovals.filter((p) => p.sessionId === sessionId).length
              }
              onDecide={(granted, always) =>
                void decideApproval(headApproval.requestId, granted, always)
              }
            />
          )}
          {/* Plan-approval card (ExitPlanMode) - the model drafted a plan in
              plan mode and is awaiting the user's approve/reject decision.
              Rendered inside the composer column so it sits directly above the
              input box (mirrors ApprovalPrompt); yields to a pending tool
              approval (which blocks everything). */}
          {pendingPlanApproval && !headApproval && (
            <PlanApprovalPrompt
              plan={pendingPlanApproval.plan}
              onApprove={(editedPlan) => {
                void submitPlanApproval(pendingPlanApproval.requestId, true, editedPlan);
              }}
              onReject={(reason) => {
                void submitPlanApproval(pendingPlanApproval.requestId, false, undefined, reason);
              }}
            />
          )}
          <div
            className={cn(
              "relative flex flex-col rounded-xl border border-edge-input bg-surface-muted/30 focus-within:border-accent",
              // Highlight the composer while a file-tree drag hovers over it.
              dragOver && "border-accent ring-1 ring-accent/30",
            )}
            onDragOver={(e) => {
              // Only react to OUR file drag (custom MIME). External drags
              // (text, images, files from outside the app) are ignored.
              if (e.dataTransfer.types.includes(FILE_DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                if (!dragOver) setDragOver(true);
              }
            }}
            onDragLeave={(e) => {
              // Only clear when leaving the container itself (not when
              // crossing into a child). relatedTarget is null when the
              // pointer leaves to outside the window.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOver(false);
              }
            }}
            onDrop={(e) => {
              const path = e.dataTransfer.getData(FILE_DRAG_MIME);
              if (!path) return;
              e.preventDefault();
              setDragOver(false);
              setTags((prev) => [...prev, makeFileTag(path)]);
            }}
          >
            {queue.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 border-b border-edge px-2 pt-2 pb-1.5">
                <span className="mr-0.5 shrink-0 text-[10px] font-medium uppercase tracking-wide text-content-subtle">
                  排队
                </span>
                {queue.map((item, idx) => (
                  <span
                    key={item.id}
                    title={item.displayText || "已排队的消息"}
                    className={cn(
                      "inline-flex max-w-full items-center gap-1 rounded-md border border-accent/30 bg-accent/5 px-1.5 py-0.5 text-[11px] text-content",
                    )}
                  >
                    <span className="shrink-0 text-[10px] text-content-subtle">{idx + 1}.</span>
                    <span className="max-w-[160px] truncate">
                      {item.displayText || "(仅附件)"}
                    </span>
                    {item.attachments && item.attachments.length > 0 && (
                      <IconPaperclip size={11} className="shrink-0 opacity-60" />
                    )}
                    <button
                      type="button"
                      onClick={() => removeQueuedPrompt(sessionId, item.id)}
                      title="从队列移除"
                      aria-label="从队列移除"
                      className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:bg-accent/20 hover:text-content"
                    >
                      <IconX size={10} />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => clearPromptQueue(sessionId)}
                  title="清空队列"
                  className="shrink-0 rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-muted hover:text-content"
                >
                  清空
                </button>
              </div>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 px-2 pt-2">
                {tags.map((tag) => (
                  <ContentTagChip
                    key={tag.id}
                    ref={(el) => {
                      if (el) chipRefs.current.set(tag.id, el);
                      else chipRefs.current.delete(tag.id);
                    }}
                    tag={tag}
                    open={openTagId === tag.id}
                    onToggle={() => {
                      setOpenTagId((cur) => {
                        if (cur === tag.id) return null; // closing
                        // Opening: capture this chip's box so the popover can
                        // anchor to its top-right corner.
                        const el = chipRefs.current.get(tag.id);
                        if (el) setAnchorRect(el.getBoundingClientRect());
                        return tag.id;
                      });
                    }}
                    onRemove={() => {
                      setTags((prev) => prev.filter((t) => t.id !== tag.id));
                      chipRefs.current.delete(tag.id);
                      setOpenTagId((cur) => (cur === tag.id ? null : cur));
                    }}
                  />
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder={
                textareaLocked
                  ? "Claude is working…"
                  : sessionBusy
                    ? "排队输入…  (Enter 加入队列)"
                    : "发送消息…  (@ 引用文件 · / 命令)"
              }
              disabled={textareaLocked}
              className={cn(
                "max-h-72 min-h-[52px] resize-none bg-transparent px-3 pt-2.5 text-sm leading-relaxed text-content outline-none",
                "placeholder:text-content-subtle disabled:opacity-60",
                tags.length > 0 && "pt-1.5",
              )}
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-1">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={openAttachPicker}
                  disabled={inputBlocked}
                  title="添加上下文文件"
                  aria-label="添加上下文文件"
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-md text-content-muted transition-colors",
                    "hover:bg-surface-muted hover:text-content disabled:opacity-40 disabled:hover:bg-transparent",
                  )}
                >
                  <IconPaperclip size={15} />
                </button>
                <ComposerToolbar />
              </div>
              {sessionBusy ? (
                <div className="flex items-center gap-1">
                  {/* Queue button: parks the typed prompt to fire after the
                      current turn ends (or immediately if the user then stops). */}
                  <button
                    onClick={handleEnqueue}
                    disabled={!value.trim() && tags.length === 0}
                    title="加入队列(当前任务结束后自动发送)"
                    aria-label="加入队列"
                    className={cn(
                      "inline-flex items-center justify-center rounded-md bg-accent p-1.5 text-surface transition-all",
                      "hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle",
                    )}
                  >
                    <IconSend2 size={14} />
                  </button>
                  <button
                    onClick={() => void interrupt()}
                    title="停止生成"
                    className={cn(
                      "inline-flex items-center justify-center rounded-md bg-danger p-1.5 text-surface",
                      "hover:brightness-110",
                    )}
                  >
                    <IconPlayerStop size={14} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!value.trim() && tags.length === 0}
                  title="发送"
                  className={cn(
                    "inline-flex items-center justify-center rounded-md bg-accent p-1.5 text-surface transition-all",
                    "hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle",
                  )}
                >
                  <IconSend2 size={14} />
                </button>
              )}
            </div>
          </div>
          {/* Content-tag preview popover. Fixed-positioned to the clicked
              chip's top-right; rendered outside the composer container so
              it isn't clipped by overflow/border-radius. Anchored only while
              open AND we have a captured chip rect. */}
          {openTagId &&
            anchorRect &&
            (() => {
              const t = tags.find((x) => x.id === openTagId);
              return t ? (
                <TagPopover
                  tag={t}
                  anchorRect={anchorRect}
                  onClose={() => {
                    setOpenTagId(null);
                    setAnchorRect(null);
                  }}
                />
              ) : null;
            })()}
          {/* Inline @-mention picker (project file fuzzy search). Anchored
              above the textarea; selecting adds a file tag and removes the
              `@query` token from the input. */}
          <FileMentionPicker
            open={pickerKind === "mention"}
            projectPath={projectPath}
            query={pickerQuery}
            anchorRect={pickerAnchor}
            mode="mention"
            excludePaths={tags
              .filter((t) => t.kind === "file" && t.filePath)
              .map((t) => t.filePath as string)}
            onPick={handleMentionPick}
            onClose={() => setPickerKind(null)}
          />
          {/* Inline /-slash command picker. Anchored above the textarea;
              selecting runs the command (local action or sent prompt). */}
          <SlashCommandPicker
            open={pickerKind === "slash"}
            query={pickerQuery}
            anchorRect={pickerAnchor}
            onPick={handleSlashPick}
            onClose={() => setPickerKind(null)}
          />
          {/* "Add context" picker opened from the bottom-left + button.
              Multi-select; same project file source as @-mention. */}
          <FileMentionPicker
            open={attachPickerOpen}
            projectPath={projectPath}
            query={attachPickerQuery}
            anchorRect={attachAnchor}
            mode="attach"
            excludePaths={tags
              .filter((t) => t.kind === "file" && t.filePath)
              .map((t) => t.filePath as string)}
            onPick={handleAttachPick}
            onClose={() => setAttachPickerOpen(false)}
          />
        </div>
      </div>

      {/* AskUserQuestion bottom sheet — anchored to the bottom of the
          whole ChatPane (not just the input box) so it can grow upward
          beyond the composer height. Sits in a `relative` root and uses
          absolute positioning pinned to the bottom edge; the sheet sizes
          to its content with a max height and scrolls internally. This
          forces the user to answer before they can type a competing
          prompt. Renders only when no tool approval or plan approval is
          pending (those take precedence). */}
      {activeQuestion && !headApproval && !pendingPlanApproval && (
        <QuestionPrompt
          questions={activeQuestion}
          onSubmit={(answers) => {
            void submitQuestion(answers);
          }}
          onDismiss={dismissQuestion}
        />
      )}

      {/* Plan drawer - right-side slide-out showing the full plan content.
          Opened when the user clicks a plan title in the activity popover.
          Absolute-positioned inside the ChatPane root so it overlays the
          right strip of the chat area (message stream + composer). */}
      {drawerPlan && (
        <PlanDrawer
          plan={drawerPlan}
          onClose={() => closePlanDrawer(sessionId)}
        />
      )}
    </div>
  );
}

/** One row in the stream, with role styling. The "You"/"Claude" labels
 *  were removed per design - alignment (user right, assistant left) and
 *  bubble styling carry the role signal. A copy button sits BELOW the
 *  message content - outside the user bubble's border so it doesn't read
 *  as part of the copied text and stays visually separate from the
 *  content area.
 *
 *  For assistant messages: the FIRST message of a turn shows a per-turn
 *  "开始 HH:MM:SS · 用时 12.3s" stat row ABOVE the content. The streaming
 *  tail (the last assistant message while a turn is running) shows a
 *  spinning loader at the bottom of the content.
 *
 *  User messages also get an edit button (pencil icon) next to copy when
 *  the session is idle. Clicking it swaps the bubble for an inline editor
 *  (see UserMessageEditor); submitting the editor truncates the session's
 *  history at this message and resends the edited prompt. */
const MessageRow = memo(function MessageRow({
  msg,
  isStreamingTail,
  isTurnTail,
  beforeMap,
  canEdit,
  isEditing,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onOpenPlan,
}: {
  msg: ChatMessage;
  isStreamingTail?: boolean;
  isTurnTail?: boolean;
  beforeMap?: BeforeContentMap;
  /** Whether the edit affordance should be shown (user message + idle). */
  canEdit?: boolean;
  /** Whether THIS row is currently in inline-edit mode. */
  isEditing?: boolean;
  onStartEdit?: (msg: ChatMessage) => void;
  onSubmitEdit?: (msg: ChatMessage, newText: string) => void;
  onCancelEdit?: () => void;
  /** Called when the user clicks an inline plan block - opens the PlanDrawer. */
  onOpenPlan?: (plan: string) => void;
}) {
  const isUser = msg.role === "user";
  const copyText = useMemo(() => blocksToText(msg.blocks), [msg.blocks]);
  // Only show the copy button on messages with real text content - i.e. the
  // model's substantive answer to the user. A single turn often produces
  // several assistant messages (pure thinking, pure tool_use, then the text
  // reply); copying is only meaningful for the text reply, so we gate on
  // the presence of a non-empty `text` block. Pure-tool / pure-thinking
  // messages have no copy button.
  const hasTextContent = msg.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0);
  // User prompts always get a copy button (on hover). Assistant replies get one
  // ONLY on the turn's final assistant message (isTurnTail) - i.e. after the
  // turn has ended - so intermediate procedural messages stay clean and only
  // one copy affordance appears per completed turn. The button itself is
  // opacity-0 until the row is hovered (group-hover in CopyRow).
  const showCopy = isUser
    ? hasTextContent && !!copyText
    : hasTextContent && !!copyText && isTurnTail;
  // The edit button is only for user messages, only when idle, and only on
  // rows NOT currently being edited (the editor replaces the row).
  const showEdit = isUser && canEdit && !isEditing;

  // ── Inline edit mode ──
  // When editing, the normal bubble is replaced by an editor with a textarea
  // prefilled with the original typed text (attachment blocks are preserved
  // as-is; only the text portion is editable). Enter submits, Escape cancels.
  if (isUser && isEditing) {
    return (
      <div className="mt-5 mb-4 flex justify-end">
        <div className="max-w-[85%] w-full">
          <UserMessageEditor
            msg={msg}
            onSubmit={(newText) => onSubmitEdit?.(msg, newText)}
            onCancel={() => onCancelEdit?.()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group", isUser ? "mt-5 flex justify-end" : "mt-3")}>
      <div className={isUser ? "max-w-[85%]" : "w-full"}>
        {/* Per-turn stat row - only on the first assistant message of a
            turn (the one carrying turnMeta). Sits above the content. */}
        {!isUser && msg.turnMeta && <TurnStatRow meta={msg.turnMeta} />}
        <div
          // User messages get a native tooltip showing the full send date-time
          // on hover (assistant messages have no createdAt tooltip - the
          // per-turn stat row already shows timing).
          title={isUser ? fmtFullDateTime(msg.createdAt) : undefined}
          className={
            isUser
              ? "rounded-lg bg-userBubble/10 px-3 py-2 text-content [font-size:var(--chat-font-size)]"
              : "text-content [font-size:var(--chat-font-size)]"
          }
        >
          <MessageBlocks blocks={msg.blocks} beforeMap={beforeMap} isStreamingTail={isStreamingTail} onOpenPlan={onOpenPlan} />
          {/* Streaming loader at the bottom of the content while this
              message is still receiving deltas. */}
          {isStreamingTail && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <IconLoader2 size={12} className="animate-spin text-accent" />
            </div>
          )}
        </div>
        {/* Action row BELOW the content bubble - outside its border.
            Icon-only, revealed on row hover. User messages right-align the
            buttons (under the right-aligned bubble); assistant messages
            left-align. For user messages the copy + edit buttons sit
            side-by-side; for assistant messages only copy is shown. */}
        {(showCopy || showEdit) && (
          <div
            className={cn(
              "mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100",
              isUser ? "justify-end" : "justify-start",
            )}
          >
            {showCopy && <CopyButton text={copyText} />}
            {showEdit && (
              <button
                type="button"
                onClick={() => onStartEdit?.(msg)}
                title="编辑"
                aria-label="编辑"
                className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
              >
                <IconPencil size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
export { MessageRow };

/** Flatten a message's blocks into the plain-text payload that the copy
 *  button yields. text→text, thinking→quoted, tool_use→summary, errors
 *  skipped. Keeps copy output predictable for both user prompts and
 *  assistant replies. */
function blocksToText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      out.push(b.text);
    } else if (b.kind === "thinking") {
      const t = b.text.trim();
      if (t) out.push(`> ${t.replace(/\n/g, "\n> ")}`);
    } else if (b.kind === "attachment") {
      // Mirror the composer's delimited format so copied output matches
      // what was actually sent to the model.
      out.push(`--- pasted content (${b.content.length} chars) ---\n${b.content}\n--- end ---`);
    }
    // tool_use and error blocks are intentionally omitted — they're
    // procedural UI, not part of the conversational payload to copy.
  }
  return out.join("\n\n").trim();
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable (sandbox); silently no-op so the
      // message stream stays usable.
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title="复制"
      aria-label="复制"
      className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
    >
      {copied ? <IconCheck size={12} className="text-accent" /> : <IconCopy size={12} />}
    </button>
  );
}

/** Extract just the typed text from a user message's blocks (the `text`
 *  block content). Attachment blocks are skipped - they're edited as
 *  preserved attachments, not as editable text. Used to prefill the inline
 *  editor with the user's original wording. */
function userMessageText(blocks: Block[]): string {
  for (const b of blocks) {
    if (b.kind === "text") return b.text;
  }
  return "";
}

/** Inline editor that replaces a user message bubble when the user clicks
 *  the edit pencil. Renders a textarea prefilled with the original typed
 *  text (attachment blocks are shown as read-only chips above it, matching
 *  the composer's chip-above-textarea layout). Enter submits the edit
 *  (truncating the session history at this message and resending), Escape
 *  cancels back to the read-only view. */
function UserMessageEditor({
  msg,
  onSubmit,
  onCancel,
}: {
  msg: ChatMessage;
  onSubmit: (newText: string) => void;
  onCancel: () => void;
}) {
  const initialText = useMemo(() => userMessageText(msg.blocks), [msg.blocks]);
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentBlocks = msg.blocks.filter((b) => b.kind === "attachment");

  // Focus + auto-resize on mount.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    // Place the cursor at the end so the user can immediately append/correct.
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) onSubmit(trimmed);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const canSubmit = text.trim().length > 0;

  return (
    <div className="rounded-lg border border-accent/40 bg-userBubble/10 px-3 py-2 [font-size:var(--chat-font-size)]">
      {/* Attachment chips (read-only) - mirror the composer's chip-above-textarea
          layout. Only shown if the original message had attachments. These are
          non-interactive previews (the attachments are preserved as-is on
          resend); editing only touches the text portion. */}
      {attachmentBlocks.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachmentBlocks.map((b, i) =>
            b.kind === "attachment" ? (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent"
                title={b.filePath ?? b.preview}
              >
                {b.attachmentKind === "file" ? (
                  <IconPaperclip size={12} className="opacity-80" />
                ) : null}
                <span className="max-w-[12rem] truncate">{b.preview}</span>
              </span>
            ) : null,
          )}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
        className="w-full resize-none border-0 bg-transparent text-content outline-none placeholder:text-content-subtle"
        style={{ minHeight: "1.5em" }}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => canSubmit && onSubmit(text.trim())}
          disabled={!canSubmit}
          className={cn(
            "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
            canSubmit
              ? "bg-accent text-white hover:bg-accent/90"
              : "cursor-not-allowed bg-surface-hover text-content-subtle",
          )}
        >
          <IconSend2 size={12} />
          发送
        </button>
      </div>
    </div>
  );
}

export type { Block };
