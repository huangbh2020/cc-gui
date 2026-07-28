/**
 * RuntimeManager — per-session turn lifecycle, now provider-agnostic.
 *
 * Replaces the old ClaudeRuntime-based implementation. Instead of `new ClaudeRuntime()`,
 * it resolves a provider from the registry and constructs a ProviderContext that bridges
 * events to the renderer and async approval/user-input requests via ApprovalBridge.
 */
import { sendToRenderer } from "@main/window.js";
import { IPC } from "@contracts/ipc";
import type { RuntimeEvent, PermissionMode } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import type { ProviderContext, TurnHandle, StartTurnRequest, UserInputAnswers, PlanApprovalDecision } from "@contracts/provider";
import { providerRegistry } from "@main/providers/registry.js";
import { SessionRepo } from "@main/store/repositories.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { ApprovalBridge } from "./ApprovalBridge.js";
import { getFileSnapshot, dropFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { log } from "@main/lib/logger.js";

interface SessionRuntime {
  /** The TurnHandle for the currently running turn, if any. */
  handle?: TurnHandle;
  /** The claude/provider session id captured from the system/init message. */
  providerSessionId: string | null;
  /** ProviderContext (long-lived for the session). */
  ctx: ProviderContext;
  /** Cwd of the most recent (or current) turn. Stashed so rewindTurn
   *  can resolve snapshot paths without having to ask the provider
   *  (the TurnHandle interface doesn't expose it). */
  lastCwd: string | null;
}

const approvalBridge = new ApprovalBridge();

class RuntimeManager {
  private sessions = new Map<string, SessionRuntime>();

  /** Create or reuse the runtime state for a GUI session. Idempotent. */
  bindSession(session: Session): void {
    if (this.sessions.has(session.id)) return;

    const emit = (e: RuntimeEvent) => {
      sendToRenderer(IPC.CLAUDE_EVENT, { channel: IPC.CLAUDE_EVENT, sessionId: e.sessionId, event: e });
      // Persist capsule state so the top-right status pill reloads on
      // session reopen. Each event type → one Repo call, fire-and-forget.
      // contextSnapshot / todos / subagents / planDraft are all JSON blobs.
      if (e.type === "token-usage.updated") {
        try {
          SessionRepo.updateSnapshot(session.id, e.snapshot);
        } catch (err) {
          log.error(`failed to persist context snapshot: ${(err as Error).message}`);
        }
      } else if (e.type === "todo.update") {
        try {
          SessionRepo.updateTodos(session.id, e.todos);
        } catch (err) {
          log.error(`failed to persist todos: ${(err as Error).message}`);
        }
      } else if (e.type === "subagent.update") {
        try {
          SessionRepo.updateSubagents(session.id, e.agents);
        } catch (err) {
          log.error(`failed to persist subagents: ${(err as Error).message}`);
        }
      } else if (e.type === "plan.update") {
        try {
          SessionRepo.updatePlanDraft(session.id, { plan: e.plan, phase: e.phase });
        } catch (err) {
          log.error(`failed to persist plan draft: ${(err as Error).message}`);
        }
      } else if (e.type === "turn.files") {
        // Persist the per-turn modified-files snapshot so the "本轮修改" card
        // survives a session reopen. The payload already carries adds/dels/before
        // (computed in FileSnapshot.freeze), so we store it verbatim.
        try {
          SessionRepo.updateTurnFiles(session.id, e.files);
        } catch (err) {
          log.error(`failed to persist turn files: ${(err as Error).message}`);
        }
      } else if (e.type === "turn.rewound") {
        // A rewind voids the last turn's edits — clear the persisted snapshot
        // too, otherwise the card would reappear on reopen after being dismissed.
        try {
          SessionRepo.updateTurnFiles(session.id, null);
        } catch (err) {
          log.error(`failed to clear turn files after rewind: ${(err as Error).message}`);
        }
      }
    };

    const onProviderSessionId = (id: string) => {
      const rt = this.sessions.get(session.id);
      if (!rt) return;
      if (rt.providerSessionId === id) return;
      rt.providerSessionId = id;
      try {
        SessionRepo.updateClaudeSessionId(session.id, id);
      } catch (err) {
        log.error(`failed to persist provider session id: ${(err as Error).message}`);
      }
    };

    const ctx: ProviderContext = {
      emit,
      onProviderSessionId,
      log,
      requestApproval: approvalBridge.makeApprovalHandler(session.id, emit),
      requestUserInput: approvalBridge.makeUserInputHandler(session.id, emit),
      requestPlanApproval: approvalBridge.makePlanApprovalHandler(session.id, emit),
      // Expose the per-session always-allow set + current permission mode so
      // the provider's canUseTool can short-circuit without prompting the
      // renderer. Both read the live bridge state, so a mid-turn mode flip
      // (setPermissionMode) is visible to the next tool call immediately.
      isToolAlwaysAllowed: (toolName: string) => approvalBridge.isAlwaysAllowed(session.id, toolName),
      getPermissionMode: () => approvalBridge.getPermissionMode(session.id),
    };
    // Seed the session's permission mode so canUseTool sees the right value
    // from the first tool call (subsequent flips via setPermissionMode update it).
    approvalBridge.setPermissionMode(session.id, session.permissionMode);

    this.sessions.set(session.id, {
      providerSessionId: session.claudeSessionId,
      ctx,
      lastCwd: null,
    });
  }

  /** Send a user message to the provider and stream events back. */
  async sendTurn(session: Session, input: { prompt: string; cwd: string }): Promise<void> {
    const rt = this.sessions.get(session.id);
    if (!rt) {
      log.warn(`sendTurn: no runtime bound for session ${session.id}`);
      return;
    }
    if (rt.handle?.isRunning()) {
      log.warn(`sendTurn: session ${session.id} already running, ignoring`);
      return;
    }

    const provider = providerRegistry.resolve(session.providerId);

    // Reset the per-turn file snapshot before the new turn. This is
    // what makes "rewind last turn" work correctly across consecutive
    // turns: turn N's snapshot is taken from the state at the *start*
    // of turn N (i.e. end of turn N-1), which is what the user
    // expects when clicking 撤销本轮. Without the clear, turn N-1's
    // files would still be in the snapshot and rewind would partially
    // undo turn N-1 instead of fully undoing turn N.
    getFileSnapshot(session.id).clear();

    // If the session is bound to a custom-model config, decrypt its
    // credentials (main-process only) and pass them through to the provider
    // so the turn runs against the user's endpoint. `session.model` carries
    // the selected role key (e.g. "sonnet" / "fable"); resolveApiConfig
    // validates it against the config's bound roles (falling back to the
    // first bound role if it's been cleared). Cleartext lives only in this
    // request object for the duration of the turn.
    let apiConfig: StartTurnRequest["apiConfig"];
    // The model id to pass to the SDK `model` option. For a custom config we
    // deliberately leave this undefined: `session.model` is a ROLE KEY (not a
    // model id), and buildCustomEnv pins ANTHROPIC_MODEL from the selected
    // role's requestModel (with the `[1m]` suffix when supports1m). The
    // binary reads ANTHROPIC_MODEL as its native model-override channel, so
    // passing --model too would just risk disagreeing with the env var.
    // For the built-in path it's the session's model unless "default".
    let modelForReq: string | undefined = session.model !== "default" ? session.model : undefined;
    if (session.customModelId) {
      const cfg = CustomModelStore.resolveApiConfig(session.customModelId, session.model);
      if (!cfg) {
        log.warn(`sendTurn: custom model ${session.customModelId} not found, token undecryptable, or no role bound; falling back to default endpoint`);
      } else {
        apiConfig = cfg;
        modelForReq = undefined; // env pins ANTHROPIC_MODEL via buildCustomEnv
      }
    }

    const req: StartTurnRequest = {
      sessionId: session.id,
      prompt: input.prompt,
      cwd: input.cwd,
      model: modelForReq,
      effort: session.effort !== "default" ? session.effort : undefined,
      permissionMode: session.permissionMode !== "default" ? session.permissionMode : undefined,
      resumeProviderSessionId: rt.providerSessionId,
      apiConfig,
    };

    const handle = await provider.startTurn(req, rt.ctx);
    rt.handle = handle;
    // Remember the cwd for the rewind path (see rewindTurn below).
    rt.lastCwd = input.cwd;

    // Run in background; errors are caught inside the provider's done loop.
    handle.done.catch((err) => {
      log.error(`turn failed: ${(err as Error).message}`);
    });
  }

  interrupt(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt?.handle) return;
    rt.handle.interrupt();
  }

  dispose(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    try {
      rt.handle?.interrupt();
    } catch {
      /* ignore */
    }
    approvalBridge.rejectAll(sessionId);
    // Drop the snapshot too — keep memory bounded as sessions come
    // and go. The registry holds onto the per-session FileSnapshot
    // for the lifetime of the app otherwise.
    dropFileSnapshot(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Rewind the most recent turn for a session: restore all files the
   *  Edit/Write tools touched in that turn to their pre-turn state,
   *  then emit a `turn.rewound` event so the renderer can clear its
   *  "本轮文件" card. Returns the list of paths actually restored
   *  (failed paths are logged in main but not surfaced). */
  async rewindTurn(sessionId: string): Promise<string[]> {
    const rt = this.sessions.get(sessionId);
    if (!rt) {
      log.warn(`rewindTurn: no runtime bound for session ${sessionId}`);
      return [];
    }
    const cwd = rt.lastCwd;
    if (!cwd) {
      log.warn(`rewindTurn: cwd not available for session ${sessionId} (no turn yet?)`);
      return [];
    }
    const snapshot = getFileSnapshot(sessionId);
    const restored = await snapshot.restore(cwd);
    // After a successful restore, drop the snapshot so the renderer
    // can't double-undo and so the next turn starts clean.
    if (restored.length > 0) {
      snapshot.clear();
    }
    // Notify the renderer (and any other listeners) so the UI can
    // clear its "本轮文件" card and append a "N 个文件已恢复"
    // breadcrumb to the message stream.
    sendToRenderer(IPC.CLAUDE_EVENT, {
      channel: IPC.CLAUDE_EVENT,
      sessionId,
      event: {
        type: "turn.rewound",
        sessionId,
        files: restored,
      } satisfies RuntimeEvent,
    });
    return restored;
  }

  /** Resolve an approval request from the renderer. */
  resolveApproval(requestId: string, allow: boolean, reason?: string, always?: boolean): boolean {
    return approvalBridge.resolveApproval(requestId, { allow, reason }, always);
  }

  /** Update a session's permission mode mid-turn. The bridge records it and
   *  canUseTool reads the live value on every subsequent tool call, so the
   *  change takes effect immediately for approvals (the SDK's own
   *  `permissionMode` option can't be hot-swapped, but our host-side gate can). */
  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    approvalBridge.setPermissionMode(sessionId, mode);
  }

  /** Resolve a user-input request (AskUserQuestion answer). */
  resolveUserInput(requestId: string, answers: UserInputAnswers): boolean {
    return approvalBridge.resolveUserInput(requestId, answers);
  }

  /** Resolve a plan-approval request (ExitPlanMode approve/reject). */
  resolvePlanApproval(requestId: string, decision: PlanApprovalDecision): boolean {
    return approvalBridge.resolvePlanApproval(requestId, decision);
  }
}

export const runtimeManager = new RuntimeManager();
