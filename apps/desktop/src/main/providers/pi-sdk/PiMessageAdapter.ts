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
  /** Per-session message id counter — message boundaries come from
   *  `message_start` / `message_end` events. */
  private currentMessageId: string | null = null;
  /** True once a `message_start` has been seen and not yet closed. */
  private inMessage = false;

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
        this.currentMessageId = randomUUID();
        this.inMessage = true;
        break;
      case "message_end":
        this.inMessage = false;
        this.currentMessageId = null;
        this.emit({ type: "message.complete", sessionId: this.sessionId, messageId: this.currentMessageId ?? randomUUID() });
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
      this.ensureMessageId();
      this.emit({
        type: "text.delta",
        sessionId: this.sessionId,
        messageId: this.currentMessageId!,
        text: sub.delta,
      });
    } else if (sub.type === "thinking_delta") {
      this.ensureMessageId();
      this.emit({
        type: "thinking",
        sessionId: this.sessionId,
        messageId: this.currentMessageId!,
        text: sub.delta,
      });
    }
  }

  private ensureMessageId(): void {
    // Pi may emit text_delta before a message_start (or without one in some
    // tool-loop paths). Lazily allocate a message id so deltas always have a
    // target bucket.
    if (!this.currentMessageId) {
      this.currentMessageId = randomUUID();
    }
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
