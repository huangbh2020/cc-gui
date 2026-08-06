/**
 * Pi SDK → RuntimeEvent normalization engine.
 *
 * The Pi SDK's `AgentSessionEvent` union (from @earendil-works/pi-coding-agent)
 * is structurally different from the Claude SDK's `SDKMessage`, but the target
 * contract is the same `RuntimeEvent` union — so the renderer / IPC /
 * persistence layers are provider-neutral and don't change.
 *
 * Pi event shape (v0.80.3):
 *   - `message_update` carries an `assistantMessageEvent` with a
 *     `type: "text_delta" | "thinking_delta" | ...` discriminator — we only
 *     forward the delta kinds the renderer renders.
 *   - `tool_execution_start/update/end` carry `toolName` + `toolCallId`.
 *   - `turn_end` signals a full turn completed (message + tool results).
 *   - `message_end` / `agent_end` bracket assistant messages.
 *
 * Turn lifecycle: the Pi SDK emits `agent_end` when the agent finishes
 * processing a prompt (and `turn_end` for each LLM+tool round). We emit
 * `turn.done` on `agent_end` — the closest analogue to the Claude result
 * message's end-of-turn signal.
 */
import { randomUUID } from "node:crypto";
import type { RuntimeEvent, TurnDoneReason } from "@contracts/runtime";
import type { ProviderContext } from "@contracts/provider";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export class PiMessageAdapter {
  /** Per-contentIndex message id — mirrors how Claude's SdkMessageAdapter maps
   *  content_block index → messageId. Pi's AssistantMessageEvent carries a
   *  `contentIndex` identifying which block a delta belongs to (thinking=0,
   *  text=1, tool=2, …). Assigning one messageId per block lets the renderer
   *  bucket each independently; turn-level grouping (turnMeta) then assembles
   *  them into a single turn in the view. This is what keeps each thinking /
   *  text segment as its own block instead of coalescing alternated
   *  thinking/text deltas into a single message (which produced the
   *  "thinking → text → thinking → text" multi-panel artifact). */
  private readonly blockMessageIds = new Map<number, string>();
  /** Tracks the most recently seen contentIndex so message_end can emit a
   *  message.complete with a valid id. */
  private lastMessageId: string | null = null;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly sessionId: string,
  ) {}

  /** Dispatch a single Pi agent-session event into RuntimeEvents. */
  dispatch(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_update":
        this.handleMessageUpdate(event);
        break;
      case "message_start":
        // Per-block ids are allocated lazily on each delta's contentIndex;
        // nothing to do at message boundaries.
        break;
      case "message_end":
        if (this.lastMessageId) {
          this.emit({ type: "message.complete", sessionId: this.sessionId, messageId: this.lastMessageId });
        }
        this.blockMessageIds.clear();
        break;
      case "tool_execution_start":
        this.emit({
          type: "tool.use",
          sessionId: this.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
          requiresApproval: false, // Pi has no canUseTool interception; tools run directly
        });
        break;
      case "tool_execution_end":
        this.emit({
          type: "tool.result",
          sessionId: this.sessionId,
          toolCallId: event.toolCallId,
          isError: event.isError,
          content: event.result,
        });
        break;
      case "agent_end":
        // End of the agent's processing run — the Pi analogue of the Claude
        // result message. The turn is complete.
        this.emit({
          type: "turn.done",
          sessionId: this.sessionId,
          reason: this.pickDoneReason(),
        });
        break;
      case "compaction_end":
        // Pi doesn't report pre/post token counts in this event. preTokens is
        // required by the contract; pass 0 (the renderer's compact card shows
        // the trigger and duration only when counts are non-zero).
        this.emit({
          type: "compact.result",
          sessionId: this.sessionId,
          trigger: event.reason === "manual" ? "manual" : "auto",
          preTokens: 0,
        });
        break;
      // turn_start / turn_end / agent_start / queue_update / auto_retry_* /
      // session_info_changed / thinking_level_changed — not surfaced to the
      // renderer. Forward-compatible: unknown types are silently ignored.
      default:
        break;
    }
  }

  private handleMessageUpdate(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
  ): void {
    const sub = event.assistantMessageEvent;
    if (!sub) return;
    if (sub.type === "text_delta") {
      const messageId = this.ensureMessageId(sub.contentIndex);
      // TODO(AskUserQuestion): pi has no native AskUserQuestion tool and no
      // canUseTool interception, so the question panel never appears for pi
      // sessions today. Claude solves this with a sentinel-text-scan fallback
      // (SdkMessageAdapter scans text_delta for <<<ASK_USER_QUESTION>>> JSON
      // and emits `question.ask` with a `sentinel_`-prefixed requestId). The
      // same approach is viable here — pi's text_delta stream is just plain
      // text — but it's not yet wired up: (1) PiAgentSdkProvider would need
      // to inject the sentinel system prompt, (2) this branch would scan the
      // delta and emit question.ask, (3) capabilities.supportsAskUserQuestion
      // would flip to true. The answer-return IPC already handles the
      // `sentinel_` prefix (composeSentinelAnswerPrompt → new turn), and
      // runtimeManager.sendTurn is provider-neutral, so that path reuses as-is.
      this.emit({
        type: "text.delta",
        sessionId: this.sessionId,
        messageId,
        text: sub.delta,
      });
    } else if (sub.type === "thinking_delta") {
      const messageId = this.ensureMessageId(sub.contentIndex);
      this.emit({
        type: "thinking",
        sessionId: this.sessionId,
        messageId,
        text: sub.delta,
      });
    }
  }

  /** Look up (or lazily allocate) the messageId for a given contentIndex. Each
   *  content block gets its own stable id — thinking(0) ≠ text(1) — matching
   *  Claude's per-block model. The map is cleared at message_end so the next
   *  pi-message reuses contentIndex 0/1 with fresh ids. */
  private ensureMessageId(contentIndex: number): string {
    let id = this.blockMessageIds.get(contentIndex);
    if (!id) {
      id = randomUUID();
      this.blockMessageIds.set(contentIndex, id);
    }
    this.lastMessageId = id;
    return id;
  }

  /** Pi doesn't report max_tokens / tool_use stop reasons distinctly in the
   *  events we surface; a completed agent run is treated as end_turn. */
  private pickDoneReason(): TurnDoneReason {
    return "end_turn";
  }

  private emit(e: RuntimeEvent): void {
    this.ctx.emit(e);
  }
}
