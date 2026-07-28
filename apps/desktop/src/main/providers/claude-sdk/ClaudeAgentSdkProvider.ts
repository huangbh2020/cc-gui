/**
 * Claude Agent SDK provider — wraps `query()` from @anthropic-ai/claude-agent-sdk
 * and implements the AgentProvider interface from @contracts/provider.
 *
 * This replaces the legacy ClaudeRuntime (spawn + NDJSON parse).
 * The SDK bundles its own claude binary, so ClaudePathResolver is no longer needed.
 */
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
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
import { buildCustomEnv } from "./customEnv.js";
import { getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";

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
  readonly displayName = "Claude (Agent SDK)";
  readonly capabilities: ProviderCapabilities = {
    supportsApproval: true,
    supportsResume: true,
    supportsStreaming: true,
    supportsMcp: true,
    supportsAskUserQuestion: true, // optimistic; may be negated at runtime
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const ac = new AbortController();
    // Look up the session's snapshot via the module-scope registry.
    // The runtime creates it lazily on first sendTurn and clears it
    // between turns; the provider only reads. No-op fallbacks if the
    // snapshot is missing (e.g. startTurn called without a preceding
    // sendTurn, which shouldn't happen but we don't want a crash).
    const snapshot = getFileSnapshot(req.sessionId);
    const adapter = new SdkMessageAdapter(
      ctx,
      req.sessionId,
      this.capabilities.supportsAskUserQuestion,
      req.cwd,
      snapshot,
    );

    const options: Options = {
      abortController: ac,
      cwd: req.cwd,
      model: req.model && req.model !== "default" ? req.model : undefined,
      // Per-turn reasoning effort. The contract's `EffortLevel` union includes
      // `"default"` (meaning "let the SDK pick / don't pass the option"); the
      // SDK's own `EffortLevel` does NOT have that sentinel, so we collapse
      // it to `undefined` here. Only the five named levels reach the wire.
      // See https://platform.claude.com/docs/en/build-with-claude/effort
      effort: req.effort && req.effort !== "default" ? req.effort : undefined,
      permissionMode: req.permissionMode,
      resume: req.resumeProviderSessionId ?? undefined,
      includePartialMessages: true,
      // SDK #359: On Windows there is a timing/buffering race in the stdio
      // control-stream transport that causes "Tool permission request failed:
      // AbortError: Tool permission stream closed before response received"
      // for subagent/MCP tools (WebSearch, WebFetch, etc.). Setting debug:true
      // forces synchronous control-channel flushing and eliminates the race.
      // See https://github.com/anthropics/claude-agent-sdk-typescript/issues/359
      debug: process.platform === "win32" ? true : undefined,
    };

    // Custom endpoint injection: when the host provides apiConfig, route this
    // turn to the user's Anthropic-compatible endpoint by setting the SDK env.
    //
    // The model id is driven through ANTHROPIC_MODEL (set inside buildCustomEnv
    // from the selected role's requestModel, with the `[1m]` suffix when the
    // role declares supports1m). We deliberately do NOT also set options.model
    // here: for a custom config the session's `model` field is a ROLE KEY
    // (e.g. "fable"), not a model id, and the binary already reads
    // ANTHROPIC_MODEL as its native model-override channel (verified in the
    // bundled binary's env-var allowlist). Driving both channels risks them
    // disagreeing (one bare, one suffixed) which produced "selected model may
    // not exist" failures against third-party gateways. ANTHROPIC_MODEL alone
    // matches DeepSeek's official Claude Code integration config.
    //
    // buildCustomEnv spreads process.env first (the SDK's env REPLACES the
    // subprocess env, so PATH/HOME/etc. must survive) then layers on auth,
    // per-tier background bindings, ANTHROPIC_MODEL, and non-essential-traffic
    // flags per the config.
    if (req.apiConfig) {
      options.env = buildCustomEnv(req.apiConfig);

      // CRITICAL: stop the bundled binary from reading ~/.claude/settings.json
      // and clobbering the env we just built.
      //
      // The claude binary re-reads filesystem settings AFTER spawn (function
      // Lft() inside claude.exe) and UNCONDITIONALLY overwrites process.env
      // with each settings source's `env` field — including
      // ~/.claude/settings.json (the "user" source). Tools like "cc switch"
      // (Claude Code Switch) write their active provider config to that file's
      // `env` block. So if cc switch currently points at, say, a MiniMax
      // gateway, those ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_*_MODEL values
      // overwrite our DeepSeek routing mid-boot, and the turn is sent to the
      // wrong endpoint with the wrong model name → gateway 404 "model may not
      // exist". This is exactly why a custom model only worked when cc switch
      // happened to be pointed at the SAME provider.
      //
      // The SDK exposes an official escape hatch: `settingSources` (→ the
      // `--setting-sources` CLI flag). Omitting it defaults to
      // ['user','project','local'] (CLI defaults), which includes the cc-switch
      // file. We pass ['project','local'] to SKIP the user-level file while
      // still loading project-level .claude/settings.json and CLAUDE.md (the
      // docstring notes `project` is required for CLAUDE.md). Project settings
      // are repo-scoped and intentional, so they're safe to keep; only the
      // global user file (cc switch's territory) is excluded.
      //
      // Only applied when apiConfig is set: the default Anthropic path leaves
      // settingSources untouched so normal ~/.claude/settings.json use (auth,
      // prefs) keeps working as the CLI intends.
      options.settingSources = ["project", "local"];

      // Diagnostic: dump the effective env actually handed to the SDK
      // subprocess, so model-routing failures against third-party gateways can
      // be triaged without a packet capture. Only the Anthropic-* / Claude-*
      // vars matter for routing; PATH/HOME/etc are filtered out for brevity.
      // Mask the auth token (keep first 2 / last 4) — never log cleartext.
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
        `claude custom env: selectedRole=${req.apiConfig.selectedRole} settingSources=${JSON.stringify(options.settingSources)} betas=${JSON.stringify(options.betas ?? null)} env=${JSON.stringify(diagEnv)}`,
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
    // in `supportedDialogKinds` — without the declaration the flow degrades to
    // its no-dialog behavior (the turn aborts) and the approval UI never shows.
    // See sdk.d.ts OnUserDialog / supportedDialogKinds docs.
    //
    // The exact dialogKind string for ExitPlanMode is an open union defined by
    // the bundled CLI binary, so we declare the likely candidates and let the
    // diagnostic log below surface the real value on first hit for future
    // tightening. Any non-matching kind is answered `cancelled` per SDK spec.
    const EXIT_PLAN_DIALOG_KINDS = new Set([
      "exit_plan_mode",
      "ExitPlanMode",
      "plan_approval",
    ]);
    const onUserDialog: OnUserDialog = async (request, opts) => {
      ctx.log.info(
        `onUserDialog: dialogKind=${request.dialogKind} toolUseID=${request.toolUseID ?? "n/a"} payloadKeys=${JSON.stringify(Object.keys(request.payload ?? {}))}`,
      );
      // ExitPlanMode plan approval: route to the existing plan-approval bridge
      // (renderer shows <PlanApprovalPrompt>). The model's plan text may live
      // under payload.plan (canonical) or payload.input.plan (older shape).
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

    const q = query({ prompt: req.prompt, options });

    let finished = false;
    const done = (async () => {
      try {
        for await (const m of q) {
          adapter.dispatch(m);
        }
        await adapter.flushFinal();
      } catch (err) {
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
      const q = query({
        prompt: "",
        options: {
          maxTurns: 0,
          includePartialMessages: false,
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
