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
      <div className="max-w-md text-center text-sm text-content-muted">
        {claudeInstalled === false ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-1.5 text-warning">
              <IconAlertTriangle size={16} />
              <span>Claude Code CLI not detected</span>
            </div>
            <p className="text-xs text-content-subtle">
              Install it (<code className="rounded bg-surface-muted px-1">npm i -g @anthropic-ai/claude-code</code>),
              or point the app at an existing install:
            </p>
            <button
              onClick={() => setSettingsOpen(true)}
              className={cn(
                "inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface",
                "hover:brightness-110",
              )}
            >
              <IconSettings size={12} />
              Configure CLI path
              <IconArrowRight size={12} />
            </button>
          </div>
        ) : (
          <p>Open a project and start a session to begin.</p>
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

  return (
    <div className="relative flex h-full flex-col">
      {/* Message stream. The capsule row is sticky top-right (ZCode-style: stays
          put while scrolling, glassy, compact) so it overlays content without
          taking a layout row. */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {(todos.length > 0 || contextSnapshot || subagents.length > 0) && (
          <div className="pointer-events-none sticky top-0 z-20 -mx-2 flex items-center justify-end gap-1.5 bg-gradient-to-b from-surface-muted/90 to-transparent pb-2 pt-1">
            <StatusCapsule
              snapshot={contextSnapshot}
              subagents={subagents}
              todos={todos}
              plan={plan}
            />
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 ? (
            <div className="rounded-md border border-dashed border-edge px-6 py-12 text-center text-sm text-content-subtle">
              Send a message to start working with Claude.
            </div>
          ) : (
            messages.map((m, i) => {
              // The "streaming tail" is the last assistant message while a
              // turn is running — it's the one still receiving deltas, so
              // it gets the bottom loading indicator.
              const isStreamingTail =
                isRunning &&
                m.role === "assistant" &&
                i === messages.length - 1;
              return <MessageRow key={m.id} msg={m} isStreamingTail={isStreamingTail} />;
            })
          )}
        </div>
        {/* Jump-to-bottom button: appears when the user has scrolled up. */}
        {showJumpBottom && (
          <button
            onClick={jumpToBottom}
            className={cn(
              "absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-edge/50",
              "bg-surface-muted/90 px-3 py-1.5 text-[11px] text-content-muted shadow-lg backdrop-blur transition-colors",
              "hover:bg-surface-hover",
            )}
            title="Jump to latest"
          >
            <IconArrowDown size={12} className="inline" />
            {" "}Latest
          </button>
        )}
      </div>

      {/* Input box — Codex-style: a single rounded container holding the
          textarea on top and a bottom row (option chips left, send button
          right) inside the same border.

          The container is `relative` so the AskUserQuestion overlay can
          `absolute inset-0` over it (covering textarea + toolbar like a
          dialog), and the context ring can pin to the textarea's top-right
          corner. A tool-approval card renders as a separate block above the
          box (it's larger and needs more room); the "本轮文件" rewind card is
          non-blocking and also sits above. */}
      <div className="shrink-0 border-t border-edge px-6 py-3">
        <div className="mx-auto max-w-3xl">
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
            {/* Content-tag chips: long/multi-line pastes promoted from inline
                text to compact chips so they don't bury the textarea. Click a
                chip to preview its content; click × to remove. */}
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
                {/* The preview popover anchors to the chip row; only one open
                    at a time (the chip whose id matches openTagId). */}
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
                // When tags are present, shrink the top padding since chips
                // already provide spacing above.
                tags.length > 0 && "pt-1.5",
              )}
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-1">
              <ComposerToolbar />
              {isRunning ? (
                <button
                  onClick={() => void interrupt()}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md bg-danger px-3 py-1 text-xs font-medium text-surface",
                    "hover:brightness-110",
                  )}
                >
                  <IconPlayerStop size={12} />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!value.trim() && tags.length === 0}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1 text-xs font-medium text-surface transition-all",
                    "hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle",
                  )}
                >
                  <IconSend2 size={12} />
                  Send
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
function MessageRow({ msg, isStreamingTail }: { msg: ChatMessage; isStreamingTail?: boolean }) {
  const isUser = msg.role === "user";
  const copyText = useMemo(() => blocksToText(msg.blocks), [msg.blocks]);
  // Only show the copy button on messages with real text content — i.e. the
  // model's substantive answer to the user. A single turn often produces
  // several assistant messages (pure thinking, pure tool_use, then the text
  // reply); copying is only meaningful for the text reply, so we gate on
  // the presence of a non-empty `text` block. Pure-tool / pure-thinking
  // messages have no copy button.
  const hasTextContent = msg.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0);
  const showCopy = hasTextContent && !!copyText && !isStreamingTail;
  return (
    <div className={isUser ? "flex justify-end" : ""}>
      <div className={isUser ? "max-w-[85%]" : "w-full"}>
        {/* Per-turn stat row — only on the first assistant message of a
            turn (the one carrying turnMeta). Sits above the content. */}
        {!isUser && msg.turnMeta && <TurnStatRow meta={msg.turnMeta} />}
        <div
          className={
            isUser
              ? "rounded-lg bg-info/10 px-3 py-2 text-sm text-content"
              : "text-sm text-content"
          }
        >
          <MessageBlocks blocks={msg.blocks} />
          {/* Streaming loader at the bottom of the content while this
              message is still receiving deltas. */}
          {isStreamingTail && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-content-subtle">
              <IconLoader2 size={12} className="animate-spin text-accent" />
              <span>Claude 正在输出…</span>
            </div>
          )}
        </div>
        {/* Copy action BELOW the content bubble — outside its border.
            Only shown for messages with real text content (the model's
            substantive reply). Pure-thinking and pure-tool_use messages
            are procedural and have no copy button. Also hidden while
            actively streaming (the copy payload isn't final yet). */}
        {showCopy && <CopyRow text={copyText} isUser={isUser} />}
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

/** Small row below the message content with a copy button that flips to
 *  a check on success. Sits outside the user bubble's border (mt-1 tucks
 *  it just beneath the bubble) and is right-aligned for both roles so the
 *  action reads as "grab this message's text". Subtle styling so it
 *  doesn't compete with the content. */
function CopyRow({ text, isUser }: { text: string; isUser: boolean }) {
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
    // User messages align right (under the bubble); assistant messages
    // align right too so the button sits at the trailing edge of the
    // full-width content.
    <div className={cn("mt-1 flex", isUser ? "justify-end" : "justify-end")}>
      <button
        type="button"
        onClick={onCopy}
        title="复制"
        aria-label="复制"
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-content-subtle",
          "transition-colors hover:bg-surface-hover hover:text-content-muted",
        )}
      >
        {copied ? (
          <>
            <IconCheck size={12} className="text-accent" />
            <span className="text-accent">已复制</span>
          </>
        ) : (
          <>
            <IconCopy size={12} />
            <span>复制</span>
          </>
        )}
      </button>
    </div>
  );
}

export type { Block };
