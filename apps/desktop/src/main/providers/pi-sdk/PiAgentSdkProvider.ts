/**
 * Pi Agent SDK provider — wraps createAgentSession() from
 * @earendil-works/pi-coding-agent and implements the AgentProvider interface
 * from @contracts/provider.
 *
 * ## How Pi differs from Claude
 *   - Event model: subscribe(listener) callback stream, not an async iterator.
 *   - Turn drive: session.prompt(text) resolves when the run completes; the
 *     model streams via events.
 *   - Thinking levels: off/minimal/low/medium/high/xhigh (+ our "default"
 *     sentinel) — wider than Claude's 6.
 *   - No permission modes: Pi has a tools allowlist instead. We pass the
 *     permissionMode through to a tools whitelist mapping (see below).
 *   - Model selection: provider/id strings via ModelRuntime; we build our
 *     own ModelRuntime each turn and inject configured API keys via
 *     `modelRuntime.setRuntimeApiKey(provider, key)` (top of the auth
 *     priority chain — overrides ~/.pi/agent/auth.json and env vars).
 *   - Session resume: SessionManager JSONL files. We stash the pi session
 *     file path in the GUI session's `claudeSessionId` field (already the
 *     generic "provider session id" slot).
 *   - No canUseTool approval interception: tools execute directly. This is
 *     reflected in capabilities.supportsApproval=false.
 *
 * Lazy-loads the SDK module so the (large) package and its transitive deps
 * stay out of the main-process startup path — same pattern as
 * ClaudeAgentSdkProvider and TerminalManager.
 */
import type { AgentProvider, StartTurnRequest, ProviderContext, TurnHandle, ProviderCapabilities } from "@contracts/provider";
import { PiMessageAdapter } from "./PiMessageAdapter.js";
import { PiModelsStore } from "@main/lib/piModelsStore.js";
import { loadPiSdk } from "./piSdkLoader.js";

/**
 * Map the contract's open-string permissionMode to a Pi tools allowlist.
 * Pi has no built-in permission modes, but its tools allowlist is the closest
 * analogue:
 *   - "plan" / "default" → read-only tools (no edit/write)
 *   - "bypassPermissions" / "acceptEdits" → full tools
 *   - any unrecognized value → default (read + bash + edit + write)
 * Returns undefined when the mode has no tools restriction (use Pi defaults).
 */
function toolsForPermissionMode(mode: string | undefined): string[] | undefined {
  switch (mode) {
    case "plan":
      return ["read", "grep", "find", "ls"];
    default:
      return undefined; // Pi's default set (read, bash, edit, write)
  }
}

export class PiAgentSdkProvider implements AgentProvider {
  readonly id = "pi-sdk";
  readonly displayName = "Pi (Agent SDK)";
  readonly capabilities: ProviderCapabilities = {
    supportsApproval: false, // Pi tools execute directly; no canUseTool interception
    supportsResume: true, // SessionManager.continueRecent / open
    supportsStreaming: true, // subscribe() event stream
    supportsMcp: false, // Pi uses extensions, not MCP servers
    supportsAskUserQuestion: false, // no native AskUserQuestion tool
    // Declarative descriptors — the renderer's dynamic dropdowns read these.
    thinkingLevels: [
      { value: "default", label: "Auto", hint: "让 Pi 自选" },
      { value: "off", label: "Off", hint: "关闭思考" },
      { value: "minimal", label: "Minimal", hint: "极少思考" },
      { value: "low", label: "Low", hint: "快速" },
      { value: "medium", label: "Med", hint: "平衡" },
      { value: "high", label: "High", hint: "更多思考" },
      { value: "xhigh", label: "XHigh", hint: "深度思考" },
      { value: "max", label: "Max", hint: "最充分,最慢" },
    ],
    permissionModes: [], // Pi has no permission modes (tools allowlist only)
    builtinModels: [], // MVP: models come from ~/.pi/agent/models.json discovery
    supportsCustomEndpoint: false, // Pi manages its own models.json
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const sdk = await loadPiSdk();
    const ac = new AbortController();

    // Resolve the resume target: the persisted pi session file (if any).
    // We reuse the generic provider-session-id slot (`claudeSessionId`) which
    // RuntimeManager passes as `resumeProviderSessionId`. For pi this value is
    // the session file path.
    let sessionManager;
    if (req.resumeProviderSessionId) {
      try {
        sessionManager = sdk.SessionManager.open(req.resumeProviderSessionId);
      } catch (err) {
        ctx.log.warn(`pi: failed to open session file ${req.resumeProviderSessionId}, starting fresh: ${(err as Error).message}`);
        sessionManager = sdk.SessionManager.create(req.cwd);
      }
    } else {
      sessionManager = sdk.SessionManager.create(req.cwd);
    }

    // Map permission mode → tools allowlist (see toolsForPermissionMode).
    const tools = toolsForPermissionMode(req.permissionMode);

    // Build a ModelRuntime that injects all configured API keys. Pi's
    // setRuntimeApiKey stores the key at the top of the auth priority chain
    // (above ~/.pi/agent/auth.json and env vars), so the user's GUI-configured
    // key is authoritative. Keys are decrypted from the safeStorage-backed
    // map on every turn (one-shot, never persisted in this process).
    const modelRuntime = await sdk.ModelRuntime.create();
    try {
      const publicProviders = await PiModelsStore.listPublic();
      for (const [name, pub] of Object.entries(publicProviders)) {
        if (!pub.hasApiKey) continue;
        const key = PiModelsStore.resolveApiKey(name);
        if (key) {
          await modelRuntime.setRuntimeApiKey(name, key);
        }
      }
    } catch (err) {
      // Don't abort the turn on key-loading errors — the user may have an
      // env-var fallback. Log and proceed.
      ctx.log.warn(`pi: failed to load API keys (continuing without): ${(err as Error).message}`);
    }

    const { session } = await sdk.createAgentSession({
      cwd: req.cwd,
      thinkingLevel: req.effort && req.effort !== "default" ? (req.effort as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") : undefined,
      tools,
      sessionManager,
      modelRuntime,
    });

    // Register the pi session id with the host so it can be persisted and
    // resumed next turn.
    ctx.onProviderSessionId?.(session.sessionFile ?? session.sessionId);

    const adapter = new PiMessageAdapter(ctx, req.sessionId);
    const unsubscribe = session.subscribe((event) => {
      adapter.dispatch(event);
    });

    let finished = false;
    const done = (async () => {
      try {
        // session.prompt resolves when the agent finishes processing the
        // prompt (including retries). Streaming events arrive via subscribe.
        await session.prompt(req.prompt);
      } catch (err) {
        // A user-initiated abort makes prompt() reject.
        if (ac.signal.aborted) {
          ctx.emit({
            type: "turn.done",
            sessionId: req.sessionId,
            reason: "interrupted",
          });
        } else {
          ctx.log.error(`pi SDK error: ${(err as Error).message}`);
          ctx.emit({
            type: "error",
            sessionId: req.sessionId,
            message: (err as Error).message,
            code: "PI_SDK_ERROR",
          });
          ctx.emit({
            type: "turn.done",
            sessionId: req.sessionId,
            reason: "error",
          });
        }
      } finally {
        unsubscribe();
        session.dispose();
        finished = true;
      }
    })();

    return {
      done,
      interrupt: async () => {
        ac.abort();
        try {
          await session.abort();
        } catch {
          /* ignore */
        }
      },
      isRunning: () => !finished && !ac.signal.aborted,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const sdk = await loadPiSdk();
      // A minimal in-memory session creation probes whether the SDK can boot
      // with the current cwd and discover models. We don't send a prompt —
      // just verify the factory works.
      const { session } = await sdk.createAgentSession({
        sessionManager: sdk.SessionManager.inMemory(),
      });
      session.dispose();
      return { ok: true, version: (sdk as { VERSION?: string }).VERSION };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
