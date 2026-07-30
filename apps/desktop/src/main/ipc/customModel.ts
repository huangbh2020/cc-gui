/**
 * IPC handlers for user-defined custom-model configs (Anthropic-compatible
 * endpoints). The auth token is encrypted at rest via safeStorage and NEVER
 * sent to the renderer in cleartext — only a masked form is returned.
 *
 * - list   : return all configs (desensitized)
 * - save   : create or update (encrypts the token, returns the new list)
 * - delete : remove a config and its token
 * - test   : probe a (not-yet-saved) config by running one minimal SDK turn
 *            against that endpoint, so the user can verify before save
 */
import type { IpcMain } from "electron";
import {
  IPC,
  SaveCustomModelSchema,
  DeleteCustomModelSchema,
  TestCustomModelSchema,
} from "@contracts/ipc";
import type { ApiConfig } from "@contracts/customModel";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { log } from "@main/lib/logger.js";

/** Probe timeout — a healthy endpoint should answer the init handshake within
 *  a few seconds. We abort the SDK query after this to avoid hanging the UI. */
const TEST_TIMEOUT_MS = 30_000;

export function registerCustomModelHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CUSTOM_MODEL_LIST, () => {
    return { models: CustomModelStore.listPublic() };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_SAVE, (_evt, raw) => {
    const input = SaveCustomModelSchema.parse(raw);
    const models = CustomModelStore.save(input);
    log.info(`custom model saved: ${input.id ? `updated ${input.id}` : `new (${models.length} total)`}`);
    return { models };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_DELETE, (_evt, raw) => {
    const input = DeleteCustomModelSchema.parse(raw);
    const models = CustomModelStore.remove(input.id);
    log.info(`custom model deleted: ${input.id} (${models.length} remaining)`);
    return { models };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_TEST, async (_evt, raw) => {
    const input = TestCustomModelSchema.parse(raw);
    // The probe tests ONE model (the user picks which role/model in the UI).
    // Build a minimal ApiConfig that binds the probed model under the Sonnet
    // tier (arbitrary but valid) and selects it. supports1m is recorded on the
    // binding so resolveActiveModel / buildCustomEnv see the same 1M behavior
    // a saved config would produce — the probe then exercises the EXACT model
    // string a real turn would send via Options.model.
    const cfg: ApiConfig = {
      baseUrl: input.baseUrl,
      authToken: input.authToken,
      authMode: input.authMode ?? "auth_token",
      protocol: input.protocol ?? "anthropic",
      selectedRole: "sonnet",
      roles: { sonnet: { requestModel: input.model, supports1m: input.supports1m ?? false } },
      disableNonEssentialTraffic: input.disableNonEssentialTraffic ?? true,
      timeoutMs: input.timeoutMs,
    };
    // OpenAI-format endpoints are probed directly via a minimal chat-completions
    // request, NOT through the Claude binary. The bridge's correctness is
    // verified separately; the probe only needs to confirm reachability + auth
    // + that the named model exists on the endpoint.
    if (cfg.protocol === "openai") {
      return probeOpenAiEndpoint(cfg);
    }
    return probeEndpoint(cfg);
  });
}

/**
 * Verify a custom endpoint by spawning a minimal SDK query against it and
 * waiting for the first system/init message (proves: DNS reachable, auth
 * accepted, model available). Aborts after {@link TEST_TIMEOUT_MS}.
 *
 * Uses the SAME env-builder, SAME model resolver, AND SAME settingSources as a
 * live turn, so a passing test guarantees the saved config will work
 * end-to-end. The probe resolves the model id via {@link resolveActiveModel}
 * and passes `settingSources: ['project','local']` — matching what
 * {@link ClaudeAgentSdkProvider} does — so the two paths can never drift. This
 * is critical: without matching settingSources, the binary would read whatever
 * cc switch left in ~/.claude/settings.json and the probe would test the wrong
 * endpoint (the original "test passes, live turn fails" bug).
 */
async function probeEndpoint(
  cfg: ApiConfig,
): Promise<{
  ok: boolean;
  detail?: string;
  error?: string;
}> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);

  try {
    // The probe mirrors a live turn: resolveActiveModel yields the exact model
    // string (with the lowercase `[1m]` suffix when supports1m) that
    // buildCustomEnv also places on ANTHROPIC_MODEL for a live turn — so the
    // probe exercises the same model id a real turn sends. The probe passes it
    // via the SDK `model` option (it doesn't set ANTHROPIC_MODEL because its
    // cfg binds only one role); the binary accepts either channel.
    // betas is intentionally NOT set — 1M is declared via the suffix, not via
    // the anthropic-beta header.
    const probedModel = resolveActiveModel(cfg);
    const q = query({
      prompt: "hi",
      options: {
        abortController: ac,
        maxTurns: 1,
        model: probedModel,
        env: buildCustomEnv(cfg),
        // MUST mirror the live-turn provider's settingSources (see
        // ClaudeAgentSdkProvider.ts). The bundled binary re-reads
        // ~/.claude/settings.json after spawn and overwrites the env we pass
        // here — so without this, the probe would be testing whatever cc
        // switch currently points at, NOT the config the user just typed in.
        // That divergence was the original "test passes, live turn fails"
        // mystery. ['project','local'] skips the user-level file (cc switch's
        // territory) while keeping CLAUDE.md / project settings working.
        settingSources: ["project", "local"],
        includePartialMessages: false,
      },
    });

    for await (const m of q) {
      // The system/init message is the SDK's first emission once the subprocess
      // has booted and authenticated. Seeing it means the endpoint is live.
      if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
        const ver = (m as { claude_code_version?: string }).claude_code_version;
        return { ok: true, detail: ver ? `connected (SDK v${ver})` : "connected" };
      }
      // If the model already answered (some non-Anthropic backends skip the
      // init handshake), treat that as success too.
      if (m.type === "assistant") {
        return { ok: true, detail: "model responded" };
      }
    }
    return { ok: false, error: "endpoint did not send an init message" };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // Translate the most common failure modes into friendlier text.
    if (/401|unauthorized|invalid.*key|invalid_api_key|invalid.*token/i.test(msg)) {
      return { ok: false, error: `认证失败:Token/Key 被拒绝 (401) — 检查认证方式是否选对 (Bearer vs x-api-key)` };
    }
    if (/403|forbidden/i.test(msg)) {
      return { ok: false, error: "无权访问 (403) — 该 Token 无此模型权限" };
    }
    if (/503|no available channel|无可用渠道/i.test(msg)) {
      return { ok: false, error: `网关无此模型渠道 (503):确认「模型名」与「别名映射」是否匹配该网关` };
    }
    if (ac.signal.aborted || /abort/i.test(msg)) {
      return { ok: false, error: `连接超时(${TEST_TIMEOUT_MS / 1000}s),请检查 Base URL 或网络` };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Build the upstream chat-completions URL for an OpenAI-format endpoint,
 *  normalizing the path (mirrors the bridge's buildUpstreamUrl). */
function buildOpenAiUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/v1\/chat\/completions\/?$/i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  if (/\/v1\/?$/i.test(trimmed)) return `${trimmed.replace(/\/+$/, "")}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** Probe an OpenAI-format endpoint directly with a 1-token chat completion.
 *  Confirms DNS reachability, auth, and that the named model exists — without
 *  spinning up the Claude binary or the full bridge. A 200 means the saved
 *  config will work end-to-end (the bridge uses the exact same URL + auth). */
async function probeOpenAiEndpoint(
  cfg: ApiConfig,
): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const model = resolveActiveModel(cfg);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);
  const url = buildOpenAiUrl(cfg.baseUrl);
  const isAzure = /azure\.com/i.test(cfg.baseUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: isAzure ? "" : `Bearer ${cfg.authToken}`,
  };
  if (isAzure) {
    headers["api-key"] = cfg.authToken;
    delete headers.Authorization;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: ac.signal,
    });
    if (res.ok) {
      return { ok: true, detail: `connected (${model})` };
    }
    const errText = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `认证失败 (${res.status}) — 检查 Token/Key 是否正确` };
    }
    if (res.status === 404) {
      return { ok: false, error: `端点或模型不存在 (404) — 检查 Base URL 路径与模型名「${model}」` };
    }
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}` };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (ac.signal.aborted || /abort/i.test(msg)) {
      return { ok: false, error: `连接超时(${TEST_TIMEOUT_MS / 1000}s),请检查 Base URL 或网络` };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
