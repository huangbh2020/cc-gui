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
  TodoUpdateEvent,
  AskUserQuestionEvent,
} from "@contracts/runtime";
import type { PermissionMode, EffortLevel } from "@contracts/runtime";

/** A pending turn's launch parameters. */
export interface TurnRequest {
  sessionId: string;
  prompt: string;
  cwd: string;
  /** Model alias or full name; undefined = don't pass --model. */
  model?: string;
  /** Reasoning effort; "default"/undefined = don't pass --effort. */
  effort?: EffortLevel;
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
    /** Tools that were denied permission during the turn (P3事后展示). */
    permission_denials?: Array<{ tool_name?: string; tool_use_id?: string; tool_input?: unknown }>;
  }
}

/* ─── AskUserQuestion convention (system-prompt-based fallback) ───
 * On 2.1.218 + proxy this environment has no AskUserQuestion tool, so we inject
 * a system prompt telling the model to emit any user question as sentinel-
 * delimited JSON. We intercept it in the text stream and surface a
 * question.ask event (reusing the same UI as the native tool path). Verified
 * working: the model obeys and stops after emitting, awaiting the answer. */
const ASK_BEGIN = "<<<ASK_USER_QUESTION>>>";
const ASK_END = "<<<END_ASK_USER_QUESTION>>>";

const ASK_SYSTEM_PROMPT = [
  `When you need to ask the user a question or need them to choose between options, you MUST emit it in this EXACT format and nothing else on those lines:`,
  ASK_BEGIN,
  `a single line of JSON with this shape: {"questions":[{"header":"short label","question":"the full question","multiSelect":false,"options":[{"label":"A","description":"why A"},{"label":"B","description":"why B"}]}]}`,
  ASK_END,
  `Rules: emit ONLY the JSON between the sentinels (no markdown fences, no extra text on those lines). Use multiSelect:true when multiple choices are allowed. After emitting, STOP and wait for the user's answer — do not answer your own question.`,
].join(" ");

/**
 * Incremental extractor that hides the sentinel-delimited question block from
 * the visible text stream. Feed it each text delta for a message via push(),
 * which returns the text safe to show to the user (excluding any partial or
 * complete sentinel block). When a full block is recognized, takeQuestion()
 * returns the parsed JSON string.
 */
class QuestionSentinelScanner {
  private buf = "";
  /** index in buf up to which we've already returned as safe text */
  private flushed = 0;
  private completedQuestions: string[] = [];

  /** Returns the text that is now safe to emit to the renderer. */
  push(chunk: string): string {
    this.buf += chunk;
    let safe = "";
    // Repeatedly scan from the flushed position.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remaining = this.buf.slice(this.flushed);
      const beginIdx = remaining.indexOf(ASK_BEGIN);
      if (beginIdx < 0) {
        // No begin marker in the remainder. But the tail might be a prefix of
        // the marker (streaming split) — withhold the last (ASK_BEGIN.length-1)
        // chars to be safe; flush the rest.
        const withhold = ASK_BEGIN.length - 1;
        const flushable = remaining.length > withhold ? remaining.slice(0, remaining.length - withhold) : "";
        safe += flushable;
        this.flushed += flushable.length;
        break;
      }
      // Flush text before the marker.
      safe += remaining.slice(0, beginIdx);
      this.flushed += beginIdx;
      // Now look for the end marker after the begin.
      const afterBegin = this.buf.slice(this.flushed);
      const endRel = afterBegin.indexOf(ASK_END);
      if (endRel < 0) {
        // Block not complete yet — withhold everything from the begin marker.
        break;
      }
      // Complete block: extract JSON, skip past end marker.
      const jsonStart = this.flushed + ASK_BEGIN.length;
      const jsonEnd = this.flushed + endRel;
      const json = this.buf.slice(jsonStart, jsonEnd).trim();
      if (json) this.completedQuestions.push(json);
      this.flushed += endRel + ASK_END.length;
    }
    return safe;
  }

  /** Returns parsed question JSON strings once full blocks have arrived. */
  takeQuestions(): string[] {
    const q = this.completedQuestions;
    this.completedQuestions = [];
    return q;
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
  /**
   * Task list being built from TaskCreate/TaskUpdate calls. The model this GUI
   * runs against exposes task management as TaskCreate/TaskUpdate (NOT the
   * TodoWrite tool the docs describe), so we accumulate the list here and emit
   * a full snapshot as todo.update on each change.
   */
  tasks: TodoUpdateEvent["todos"];
  /** Per-message sentinel scanners (hide AskUserQuestion JSON from the stream). */
  textScanners: Map<string, QuestionSentinelScanner>;
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
  /**
   * @param emit Send a normalized event to the renderer.
   * @param onClaudeSessionId Called once with claude's own session id, captured
   *   from the `system/init` line. The RuntimeManager persists it so subsequent
   *   turns can pass `--resume`. Separate from `emit` because RuntimeEvent has
   *   no variant that carries a raw session_id.
   */
  constructor(
    private readonly emit: (e: RuntimeEvent) => void,
    private readonly onClaudeSessionId?: (claudeSessionId: string) => void,
  ) {}

  private current: { child: ChildProcess; sessionId: string } | null = null;
  /** tracks whether we've already reported this turn's claude session id. */
  private reportedSessionId = false;

  /** Execute one turn. Resolves when claude exits (result line or close). */
  async runTurn(req: TurnRequest): Promise<void> {
    const spec = await resolveClaude();
    if (!spec) {
      const e: ErrorEvent = {
        type: "error",
        sessionId: req.sessionId,
        message: "Claude Code CLI not found. Configure its path in Settings (⚙) or install it (npm i -g @anthropic-ai/claude-code).",
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
    // model: only pass the flag when an explicit model is set (not "default").
    if (req.model && req.model !== "default") {
      args.push("--model", req.model);
    }
    // effort: only pass when an explicit level is set (not "default").
    if (req.effort && req.effort !== "default") {
      args.push("--effort", req.effort);
    }
    // permission mode: map our enum to claude's flag value
    const mode = req.permissionMode ?? "default";
    if (mode !== "default") args.push("--permission-mode", mode);

    // Inject the AskUserQuestion convention: this environment has no native
    // question tool, so we teach the model to emit questions as sentinel JSON,
    // which we intercept in the text stream (see QuestionSentinelScanner).
    args.push("--append-system-prompt", ASK_SYSTEM_PROMPT);

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
      tasks: [],
      textScanners: new Map(),
    };
    // A fresh spawn will emit its own system/init — allow capturing its id again.
    this.reportedSessionId = false;
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
    // The init line carries claude's own session_id. Capture it once per turn
    // so the RuntimeManager can persist it and the next turn can --resume.
    if (o.subtype === "init" && o.session_id && !this.reportedSessionId) {
      this.reportedSessionId = true;
      this.onClaudeSessionId?.(o.session_id);
      log.info(`captured claude session id: ${o.session_id} (gui session ${sessionId})`);
    }
    if (o.subtype === "status" && o.status) {
      log.info(`claude status: ${o.status}`);
    }
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
        // Filter the AskUserQuestion sentinel block out of the visible stream.
        // What's safe to show is emitted as text.delta; a complete block yields
        // a question.ask event instead.
        let scanner = state.textScanners.get(messageId);
        if (!scanner) {
          scanner = new QuestionSentinelScanner();
          state.textScanners.set(messageId, scanner);
        }
        const safe = scanner.push(delta.text);
        if (safe) {
          this.emit({ type: "text.delta", sessionId, messageId, text: safe } satisfies TextDeltaEvent);
        }
        for (const json of scanner.takeQuestions()) {
          // The JSON payload is itself { questions: [...] }.
          const questions = parseQuestions(safeJsonParse(json));
          if (questions.length > 0) {
            this.emit({ type: "question.ask", sessionId, questions } satisfies AskUserQuestionEvent);
          }
        }
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
        // Task management: the model this GUI runs against exposes tasks as
        // TaskCreate / TaskUpdate (verified by dump — NOT the TodoWrite tool
        // the stream-json docs describe). We accumulate the list on the turn
        // state and emit a full snapshot as todo.update on each change, so the
        // UI's tasks capsule stays in sync. The tool card still renders the
        // raw call; this is the structured view.
        if (b.name === "TaskCreate") {
          const subject = readStr((b.input as Record<string, unknown> | undefined)?.subject);
          if (subject) {
            state.tasks.push({ content: subject, status: "pending", priority: "medium" });
            this.emit({ type: "todo.update", sessionId, todos: [...state.tasks] });
          }
        } else if (b.name === "TaskUpdate") {
          const taskId = Number((b.input as Record<string, unknown> | undefined)?.taskId);
          const status = readStr((b.input as Record<string, unknown> | undefined)?.status);
          // taskId is 1-based into our append-ordered list.
          if (Number.isInteger(taskId) && taskId >= 1 && taskId <= state.tasks.length) {
            const norm = status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "pending";
            state.tasks[taskId - 1] = { ...state.tasks[taskId - 1], status: norm };
            this.emit({ type: "todo.update", sessionId, todos: [...state.tasks] });
          }
        } else if (b.name === "AskUserQuestion") {
          // Surface the structured question so the UI can render a prompt.
          // (The tool may be absent depending on model/version; this only
          // fires when claude actually emits it.)
          const questions = parseQuestions(b.input);
          if (questions.length > 0) {
            this.emit({ type: "question.ask", sessionId, questions } satisfies AskUserQuestionEvent);
          }
        }
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
    // Permission denials: mark each denied tool as errored so its card reflects
    // the rejection. (Interactive pre-execution approval isn't available on
    // claude 2.1.186 — see docs §10 — so this is the事后 view of what claude
    // itself refused, e.g. in plan mode.)
    for (const d of o.permission_denials ?? []) {
      if (!d.tool_use_id) continue;
      const e: ToolResultEvent = {
        type: "tool.result",
        sessionId,
        toolCallId: d.tool_use_id,
        isError: true,
        content: `Permission denied${d.tool_name ? ` (${d.tool_name})` : ""}`,
      };
      this.emit(e);
    }
    const reason = (o.stop_reason ?? o.is_error ? "error" : "end_turn") as TurnDoneEvent["reason"];
    const e: TurnDoneEvent = { type: "turn.done", sessionId, reason };
    this.emit(e);
  }
}

/* ──────────────────────────── helpers ──────────────────────────── */

/** Coerce an unknown value to a trimmed string, or "" if not string-like. */
function readStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** JSON.parse that returns undefined on failure (for the convention payload). */
function safeJsonParse<T>(s: string): T | undefined {
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

/**
 * Parse an AskUserQuestion tool's input (`{ questions: [...] }`) into the typed
 * shape the renderer expects. Drops malformed items silently; returns [] if
 * there's nothing usable.
 */
function parseQuestions(input: unknown): AskUserQuestionEvent["questions"] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestionEvent["questions"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const question = readStr(obj.question);
    const header = readStr(obj.header) || question.slice(0, 24);
    const multiSelect = obj.multiSelect === true;
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options = rawOptions
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => ({ label: readStr(o.label), description: readStr(o.description) || undefined }))
      .filter((o) => o.label);
    if (question) {
      out.push({ header, question, multiSelect, options });
    }
  }
  return out;
}

