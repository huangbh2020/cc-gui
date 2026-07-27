import { useState, useRef, useEffect, useMemo } from "react";
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
} from "@renderer/lib/icons.js";
import { useSessionStore, EMPTY_MESSAGES, EMPTY_TODOS, EMPTY_SUBAGENTS, EMPTY_PLAN, EMPTY_TURN_FILES, type PlanDraft, type Block, type ChatMessage, type TodoItem, type TurnMeta } from "@renderer/stores/sessionStore.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import { api } from "@renderer/lib/api.js";
import {
  type ContentTag,
  composePromptWithTags,
  makeContentTag,
  shouldPromoteToTag,
} from "@renderer/lib/contentTag.js";
import { MessageBlocks } from "./MessageBlocks.js";
import { ComposerToolbar } from "./ComposerToolbar.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { ApprovalPrompt } from "./ApprovalPrompt.js";
import { PlanApprovalPrompt } from "./PlanApprovalPrompt.js";
import { ContentTagChip } from "./ContentTagChip.js";
import { TurnFilesCard } from "./TurnFilesCard.js";
import { TagPopover } from "./TagPopover.js";
import { StatusCapsule } from "./StatusCapsule.js";
import { MessageTimeline, type RowRefMap } from "./MessageTimeline.js";

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

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
 *  (turnMeta.endedAt undefined) the duration ticks live via a 1s interval. */
function TurnStatRow({ meta }: { meta: TurnMeta }) {
  const live = meta.endedAt === undefined;
  const [, force] = useState(0);
  // Tick once per second while the turn is running so the duration updates.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => force((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

  const end = meta.endedAt ?? Date.now();
  const duration = Math.max(0, end - meta.startedAt);

  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-content-subtle">
      <span>开始</span>
      <span className="tabular-nums text-content-muted">{fmtClock(meta.startedAt)}</span>
      <span className="text-content-subtle">·</span>
      <span>用时</span>
      <span className="tabular-nums text-content-muted">{fmtDuration(duration)}</span>
      {live && (
        <IconLoader2 size={11} className="ml-0.5 animate-spin text-accent" />
      )}
    </div>
  );
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
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const interrupt = useSessionStore((s) => s.interrupt);
  const claudeInstalled = useSessionStore((s) => s.claudeInstalled);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Tasks capsule + usage (both keyed by this sessionId).
  const todos = useSessionStore((s) =>
    s.todosBySession[sessionId] ?? EMPTY_TODOS,
  );
  // Plan-mode draft for this session. Always returns the same
  // EMPTY_PLAN reference when no plan is active, so the selector is
  // referentially stable across renders.
  const plan: PlanDraft = useSessionStore((s) =>
    s.planBySession[sessionId] ?? EMPTY_PLAN,
  );
  // Subagent roster for this session.
  const subagents: SubagentSnapshot[] = useSessionStore((s) =>
    s.subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS,
  );
  // Context-window snapshot (token usage). Sourced from the per-session
  // bucket, populated by token-usage.updated events and hydrated from the
  // session row on select/open-tab. Undefined until the first usage report.
  const contextSnapshot = useSessionStore((s) => s.contextSnapshotBySession[sessionId]);
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
  // Per-turn "本轮文件" rewind card. Sourced from the per-session
  // bucket; turnFilesBySession is replaced on each turn.files event,
  // cleared on turn.rewound (or in error path).
  const turnFiles = useSessionStore((s) => s.turnFilesBySession[sessionId] ?? EMPTY_TURN_FILES);
  const rewindTurn = useSessionStore((s) => s.rewindTurn);
  // The textarea is blocked while either a turn is running or a tool approval
  // is awaiting the user's decision — the approval panel takes the place of
  // the input area entirely so the user can't type a competing prompt.
  const inputBlocked = isRunning || !!headApproval;

  const [value, setValue] = useState("");
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** When set, an @ mention is pending a file picker; the number is the caret
   * index where the triggering "@" sits, so we can splice the path in there. */
  const pendingAtRef = useRef<number | null>(null);
  // Content tags: long/multi-line pastes promoted to chips above the
  // textarea so they don't bury the input area. Ephemeral per-turn UI
  // state (cleared on send). See lib/contentTag.ts for the promote rules.
  const [tags, setTags] = useState<ContentTag[]>([]);
  // Which tag's preview popover is open (by id); null = none.
  const [openTagId, setOpenTagId] = useState<string | null>(null);
  // Map of user messageId → its row DOM element. The MessageTimeline reads
  // each row's offsetTop to (a) highlight the dash whose message is in view
  // and (b) scroll to that row on dash click. Stored in a ref (not state)
  // because the timeline reads it inside its own scroll listener.
  const userRowRefs = useRef<RowRefMap>(new Map());
  const registerUserRow = (id: string) => (el: HTMLDivElement | null) => {
    if (el) userRowRefs.current.set(id, el);
    else userRowRefs.current.delete(id);
  };

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

  // Track whether the user is near the bottom, so we only auto-scroll on new
  // messages when they're already following along (don't yank them down while
  // they're reading older history). Also drives the "jump to bottom" button.
  const updateJumpState = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Show the button as soon as the user scrolls up at all from the latest
    // content. The 120px threshold (rather than 10px) prevents flicker when
    // a new line is appended — the auto-scroll lands within a few pixels of
    // the bottom and shouldn't pop the button in and out for that.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setShowJumpBottom(!nearBottom);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateJumpState);
    // Sync once on mount so a session resumed with history taller than the
    // viewport shows the button immediately, without waiting for a scroll.
    updateJumpState();
    return () => el.removeEventListener("scroll", updateJumpState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-evaluate after messages change: when the list grows the scroll height
  // changes, so a position that was "near the bottom" may no longer be.
  useEffect(() => {
    updateJumpState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

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
    // Nothing to send if both the textarea and the tag list are empty.
    if (!text && tags.length === 0) return;
    if (isRunning) return;
    // Compose the final prompt: typed text + each tag's content as a
    // delimited block (see composePromptWithTags).
    const prompt = composePromptWithTags(text, tags);
    if (!prompt) return;
    void sendPrompt(prompt);
    setValue("");
    setTags([]);
    setOpenTagId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const empty = messages.length === 0;

  return (
    <div className="relative flex h-full flex-col">
      {/* Message stream — wrapped so overlays (jump-to-bottom) can sit above
          the scroll area but below the input box. When the session is empty
          the wrapper collapses (contents hidden) so the input-box wrapper
          below can take the full height and center vertically. */}
      <div className={cn("relative flex min-h-0", empty ? "h-0" : "flex-1")}>
      {/* Left-edge timeline of user messages — fixed cluster anchored to the
          chat area's left-middle, does NOT scroll with content. Lives in the
          overlay wrapper (outside the scroll container) so it stays put. */}
      {!empty && (
        <MessageTimeline
          messages={messages}
          rowRefs={userRowRefs.current}
          scrollRef={scrollRef}
        />
      )}
      {/* Message stream — scroll container, hidden when empty so the input
          box can take the full height and center vertically. No border or
          gap between the scroll area and the input box below. */}
      <div
        ref={scrollRef}
        className={cn(
          "relative w-full overflow-y-auto px-8",
          empty ? "hidden" : "min-h-0 flex-1",
        )}
      >
        {!empty && (
          <>
            {(todos.length > 0 || contextSnapshot || subagents.length > 0) && (
              <div className="pointer-events-none sticky top-0 z-20 flex items-center justify-end gap-1.5 bg-gradient-to-b from-surface/80 to-transparent pb-2 pt-3 pr-2">
                <StatusCapsule
                  snapshot={contextSnapshot}
                  subagents={subagents}
                  todos={todos}
                  plan={plan}
                />
              </div>
            )}
            <div className="mx-auto max-w-5xl space-y-5 pt-6">
              {messages.map((m, i) => {
                const isStreamingTail =
                  isRunning &&
                  m.role === "assistant" &&
                  i === messages.length - 1;
                const isLastCompletedAssistant =
                  !isRunning &&
                  m.role === "assistant" &&
                  i === messages.length - 1;
                return (
                  <MessageRow
                    key={m.id}
                    msg={m}
                    isStreamingTail={isStreamingTail}
                    isLastCompletedAssistant={isLastCompletedAssistant}
                    // User rows register their DOM element so the timeline
                    // can locate them for highlight + jump. Assistant rows
                    // pass nothing.
                    registerRow={m.role === "user" ? registerUserRow(m.id) : undefined}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Jump-to-bottom button — centered horizontally over the scroll area
          (NOT the input box below), so it never covers the composer. Lives in
          the wrapper that wraps only the scroll region, hence bottom-2 here
          sits at the bottom of the message stream. Pointer events disabled on
          the spacer so it never blocks scroll/click on underlying content. */}
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
        "px-8",
        empty
          ? "flex flex-1 items-center justify-center"
          : "shrink-0 pb-3",
      )}>
        <div className={cn("w-full", empty ? "max-w-3xl" : "mx-auto max-w-5xl pt-2")}>
          {turnFiles.length > 0 && (
            <TurnFilesCard files={turnFiles} onRewind={() => void rewindTurn()} />
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
          <div className="relative flex flex-col rounded-xl border border-edge-input bg-surface-muted/30 focus-within:border-accent">
            {tags.length > 0 && (
              <div className="relative flex flex-wrap gap-1 px-2 pt-2">
                {tags.map((tag) => (
                  <ContentTagChip
                    key={tag.id}
                    tag={tag}
                    open={openTagId === tag.id}
                    onToggle={() =>
                      setOpenTagId((cur) => (cur === tag.id ? null : tag.id))
                    }
                    onRemove={() => {
                      setTags((prev) => prev.filter((t) => t.id !== tag.id));
                      setOpenTagId((cur) => (cur === tag.id ? null : cur));
                    }}
                  />
                ))}
                {openTagId &&
                  (() => {
                    const t = tags.find((x) => x.id === openTagId);
                    return t ? (
                      <TagPopover tag={t} onClose={() => setOpenTagId(null)} />
                    ) : null;
                  })()}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder={inputBlocked ? "Claude is working…" : "Send a message…  (@ to attach a file)"}
              disabled={inputBlocked}
              className={cn(
                "max-h-72 min-h-[52px] resize-none bg-transparent px-3 pt-2.5 text-sm leading-relaxed text-content outline-none",
                "placeholder:text-content-subtle disabled:opacity-60",
                tags.length > 0 && "pt-1.5",
              )}
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-1">
              <ComposerToolbar />
              {isRunning ? (
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
        </div>
      </div>

      {/* Plan-approval card (ExitPlanMode) — the model drafted a plan in
          plan mode and is awaiting the user's approve/reject decision.
          Renders above the AskUserQuestion sheet; both yield to a pending
          tool approval (which blocks everything). */}
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
    </div>
  );
}

/** One row in the stream, with role styling. The "You"/"Claude" labels
 *  were removed per design — alignment (user right, assistant left) and
 *  bubble styling carry the role signal. A copy button sits BELOW the
 *  message content — outside the user bubble's border so it doesn't read
 *  as part of the copied text and stays visually separate from the
 *  content area.
 *
 *  For assistant messages: the FIRST message of a turn shows a per-turn
 *  "开始 HH:MM:SS · 用时 12.3s" stat row ABOVE the content. The streaming
 *  tail (the last assistant message while a turn is running) shows a
 *  spinning loader at the bottom of the content. */
function MessageRow({ msg, isStreamingTail, isLastCompletedAssistant, registerRow }: { msg: ChatMessage; isStreamingTail?: boolean; isLastCompletedAssistant?: boolean; registerRow?: (el: HTMLDivElement | null) => void }) {
  const isUser = msg.role === "user";
  const copyText = useMemo(() => blocksToText(msg.blocks), [msg.blocks]);
  // Only show the copy button on messages with real text content — i.e. the
  // model's substantive answer to the user. A single turn often produces
  // several assistant messages (pure thinking, pure tool_use, then the text
  // reply); copying is only meaningful for the text reply, so we gate on
  // the presence of a non-empty `text` block. Pure-tool / pure-thinking
  // messages have no copy button.
  const hasTextContent = msg.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0);
  // User messages always show copy on hover (gated by group-hover in CopyRow).
  // Assistant messages only show copy on the LAST completed turn — copying a
  // partial or intermediate reply is rarely useful.
  const showCopy = isUser
    ? hasTextContent && !!copyText
    : hasTextContent && !!copyText && isLastCompletedAssistant;
  return (
    <div ref={registerRow} className={cn("group", isUser ? "flex justify-end" : "")}>
      <div className={isUser ? "max-w-[85%]" : "w-full"}>
        {/* Per-turn stat row — only on the first assistant message of a
            turn (the one carrying turnMeta). Sits above the content. */}
        {!isUser && msg.turnMeta && <TurnStatRow meta={msg.turnMeta} />}
        <div
          className={
            isUser
              ? "rounded-lg bg-userBubble/10 px-3 py-2 text-content [font-size:var(--chat-font-size)]"
              : "text-content [font-size:var(--chat-font-size)]"
          }
        >
          <MessageBlocks blocks={msg.blocks} />
          {/* Streaming loader at the bottom of the content while this
              message is still receiving deltas. */}
          {isStreamingTail && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <IconLoader2 size={12} className="animate-spin text-accent" />
            </div>
          )}
        </div>
        {/* Copy action BELOW the content bubble — outside its border.
            Icon-only, left-aligned, revealed on row hover. */}
        {showCopy && <CopyRow text={copyText} />}
      </div>
    </div>
  );
}

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
    }
    // tool_use and error blocks are intentionally omitted — they're
    // procedural UI, not part of the conversational payload to copy.
  }
  return out.join("\n\n").trim();
}

function CopyRow({ text }: { text: string }) {
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
    <div className="mt-1 flex justify-start opacity-0 transition-opacity group-hover:opacity-100">
      <button
        type="button"
        onClick={onCopy}
        title="复制"
        aria-label="复制"
        className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
      >
        {copied ? <IconCheck size={12} className="text-accent" /> : <IconCopy size={12} />}
      </button>
    </div>
  );
}

export type { Block };
