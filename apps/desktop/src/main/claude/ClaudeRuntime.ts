import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { resolveClaude } from "./ClaudePathResolver.js";
import { log } from "@main/lib/logger.js";
import type {
  RuntimeEvent,
  TextDeltaEvent,
  ToolUseEvent,
  ToolResultEvent,
  ThinkingEvent,
  UsageEvent,
  TurnDoneEvent,
  ErrorEvent,
} from "@contracts/runtime";
import type { PermissionMode } from "@contracts/runtime";

/** A pending turn's launch parameters. */
export interface TurnRequest {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** claude session id from a prior turn, to resume the conversation. */
  resumeSessionId?: string | null;
}

/** Raw shapes of the NDJSON lines claude emits (only the fields we read). */
namespace Raw {
  export interface ContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    // tool_use
    id?: string;
    name?: string;
    input?: unknown;
    // tool_result
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
  }
  export interface AssistantMessage {
    id?: string;
    content?: ContentBlock[];
  }
  export interface NdjsonLine {
    type: string;
    subtype?: string;
    session_id?: string;
    // assistant / user
    message?: AssistantMessage;
    // system/init
    cwd?: string;
    model?: string;
    permissionMode?: string;
    // system/status
    status?: string;
    // stream_event
    event?: { type: string; index?: number; content_block?: ContentBlock; delta?: ContentBlock };
    // result
    result?: string;
    is_error?: boolean;
    stop_reason?: string;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number };
  }
}

/** Live state tracked while parsing a turn's stream. */
interface TurnState {
  /** maps claude content-block index → our messageId, so deltas accumulate. */
  blockMessageIds: Map<number, string>;
  /** maps claude tool_use id → whether we've emitted tool.use (avoid dupes). */
  emittedToolUse: Set<string>;
  /** set true once the terminal result line is processed. */
  resultSeen: boolean;
}

/**
 * Owns the lifecycle of a single claude.exe invocation for one turn.
 * Spawns the CLI, reads NDJSON line-by-line, normalizes into RuntimeEvent,
 * and pushes events to the provided sink.
 *
 * Design note: one turn = one spawn. Claude's -p mode is one-shot per prompt.
 * Continuation across turns is achieved via --resume <session_id>, which we
 * capture from the system/init line.
 */
export class ClaudeRuntime {
  /** Send a normalized event to the renderer. */
  constructor(private readonly emit: (e: RuntimeEvent) => void) {}

  private current: { child: ChildProcess; sessionId: string } | null = null;

  /** Execute one turn. Resolves when claude exits (result line or close). */
  async runTurn(req: TurnRequest): Promise<void> {
    const spec = resolveClaude();
    if (!spec) {
      const e: ErrorEvent = {
        type: "error",
        sessionId: req.sessionId,
        message: "Claude Code CLI not found. Install it first (npm i -g @anthropic-ai/claude-code).",
        code: "CLAUDE_NOT_FOUND",
      };
      this.emit(e);
      return;
    }

    const args = [...spec.preArgs];
    args.push("-p", req.prompt);
    args.push("--output-format", "stream-json");
    args.push("--verbose");
    args.push("--include-partial-messages");
    if (req.resumeSessionId) {
      args.push("--resume", req.resumeSessionId);
    }
    // permission mode: map our enum to claude's flag value
    const mode = req.permissionMode ?? "default";
    if (mode !== "default") args.push("--permission-mode", mode);

    log.info(`spawning claude turn (session ${req.sessionId}, cwd ${req.cwd})`);
    const child = spawn(spec.command, args, {
      cwd: req.cwd,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      // On Windows, launching node + .cjs needs no shell; a .cmd shim would.
      shell: spec.command.endsWith(".cmd"),
    });

    const state: TurnState = {
      blockMessageIds: new Map(),
      emittedToolUse: new Set(),
      // set true once the terminal result line fires; close() uses it to
      // synthesize a fallback turn.done if claude died without one.
      resultSeen: false,
    };
    this.current = { child, sessionId: req.sessionId };

    return new Promise<void>((resolve) => {
      const rl = createInterface({ input: child.stdout });
      const rlErr = createInterface({ input: child.stderr });

      rl.on("line", (line) => this.handleLine(line, req.sessionId, state));
      rlErr.on("line", (line) => log.warn(`claude stderr: ${line}`));

      child.on("error", (err) => {
        log.error(`claude spawn error: ${err.message}`);
        this.emit({ type: "error", sessionId: req.sessionId, message: err.message, code: "SPAWN_ERROR" });
        this.current = null;
        resolve();
      });

      child.on("close", (code) => {
        log.info(`claude exited with code ${code}`);
        // If claude exited without emitting a result line, the renderer would
        // hang waiting for turn.done — synthesize one as interrupted.
        if (!state.resultSeen) {
          this.emit({ type: "turn.done", sessionId: req.sessionId, reason: code === 0 ? "end_turn" : "interrupted" });
        }
        this.current = null;
        resolve();
      });
    });
  }

  /** Try to interrupt the running turn (best-effort). */
  interrupt(): void {
    if (!this.current) return;
    try {
      // SIGINT asks claude to stop gracefully; tree-kill handles descendants.
      this.current.child.kill("SIGINT");
    } catch {
      try {
        this.current.child.kill();
      } catch {
        /* give up */
      }
    }
  }

  isRunning(): boolean {
    return this.current !== null;
  }

  // ──────────────────────────── NDJSON parsing ────────────────────────────

  private handleLine(line: string, sessionId: string, state: TurnState): void {
    if (!line.trim()) return;
    let o: Raw.NdjsonLine;
    try {
      o = JSON.parse(line);
    } catch {
      log.warn(`unparseable claude line: ${line.slice(0, 120)}`);
      return;
    }

    switch (o.type) {
      case "system":
        return this.handleSystem(o, sessionId);
      case "stream_event":
        return this.handleStreamEvent(o, sessionId, state);
      case "assistant":
        return this.handleAssistant(o, sessionId, state);
      case "user":
        return this.handleUser(o, sessionId);
      case "result":
        return this.handleResult(o, sessionId, state);
      default:
        return; // ignore unknown (e.g. hook_started/hook_response noise)
    }
  }

  private handleSystem(o: Raw.NdjsonLine, sessionId: string): void {
    // We mostly ignore system subtypes except to note status. The init line's
    // session_id is already supplied by us; no action needed for P1.
    if (o.subtype === "status" && o.status) {
      log.info(`claude status: ${o.status}`);
    }
    void sessionId;
  }

  /** Anthropic-native SSE events for fine-grained streaming deltas. */
  private handleStreamEvent(o: Raw.NdjsonLine, sessionId: string, state: TurnState): void {
    const ev = o.event;
    if (!ev) return;

    if (ev.type === "content_block_start" && typeof ev.index === "number") {
      // Reserve a messageId for this block so deltas can reference it.
      state.blockMessageIds.set(ev.index, randomUUID());
    } else if (ev.type === "content_block_delta" && typeof ev.index === "number") {
      const messageId = state.blockMessageIds.get(ev.index);
      if (!messageId) return;
      const delta = ev.delta;
      if (!delta) return;

      if (delta.type === "text_delta" && delta.text) {
        const e: TextDeltaEvent = { type: "text.delta", sessionId, messageId, text: delta.text };
        this.emit(e);
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        const e: ThinkingEvent = { type: "thinking", sessionId, messageId, text: delta.thinking };
        this.emit(e);
      } else if (delta.type === "input_json_delta") {
        // tool input streaming — accumulate but don't emit partial; the full
        // tool_use arrives in the assistant message. Skip for P1.
      }
    }
  }

  /** Complete assistant message — contains finalized thinking/text/tool_use blocks. */
  private handleAssistant(o: Raw.NdjsonLine, sessionId: string, state: TurnState): void {
    const blocks = o.message?.content;
    if (!blocks) return;
    for (const b of blocks) {
      if (b.type === "tool_use" && b.id && b.name) {
        if (state.emittedToolUse.has(b.id)) continue;
        state.emittedToolUse.add(b.id);
        const e: ToolUseEvent = {
          type: "tool.use",
          sessionId,
          toolCallId: b.id,
          toolName: b.name,
          input: b.input,
          // P1: assume no approval needed (default permission flow). P3 adds
          // real approval detection from permission-request events.
          requiresApproval: false,
        };
        this.emit(e);
      }
      // text/thinking blocks are already covered by stream_event deltas; we
      // don't re-emit them from the finalized message to avoid duplication.
    }
  }

  /** tool_result comes wrapped in a user message. */
  private handleUser(o: Raw.NdjsonLine, sessionId: string): void {
    const blocks = o.message?.content;
    if (!blocks) return;
    for (const b of blocks) {
      if (b.type === "tool_result" && b.tool_use_id) {
        const e: ToolResultEvent = {
          type: "tool.result",
          sessionId,
          toolCallId: b.tool_use_id,
          isError: !!b.is_error,
          content: b.content,
        };
        this.emit(e);
      }
    }
  }

  private handleResult(o: Raw.NdjsonLine, sessionId: string, state: TurnState): void {
    state.resultSeen = true;
    // Usage + cost from the terminal result line.
    if (o.usage || o.total_cost_usd != null) {
      const e: UsageEvent = {
        type: "usage",
        sessionId,
        inputTokens: o.usage?.input_tokens ?? 0,
        outputTokens: o.usage?.output_tokens ?? 0,
        costUsd: o.total_cost_usd,
        model: o.model,
      };
      this.emit(e);
    }
    const reason = (o.stop_reason ?? o.is_error ? "error" : "end_turn") as TurnDoneEvent["reason"];
    const e: TurnDoneEvent = { type: "turn.done", sessionId, reason };
    this.emit(e);
  }
}
