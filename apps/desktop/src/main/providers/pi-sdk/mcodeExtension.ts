/**
 * Inline Pi extension — bridges Mcode's host-side approval, AskUserQuestion,
 * and system-prompt capabilities into the Pi agent via the SDK's extension API.
 *
 * ## Why an extension (not customTools wrapping)
 *
 * The previous implementation wrapped `write`/`edit`/`bash` tool definitions
 * via `customTools` same-name override (see `createGuardedFileTools` /
 * `createGuardedBashTool` in the pre-refactor `PiAgentSdkProvider`). That had
 * three limitations the extension model fixes:
 *
 *   1. **Coverage**: customTools only intercept the 3 wrapped tools. The
 *      `tool_call` event fires for *every* tool (bash/read/edit/write/grep/
 *      find/ls + extension-registered), so the path/command guard and the
 *      approval prompt now apply uniformly.
 *   2. **Approval**: Pi's SDK has no `canUseTool` callback. The `tool_call`
 *      event with `{ block: true, reason }` is the equivalent — the agent loop
 *      converts a block into an `isError` tool result the model can react to
 *      (verified: `agent-loop.js` `prepareToolCall` → `createErrorToolResult`).
 *   3. **AskUserQuestion**: the extension registers a native tool the model
 *      calls autonomously; `execute` bridges to the host's
 *      `requestUserInput` IPC. This replaces the sentinel-text fallback.
 *
 * ## Injection
 *
 * The factory is passed as an `InlineExtension` via
 * `DefaultResourceLoader({ extensionFactories })`. The loader calls
 * `factory(pi)` during `getExtensions()` (before `_refreshToolRegistry`), so
 * `pi.registerTool` / `pi.on` are wired before the first turn. Inline
 * extensions survive `session.reload()` — `loadExtensionFactories` runs in
 * both the initial and reload code paths.
 *
 * ## Argument mutation
 *
 * `event.input` is the same object reference as the `validatedArgs` the agent
 * loop will pass to `tool.execute` (verified: `validateToolArguments` returns
 * a `structuredClone`, passed by reference through `beforeToolCall` →
 * `emitToolCall` → handler → `prepared.args`). So in-place mutation of
 * `event.input.path` is the equivalent of Claude's `updatedInput` — the
 * rewritten path reaches the actual tool execution.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type {
  InlineExtension,
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import type { ProviderContext } from "@contracts/provider";
import type { PermissionMode } from "@contracts/runtime";
import { normalizeToolFilePath } from "@main/lib/fileSnapshot.js";
import { guardBashCommand, expandTilde } from "./bashWriteGuard.js";
import {
  parseQuestions,
  formatAnswersForModel,
  ASK_SYSTEM_PROMPT,
} from "@main/lib/askQuestion.js";

/** Pi's write/edit tools carry their target path in the `path` field (unlike
 *  Claude's `file_path`). Both schemas are `{ path, ... }`. */
type PathToolParams = { path?: unknown };

/**
 * Guard a file-tool path. Mirrors the Claude provider's canUseTool guard:
 * WSL-style `/mnt/<drive>/...` paths are normalized to native Windows paths
 * (otherwise they'd resolve to a garbage `D:\mnt\...` folder), and writes
 * resolving outside the project working directory are denied except in
 * bypassPermissions/dontAsk, where the user explicitly opted out of all checks.
 *
 * This is the same logic the pre-refactor `guardToolPath` in
 * `PiAgentSdkProvider` implemented — extracted here so the `tool_call` handler
 * and the (still-used) customTools read-wrapper share one implementation.
 */
export function guardToolPath(
  cwd: string,
  rawPath: string,
  strict: boolean,
): { denied: true; message: string } | { denied: false; path: string } {
  const norm = normalizeToolFilePath(cwd, expandTilde(rawPath));
  if (!norm) return { denied: false, path: rawPath };
  if (!norm.insideProject && strict) {
    return {
      denied: true,
      message: `拒绝:目标路径在项目工作目录之外(${norm.absPath})。只允许在项目目录内写入文件,请改用相对路径。`,
    };
  }
  // Rewrite to the normalized absolute path so the write lands where the user
  // expects — an in-project `/mnt/d/...` path would otherwise resolve to a
  // garbage `D:\mnt\...` folder on Windows.
  return { denied: false, path: norm.absPath };
}

/**
 * Decide whether a Pi tool should be auto-approved (skip the prompt) based on
 * the session's CURRENT permission mode. Mirrors the Claude provider's
 * `shouldAutoApprove`, but uses Pi's lowercase tool names
 * (`write`/`edit` not `Write`/`Edit`).
 *
 *   - bypassPermissions / dontAsk → everything auto-approved
 *   - acceptEdits                  → file-editing tools auto-approved
 *   - default / plan / auto        → prompt the user (return false)
 */
function shouldAutoApproveForPi(mode: PermissionMode | undefined, toolName: string): boolean {
  if (!mode) return false;
  if (mode === "bypassPermissions" || mode === "dontAsk") return true;
  if (mode === "acceptEdits") return toolName === "write" || toolName === "edit";
  return false;
}

export interface CreateMcodeExtensionOptions {
  /** The host provider context — carries the IPC bridges for approval /
   *  user-input / permission-mode / always-allow checks. */
  ctx: ProviderContext;
  /** Project working directory. */
  cwd: string;
  /** Strict in-project policy: deny writes outside cwd. False in
   *  bypassPermissions/dontAsk (user opted out of all checks). */
  strict: boolean;
}

/**
 * Build the inline Mcode extension. Returned as an `InlineExtension` (named
 * form) so it shows up as `<inline:mcode>` in Pi's startup Extensions list —
 * useful for debugging whether the extension loaded.
 */
export function createMcodeExtension(opts: CreateMcodeExtensionOptions): InlineExtension {
  const { ctx, cwd, strict } = opts;

  return {
    name: "mcode",
    factory: (pi: ExtensionAPI) => {
      registerToolCallGuard(pi, { ctx, cwd, strict });
      registerAskUserQuestionTool(pi, ctx);
      registerSystemPromptInjector(pi);
    },
  };
}

/**
 * `tool_call` handler — the Pi equivalent of Claude's `canUseTool`.
 *
 * Runs before every tool execution. Three responsibilities, in order:
 *   1. Path/command guard (write/edit/bash) — replaces the old customTools
 *      wrapping. Denials return `{ block: true, reason }`; path normalization
 *      mutates `event.input` in place (same-ref → reaches execution).
 *   2. AskUserQuestion bypass — the tool's own `execute` handles the IPC, so
 *      we never send it through the approval flow.
 *   3. Host approval — permission-mode auto-approve, always-allow, then the
 *      IPC approval prompt.
 */
function registerToolCallGuard(
  pi: ExtensionAPI,
  deps: { ctx: ProviderContext; cwd: string; strict: boolean },
): void {
  const { ctx, cwd, strict } = deps;

  pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
    const { toolName } = event;

    // ① Path guard for write/edit.
    //    `event.input` is a shared reference with the args the agent will pass
    //    to execute, so mutating it in place is equivalent to Claude's
    //    `updatedInput` round-trip.
    if (toolName === "write" || toolName === "edit") {
      const input = event.input as PathToolParams;
      const raw = input.path;
      if (typeof raw === "string" && raw.length > 0) {
        const checked = guardToolPath(cwd, raw, strict);
        if (checked.denied) {
          return { block: true, reason: checked.message };
        }
        if (checked.path !== raw) {
          input.path = checked.path;
        }
      }
    }

    // ② Bash write-target guard. Same scope/limits as the pre-refactor
    //    createGuardedBashTool — NOT a sandbox, just blocks the common
    //    "write a helper script outside the project" pattern.
    if (toolName === "bash") {
      const input = event.input as { command?: unknown };
      const command = input.command;
      if (typeof command === "string" && command.length > 0) {
        const denial = guardBashCommand(cwd, command, strict);
        if (denial) {
          return { block: true, reason: denial };
        }
      }
    }

    // ③ AskUserQuestion — its own execute() does the IPC bridging; never route
    //    through the approval prompt.
    if (toolName === "AskUserQuestion") {
      return;
    }

    // ④ Permission-mode auto-approve (reads the LIVE mode so a mid-turn flip
    //    applies to the next tool immediately).
    const mode = ctx.getPermissionMode?.();
    if (shouldAutoApproveForPi(mode, toolName)) {
      return;
    }
    if (ctx.isToolAlwaysAllowed?.(toolName)) {
      return;
    }

    // ⑤ Host-moderated approval via IPC. When no bridge is wired, fall open
    //    (fail-open matches the Claude provider's behavior when requestApproval
    //    is undefined).
    const requestApproval = ctx.requestApproval;
    if (!requestApproval) {
      return;
    }
    const r = await requestApproval({
      requestId: randomUUID(),
      toolName,
      input: event.input,
    });
    return r.allow ? undefined : { block: true, reason: r.reason ?? "Denied by user" };
  });
}

/**
 * Register a native `AskUserQuestion` tool. The model calls it autonomously;
 * `execute` bridges to the host's `requestUserInput` IPC (the same one the
 * Claude provider's canUseTool uses), and returns the user's answers as a
 * text tool result the model reads as its reply.
 *
 * This replaces the sentinel-text fallback (model emits
 * `<<<ASK_USER_QUESTION>>>` JSON that the adapter scans for). The native tool
 * is more reliable — no format drift, the model gets a structured result
 * back, and the question panel opens deterministically.
 */
function registerAskUserQuestionTool(pi: ExtensionAPI, ctx: ProviderContext): void {
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask User Question",
    description:
      "Ask the user a question when you need information or a decision. " +
      "Provide a clear question and 2-4 options the user can choose from. " +
      "After calling this tool, STOP and wait for the user's answer.",
    promptSnippet: "AskUserQuestion: ask the user a question with selectable options",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          header: Type.String({ description: "A short label for the question" }),
          question: Type.String({ description: "The full question text" }),
          multiSelect: Type.Boolean({
            description: "Whether the user can select multiple options",
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: "The option label" }),
              description: Type.Optional(
                Type.String({ description: "Why this option, or its consequence" }),
              ),
            }),
          ),
        }),
      ),
    }),
    async execute(toolCallId, params) {
      const requestUserInput = ctx.requestUserInput;
      if (!requestUserInput) {
        throw new Error("User input not available");
      }
      const questions = parseQuestions(params);
      if (questions.length === 0) {
        throw new Error("Malformed AskUserQuestion input: no valid questions");
      }
      const requestId = randomUUID();
      const decision = await requestUserInput({
        requestId,
        toolUseId: toolCallId,
        questions,
      });
      return {
        content: [
          { type: "text", text: formatAnswersForModel(decision.answers, questions) },
        ],
        details: {},
      };
    },
  });
}

/**
 * `before_agent_start` handler — injects the AskUserQuestion usage hint into
 * the system prompt. The event fires each turn before the agent loop starts;
 * returning `systemPrompt` overrides `agent.state.systemPrompt` for the turn.
 *
 * The injected text is the same `ASK_SYSTEM_PROMPT` the Claude provider uses
 * for its sentinel fallback — kept in one place (`@main/lib/askQuestion`) to
 * avoid drift. On Pi the native tool IS available, so the sentinel format is
 * informational (the model may still emit it, and the PiMessageAdapter could
 * scan for it as a backstop), but the primary path is the native tool.
 */
function registerSystemPromptInjector(pi: ExtensionAPI): void {
  pi.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | void> => {
      const base = event.systemPrompt ?? "";
      const next = base ? `${base}\n\n${ASK_SYSTEM_PROMPT}` : ASK_SYSTEM_PROMPT;
      return { systemPrompt: next };
    },
  );
}
