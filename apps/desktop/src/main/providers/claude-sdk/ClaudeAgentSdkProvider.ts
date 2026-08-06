/**
 * Claude Agent SDK provider — wraps `query()` from @anthropic-ai/claude-agent-sdk
 * and implements the AgentProvider interface from @contracts/provider.
 *
 * This replaces the legacy ClaudeRuntime (spawn + NDJSON parse).
 * The SDK bundles its own claude binary, so ClaudePathResolver is no longer needed.
 */
import { randomUUID } from "node:crypto";
import type { Options, CanUseTool, OnUserDialog } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentProvider,
  StartTurnRequest,
  ProviderContext,
  TurnHandle,
  ProviderCapabilities,
  UserInputAnswers,
} from "@contracts/provider";
import type { AskUserQuestionItem, PermissionMode } from "@contracts/runtime";
import { SdkMessageAdapter, parseQuestions } from "./SdkMessageAdapter.js";
import { buildCustomEnv, MCODE_CONFIG_DIR } from "./customEnv.js";
import { getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { resolveSdkBinaryPath } from "./sdkBinaryPath.js";

// Lazy-load the Agent SDK so the (large) module and its bundled claude binary
// stay out of the main-process startup path. The SDK is only needed once the
// user sends their first message or a health check runs - both happen well
// after the window is visible. Mirrors the node-pty lazy-load pattern in
// TerminalManager.ts.
let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;
async function loadQuery(): Promise<typeof import("@anthropic-ai/claude-agent-sdk").query> {
  if (!queryFn) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = sdk.query;
  }
  return queryFn;
}

/** Tools that mutate files on disk — auto-approved under `acceptEdits`
 *  mode without prompting the user. Mirrors Claude Code's own grouping. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Decide whether a tool should be auto-approved (skip the prompt) based on
 *  the session's CURRENT permission mode. This runs in canUseTool on every
 *  call, so a mid-turn mode flip applies to the next tool immediately.
 *  - bypassPermissions / dontAsk → everything auto-approved
 *  - acceptEdits                  → file-editing tools auto-approved
 *  - default / plan / auto        → prompt the user (return false) */
function shouldAutoApprove(mode: PermissionMode | undefined, toolName: string): boolean {
  if (!mode) return false;
  if (mode === "bypassPermissions" || mode === "dontAsk") return true;
  if (mode === "acceptEdits") return FILE_EDIT_TOOLS.has(toolName);
  return false;
}

/** System prompt injected when the environment lacks native AskUserQuestion tool.
 * The model emits questions as sentinel-delimited JSON intercepted by SentinelScanner
 * inside SdkMessageAdapter. */
const ASK_SYSTEM_PROMPT = [
  `When you need to ask the user a question or need them to choose between options, you MUST emit it in this EXACT format and nothing else on those lines:`,
  `<<<ASK_USER_QUESTION>>>`,
  `a single line of JSON with this shape: {"questions":[{"header":"short label","question":"the full question","multiSelect":false,"options":[{"label":"A","description":"why A"},{"label":"B","description":"why B"}]}]}`,
  `<<<END_ASK_USER_QUESTION>>>`,
  `Rules: emit ONLY the JSON between the sentinels (no markdown fences, no extra text on those lines). Use multiSelect:true when multiple choices are allowed. After emitting, STOP and wait for the user's answer — do not answer your own question.`,
].join(" ");

export class ClaudeAgentSdkProvider implements AgentProvider {
  readonly id = "claude-sdk";
  readonly displayName = "Claude";
  readonly capabilities: ProviderCapabilities = {
    supportsApproval: true,
    supportsResume: true,
    supportsStreaming: true,
    supportsMcp: true,
    supportsAskUserQuestion: true, // optimistic; may be negated at runtime
    // Declarative descriptors for the renderer's dynamic dropdowns.
    thinkingLevels: [
      { value: "default", label: "Auto", hint: "让 Claude 自选" },
      { value: "low", label: "Low", hint: "最快,少思考" },
      { value: "medium", label: "Med", hint: "平衡" },
      { value: "high", label: "High", hint: "更多思考" },
      { value: "xhigh", label: "XHigh", hint: "深度思考" },
      { value: "max", label: "Max", hint: "最充分,最慢" },
    ],
    permissionModes: [
      { value: "default", label: "Default", icon: "shield", hint: "标准行为,工具按规则触发审批" },
      { value: "acceptEdits", label: "Edit Auto", icon: "shieldCheck", color: "text-warning", hint: "工作目录内的文件编辑自动放行" },
      { value: "plan", label: "Plan", icon: "shieldHalf", color: "text-info", hint: "只读探索,所有写操作都需审批" },
      { value: "bypassPermissions", label: "Bypass", icon: "shieldLock", color: "text-danger", hint: "跳过所有权限检查(慎用)" },
    ],
    builtinModels: [
      { id: "default", label: "Auto", hint: "让 Claude 自选" },
      { id: "sonnet", label: "Sonnet", hint: "claude-sonnet" },
      { id: "opus", label: "Opus", hint: "claude-opus" },
      { id: "fable", label: "Fable", hint: "claude-fable" },
    ],
    supportsCustomEndpoint: true,
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const ac = new AbortController();
    // Look up the session's snapshot via the module-scope registry.
    // The runtime creates it lazily on first sendTurn and clears it
    // between turns; the provider only reads. No-op fallbacks if the
    // snapshot is missing (e.g. startTurn called without a preceding
    // sendTurn, which shouldn't happen but we don't want a crash).
    const snapshot = getFileSnapshot(req.sessionId);

    const options: Options = {
      abortController: ac,
      cwd: req.cwd,
      model: req.model && req.model !== "default" ? req.model : undefined,
      // Per-turn reasoning effort. The contract's `EffortLevel` is now an open
      // string (so providers can declare their own levels); the SDK's own
      // `EffortLevel` is a narrow union (low/medium/high/xhigh/max). We collapse
      // "default" to `undefined` (don't pass the option) and cast the rest --
      // only the five named levels reach the wire, validated by the UI's
      // capabilities.thinkingLevels list.
      // See https://platform.claude.com/docs/en/build-with-claude/effort
      effort: req.effort && req.effort !== "default" ? (req.effort as Options["effort"]) : undefined,
      // Permission mode: the contract is an open string; the SDK's type is a
      // narrow union. The UI only offers claude's 4 modes for this provider
      // (declared in capabilities.permissionModes), so the cast is safe.
      permissionMode: req.permissionMode as Options["permissionMode"],
      resume: req.resumeProviderSessionId ?? undefined,
      includePartialMessages: true,
      // Skills: when the user picked specific skills in the composer, pass them
      // as an explicit allowlist so the model's `Skill` tool can actually reach
      // them. This is REQUIRED because query() runs the bundled binary with
      // `--input-format stream-json`, under which the CLI does NOT re-parse
      // `/name` slash commands from the prompt text — the `/name` literals the
      // composer inlines are display-only and would never trigger the Skill
      // tool on their own. With no picks, fall back to 'all' so the model can
      // still self-discover/autoloader skills. Do NOT also add 'Skill' to
      // allowedTools. See sdk.d.ts Options.skills.
      skills: req.skills && req.skills.length > 0 ? req.skills : "all",
      // SDK #359: On Windows there is a timing/buffering race in the stdio
      // control-stream transport that causes "Tool permission request failed:
      // AbortError: Tool permission stream closed before response received"
      // for subagent/MCP tools (WebSearch, WebFetch, etc.). Setting debug:true
      // forces synchronous control-channel flushing and eliminates the race.
      // See https://github.com/anthropics/claude-agent-sdk-typescript/issues/359
      debug: process.platform === "win32" ? true : undefined,
    };

    // In a packaged Electron app, the SDK resolves its bundled `claude` binary
    // to a path INSIDE app.asar. spawn() can't execute an .exe from the asar
    // virtual fs ("exists but failed to launch"), so we point it at the real
    // on-disk copy under app.asar.unpacked. No-op in dev (null -> SDK resolves
    // node_modules itself). See sdkBinaryPath.ts for the full rationale.
    const binaryPath = resolveSdkBinaryPath();
    if (binaryPath) options.pathToClaudeCodeExecutable = binaryPath;

    // Plan files location: the bundled CLI forces the model to write its plan
    // to a file before calling ExitPlanMode (the tool errors with "No plan file
    // found ... Please write your plan to this file before calling ExitPlanMode"
    // if the file is missing). The plan directory is resolved by the CLI from
    // the `plansDirectory` setting (must be within project root), defaulting to
    // ~/.claude/plans/ when unset. Without this, plan files leak into the
    // GLOBAL ~/.claude/plans/ directory instead of staying project-scoped.
    //
    // We set it to ".claude/plans" (relative to cwd = project root) via the
    // flag-settings layer (Options.settings), which has the highest
    // user-controlled priority and applies regardless of `settingSources`.
    // Add ".claude/plans/" to .gitignore to keep these ephemeral drafts out of
    // version control.
    options.settings = { plansDirectory: ".claude/plans" };

    // Always redirect the claude binary's user-level config root to Mcode's
    // own directory (~/.mcode) via CLAUDE_CONFIG_DIR. This decouples Mcode from
    // the user's Claude Code CLI installation: tools like "cc switch" that
    // overwrite ~/.claude/settings.json no longer affect Mcode's turns, and
    // user-level skills are loaded from ~/.mcode/skills/ (where Mcode's import
    // feature places them). Applied to BOTH the standard and custom-endpoint
    // paths so behavior is consistent.
    //
    // The SDK's Options.env REPLACES the subprocess env entirely (per sdk.d.ts),
    // so we always spread process.env first - otherwise PATH/HOME disappear and
    // the binary can't boot.
    if (req.apiConfig) {
      // Custom endpoint: buildCustomEnv layers on auth, per-tier model bindings,
      // and CLAUDE_CONFIG_DIR on top of process.env.
      options.env = buildCustomEnv(req.apiConfig);
    } else {
      // Standard Anthropic endpoint: still redirect the config root so Mcode
      // manages its own skills/settings, but no auth/model overrides needed.
      options.env = { ...process.env, CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR };
    }

    // NOTE: we do NOT set `settingSources` here. The default
    // ["user","project","local"] is safe because CLAUDE_CONFIG_DIR points at
    // ~/.mcode - the cc-switch-controlled ~/.claude/settings.json is never
    // read (the config root moved). The "user" source now resolves to
    // ~/.mcode/settings.json (which Mcode controls), and user-level skills
    // under ~/.mcode/skills/ are discovered by the binary's auto-load. The
    // previous settingSources:["project","local"] workaround is no longer
    // needed and was actively harmful: it disabled user-level skill discovery.

    // Diagnostic: dump the effective env actually handed to the SDK
    // subprocess, so model-routing failures against third-party gateways can
    // be triaged without a packet capture. Only the Anthropic-* / Claude-*
    // vars matter for routing; PATH/HOME/etc are filtered out for brevity.
    // Mask the auth token (keep first 2 / last 4) - never log cleartext.
    if (req.apiConfig) {
      const diagEnv: Record<string, string | undefined> = {};
      const diagKeys = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "API_TIMEOUT_MS",
      ];
      const e = options.env as Record<string, string | undefined>;
      for (const k of diagKeys) {
        if (e[k] !== undefined) diagEnv[k] = e[k];
      }
      const tok = e.ANTHROPIC_AUTH_TOKEN ?? e.ANTHROPIC_API_KEY;
      diagEnv.__authTokenMasked = tok ? `${tok.slice(0, 2)}***${tok.slice(-4)} (mode=${e.ANTHROPIC_API_KEY ? "api_key" : "auth_token"})` : "(none)";
      ctx.log.info(
        `claude custom env: selectedRole=${req.apiConfig.selectedRole} betas=${JSON.stringify(options.betas ?? null)} env=${JSON.stringify(diagEnv)}`,
      );
    }

    // --- canUseTool bridge ---
    // Three kinds of tool calls route through here:
    //  (a) AskUserQuestion — BLOCKS via ctx.requestUserInput (Deferred). The
    //      user's answers come back as `updatedInput.answers`, the SDK hands
    //      them to the model, and the SAME turn continues. This is the only
    //      way the conversation proceeds after a question — see
    //      https://code.claude.com/docs/en/agent-sdk/user-input. Returning
    //      null here (the old behavior) left the tool blocked indefinitely
    //      while onUserDialog cancelled it, ending the turn prematurely.
    //  (b) ExitPlanMode — BLOCKS via ctx.requestPlanApproval (Deferred). The
    //      model has drafted a plan in plan mode and needs user approval to
    //      proceed. Allow → SDK exits plan mode for this turn; deny → stays
    //      in plan mode and the model can revise.
    //  (c) every other tool — standard host-moderated approval via
    //      ctx.requestApproval.
    const requestApproval = ctx.requestApproval;
    const requestUserInput = ctx.requestUserInput;
    const requestPlanApproval = ctx.requestPlanApproval;

    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      if (toolName === "AskUserQuestion") {
        // AskUserQuestion only fires here when the native tool is available
        // (capabilities.supportsAskUserQuestion). Sentinel fallback path
        // doesn't reach canUseTool.
        if (!requestUserInput) {
          // No host bridge wired — fall back to deny so the model isn't stuck.
          return { behavior: "deny", message: "User input not available" };
        }
        const questions = parseQuestions(input);
        if (questions.length === 0) {
          return { behavior: "deny", message: "Malformed AskUserQuestion input" };
        }
        const requestId = randomUUID();
        const decision = await requestUserInput({
          requestId,
          toolUseId: opts.toolUseID,
          questions,
        });
        // Build the SDK's expected answers map: { [question.text]: label }.
        // SDK accepts a string (single label or comma-joined) per question.
        const sdkAnswers: Record<string, string> = {};
        for (const q of questions) {
          const v = decision.answers[q.question];
          if (v == null) continue;
          sdkAnswers[q.question] = Array.isArray(v) ? v.join(", ") : v;
        }
        return {
          behavior: "allow",
          updatedInput: { questions: input.questions, answers: sdkAnswers },
        };
      }

      if (toolName === "ExitPlanMode") {
        // Fallback path: newer SDK versions route ExitPlanMode approval through
        // onUserDialog (request_user_dialog) instead of canUseTool, so this
        // branch is typically NOT reached. It's kept as a defensive fallback
        // for SDK versions / code paths that still use can_use_tool. The real
        // handling lives in onUserDialog above.
        ctx.log.info("canUseTool: ExitPlanMode fallback path hit (expected to be handled by onUserDialog)");
        // Plan mode: the model has drafted a plan and is asking the user to
        // approve it before execution. The plan text arrives in input.plan
        // (the SDK's ExitPlanModeInput type omits it, but it's present at
        // runtime). Allow → SDK exits plan mode for this turn; deny → SDK
        // stays in plan mode and the model can revise. See
        // https://docs.snowflake.com/en/user-guide/cortex-code-agent-sdk/user-input
        if (!requestPlanApproval) {
          return { behavior: "deny", message: "Plan approval not available" };
        }
        const plan = typeof (input as { plan?: unknown })?.plan === "string"
          ? ((input as { plan: string }).plan)
          : "";
        const requestId = randomUUID();
        const decision = await requestPlanApproval({
          requestId,
          plan,
          toolUseId: opts.toolUseID,
        });
        if (decision.approved) {
          const finalPlan = decision.editedPlan ?? plan;
          return {
            behavior: "allow",
            updatedInput: { ...input, plan: finalPlan, message: "Plan approved by user" },
          };
        }
        return {
          behavior: "deny",
          message: decision.reason ?? "Plan rejected by user",
        };
      }

      // Standard tool approval. Before prompting the user, check two
      // host-side gates so the change takes effect immediately:
      //  (1) "always allow" — the user previously granted this tool with
      //      the always checkbox; skip the prompt for the rest of the session.
      //  (2) permission mode — bypassPermissions/dontAsk auto-allows every
      //      tool; acceptEdits auto-allows file-editing tools. The SDK's own
      //      permissionMode option is fixed at query() start, but our host
      //      gate reads the LIVE value so a mid-turn flip applies to the
      //      next tool right away.
      if (ctx.isToolAlwaysAllowed?.(toolName)) {
        return { behavior: "allow" };
      }
      const mode = ctx.getPermissionMode?.();
      if (shouldAutoApprove(mode, toolName)) {
        return { behavior: "allow" };
      }

      if (!requestApproval) {
        return { behavior: "allow" };
      }
      const r = await requestApproval({
        requestId: randomUUID(),
        toolName,
        input,
      });
      return r.allow
        ? { behavior: "allow" as const, updatedInput: r.updatedInput as Record<string, unknown> | undefined }
        : { behavior: "deny" as const, message: r.reason ?? "Denied by user" };
    };
    options.canUseTool = canUseTool;

    // --- onUserDialog bridge ---
    // SDK 0.3.x routes ExitPlanMode's user-approval step through
    // `request_user_dialog` control requests (dialogKind-based), NOT through
    // canUseTool. The CLI is fail-closed: it only emits a dialog kind declared
    // in `supportedDialogKinds` - without the declaration the flow degrades to
    // its no-dialog behavior (the turn aborts with "Tool permission request
    // failed: AbortError: Stream closed") and the approval UI never shows.
    // See sdk.d.ts OnUserDialog / supportedDialogKinds docs.
    //
    // The real dialogKind for ExitPlanMode is `permission_exit_plan_mode_v2`,
    // confirmed by analyzing the bundled claude.exe v2.1.218 binary: the
    // ExitPlanMode tool (var `oz`, name "ExitPlanMode") is mapped to dialog
    // `fcr` whose `.kind` is "permission_exit_plan_mode_v2" in the LBy routing
    // table (KUe({matches:(e)=>e===oz, dialog:fcr, build:qZu})). The CLI gates
    // emission on `ewt() && (twt() ?? []).includes(dialogKind)`, so a mismatch
    // silently suppresses the dialog. The legacy guesses below are kept as
    // defensive fallbacks in case a future SDK version renames the kind.
    const EXIT_PLAN_DIALOG_KINDS = new Set([
      "permission_exit_plan_mode_v2", // real value (claude.exe v2.1.218)
      "exit_plan_mode", // legacy guess - defensive
      "ExitPlanMode", // legacy guess - defensive
      "plan_approval", // legacy guess - defensive
    ]);
    const onUserDialog: OnUserDialog = async (request, opts) => {
      ctx.log.info(
        `onUserDialog: dialogKind=${request.dialogKind} toolUseID=${request.toolUseID ?? "n/a"} payloadKeys=${JSON.stringify(Object.keys(request.payload ?? {}))}`,
      );
      // ExitPlanMode plan approval: route to the existing plan-approval bridge
      // (renderer shows <PlanApprovalPrompt>). The model's plan text lives in
      // payload.plan (the qZu build fn sets {requestId, toolName,
      // permissionResult, plan, planFilePath, usage}); fall back to the older
      // payload.input.plan shape for SDK versions that nested it there.
      if (EXIT_PLAN_DIALOG_KINDS.has(request.dialogKind) || typeof (request.payload as { plan?: unknown })?.plan === "string") {
        if (!requestPlanApproval) {
          return { behavior: "cancelled" as const };
        }
        const p = request.payload as { plan?: unknown; input?: { plan?: unknown } };
        const plan = typeof p.plan === "string" ? p.plan
          : typeof p.input?.plan === "string" ? p.input.plan
          : "";
        const requestId = request.toolUseID ?? randomUUID();
        const decision = await requestPlanApproval({
          requestId,
          plan,
          toolUseId: request.toolUseID,
        });
        if (decision.approved) {
          const finalPlan = decision.editedPlan ?? plan;
          return {
            behavior: "completed" as const,
            result: { approved: true, plan: finalPlan, message: "Plan approved by user" },
          };
        }
        return {
          behavior: "completed" as const,
          result: { approved: false, reason: decision.reason ?? "Plan rejected by user" },
        };
      }
      // Unrecognized dialog kind — SDK requires `cancelled` so the CLI applies
      // its default behavior for that dialog.
      return { behavior: "cancelled" as const };
    };
    options.onUserDialog = onUserDialog;
    options.supportedDialogKinds = Array.from(EXIT_PLAN_DIALOG_KINDS);

    // --- systemPrompt for AskUserQuestion fallback ---
    // When native AskUserQuestion tool is unavailable, inject the sentinel
    // convention so the model can surface questions in text.
    if (!this.capabilities.supportsAskUserQuestion) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: ASK_SYSTEM_PROMPT,
      };
    }

    const q = (await loadQuery())({ prompt: req.prompt, options });

    const adapter = new SdkMessageAdapter(
      ctx,
      req.sessionId,
      this.capabilities.supportsAskUserQuestion,
      req.cwd,
      snapshot,
      ac.signal,
      q,
      req.initialTodos ?? [],
    );

    let finished = false;
    const done = (async () => {
      try {
        for await (const m of q) {
          await adapter.dispatch(m);
        }
        await adapter.flushFinal();
      } catch (err) {
        // A user-initiated stop (ac.abort()) makes the SDK's async iterator
        // throw an AbortError. That's NOT an error condition - run the normal
        // end-of-turn finalization so flushFinal() can mark still-running
        // subagents as "killed" (reflecting the user's stop intent), emit the
        // final subagent.update (which RuntimeManager persists to the DB so
        // the killed state survives a session reopen), and emit the closing
        // turn.done with reason "interrupted". Skipping flushFinal here would
        // leave the persisted roster at its stale mid-stream "running" value,
        // so re-entering the thread would resurrect "运行中" subagents.
        if (ac.signal.aborted) {
          await adapter.flushFinal();
        } else {
          ctx.log.error(`claude SDK error: ${(err as Error).message}`);
          ctx.emit({
            type: "error",
            sessionId: req.sessionId,
            message: (err as Error).message,
            code: "SDK_ERROR",
          });
          ctx.emit({
            type: "turn.done",
            sessionId: req.sessionId,
            reason: "error",
          });
        }
      } finally {
        finished = true;
      }
    })();

    return {
      done,
      interrupt: () => ac.abort(),
      isRunning: () => !finished && !ac.signal.aborted,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      // A quick probe: spawn a minimal query and capture the system/init message
      // to verify the SDK binary is functional.
      const binaryPath = resolveSdkBinaryPath();
      const q = (await loadQuery())({
        prompt: "",
        options: {
          maxTurns: 0,
          includePartialMessages: false,
          ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
        },
      });
      // We just need the first system/init message to confirm the binary works.
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          return { ok: true, version: (m as { claude_code_version?: string }).claude_code_version };
        }
      }
      return { ok: false, error: "No system/init message received" };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
