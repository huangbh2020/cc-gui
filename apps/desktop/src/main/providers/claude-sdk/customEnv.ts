/**
 * Build the SDK subprocess `env` for a custom endpoint, from an ApiConfig.
 *
 * The SDK's `Options.env` REPLACES the subprocess environment entirely (per
 * sdk.d.ts), so we always spread `process.env` first — otherwise PATH/HOME
 * disappear and the claude binary can't even boot.
 *
 * Shared between:
 *   - {@link ClaudeAgentSdkProvider} (live turns)
 *   - {@link ../../ipc/customModel.ts} `probeEndpoint` (connection test)
 * so the two paths stay byte-identical.
 *
 * ## How the model id reaches the API
 *
 * The claude binary consults TWO channels and they MUST agree:
 *
 *   1. `ANTHROPIC_MODEL` (subprocess env) — the binary's native model override.
 *      Recognized in the bundled binary's env-var allowlist (verified against
 *      v0.3.218 / claude code 2.1.218). This is the channel DeepSeek's official
 *      Claude Code integration guide configures, and the channel the binary
 *      uses to route the primary turn.
 *   2. `Options.model` (→ `--model` CLI flag) — also read by the binary; an
 *      explicit `--model` generally takes precedence over the env var.
 *
 * For a custom config we deliberately drive the model through `ANTHROPIC_MODEL`
 * ONLY and leave `Options.model` unset. Passing both, with the env var carrying
 * a `[1m]` suffix and `Options.model` carrying a bare name (or vice-versa), was
 * a previous bug that produced "selected model may not exist". Letting the
 * binary resolve from a single source (the env var) matches DeepSeek's
 * documented working config and avoids the dual-channel disagreement.
 *
 * ## Role → env var mapping (background tiers)
 *
 * Each of the five tiers maps to a dedicated env var the binary reads when
 * issuing BACKGROUND requests (sub-agent Task tool, haiku-class side calls):
 *
 *   haiku    → ANTHROPIC_DEFAULT_HAIKU_MODEL
 *   sonnet   → ANTHROPIC_DEFAULT_SONNET_MODEL
 *   opus     → ANTHROPIC_DEFAULT_OPUS_MODEL
 *   fable    → ANTHROPIC_DEFAULT_FABLE_MODEL
 *   subagent → CLAUDE_CODE_SUBAGENT_MODEL   (not a model alias — Task-tool ctx)
 *
 * Only tiers with a `requestModel` are injected; an unbound tier leaves the
 * SDK's defaults untouched.
 *
 * ## 1M context — the `[1m]` suffix (LOWERCASE)
 *
 * Declared via a `[1m]` suffix on the model name (e.g. `deepseek-v4-pro[1m]`),
 * NOT via the SDK's `betas` option. This is the convention used by DeepSeek's
 * `/anthropic` endpoint and most third-party gateways — they do NOT recognize
 * Anthropic's native `anthropic-beta: context-1m-2025-08-07` header.
 *
 * IMPORTANT: the suffix is LOWERCASE `[1m]`, matching DeepSeek's official
 * documentation (https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/):
 *   ANTHROPIC_MODEL=deepseek-v4-pro[1m]
 * The binary internally normalizes any casing to lowercase anyway (its init
 * handshake logs `model=deepseek-v4-pro[1m]` regardless of input casing), so
 * emitting lowercase up front keeps the diagnostic log honest.
 *
 * The suffix is carried on:
 *   - `ANTHROPIC_MODEL` (the primary turn's model) — when the selected role
 *     declares `supports1m`.
 *   - the selected role's tier env var — when that role declares `supports1m`.
 * Background (non-selected) tiers use the bare name; they're short-context.
 */
import type { ApiConfig, RoleBindings, RoleBinding, CustomModelRoleKey } from "@contracts/customModel";
import { CUSTOM_MODEL_ROLES } from "@contracts/customModel";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Map each role key to the env var the claude binary reads for that tier. */
const ROLE_ENV_VAR: Record<CustomModelRoleKey, string> = {
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  // Subagent is the odd one out: it lives under the CLAUDE_CODE_* namespace,
  // not ANTHROPIC_* (ANTHROPIC_SUBAGENT_MODEL does not exist in the binary).
  subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
};

/** The first role (canonical order) with a bound requestModel — the fallback
 *  selection when the session's selected role has no binding. */
function firstBoundRole(roles: RoleBindings): CustomModelRoleKey | undefined {
  for (const key of CUSTOM_MODEL_ROLES) {
    if (roles[key]?.requestModel?.trim()) return key;
  }
  return undefined;
}

/** Resolve the active role for this turn: the session's selected role if it
 *  has a binding, else the first bound role. Callers guarantee at least one
 *  role is bound before invoking us (validated upstream). */
function resolveActiveRole(cfg: ApiConfig): CustomModelRoleKey | undefined {
  const sel = cfg.roles[cfg.selectedRole]?.requestModel?.trim();
  if (sel) return cfg.selectedRole;
  return firstBoundRole(cfg.roles);
}

/** Append the `[1m]` context suffix used by DeepSeek-style gateways. Idempotent
 *  — a model that already carries the suffix (any casing) is returned with the
 *  canonical lowercase form, so we never produce `xxx[1m][1m]` and never emit
 *  the uppercase `[1M]` variant. DeepSeek's docs and the binary both use `[1m]`. */
export function with1MSuffix(model: string): string {
  return /\[1m\]$/i.test(model) ? `${model.replace(/\[1m\]$/i, "")}[1m]` : `${model}[1m]`;
}

/**
 * Resolve the model id for the active role, with the `[1m]` suffix appended
 * when that role declares `supports1m`. This is the same string placed on
 * `ANTHROPIC_MODEL` by {@link buildCustomEnv}; exported so the connection
 * probe (which doesn't set `ANTHROPIC_MODEL` — it passes the model via the
 * SDK `model` option instead) can stay byte-identical with the live-turn path.
 */
export function resolveActiveModel(cfg: ApiConfig): string | undefined {
  const role = resolveActiveRole(cfg);
  if (!role) return undefined;
  const raw = cfg.roles[role]?.requestModel?.trim();
  if (!raw) return undefined;
  return cfg.roles[role]?.supports1m ? with1MSuffix(raw) : raw;
}

export function buildCustomEnv(cfg: ApiConfig): NonNullable<Options["env"]> {
  const env: NonNullable<Options["env"]> = { ...process.env };

  env.ANTHROPIC_BASE_URL = cfg.baseUrl;

  // Auth: gateways differ in which header they read. The official API uses
  // x-api-key (ANTHROPIC_API_KEY); most third-party gateways expect
  // Authorization: Bearer (ANTHROPIC_AUTH_TOKEN). When in token mode we
  // explicitly clear ANTHROPIC_API_KEY so the SDK doesn't send both and
  // confuse the gateway (and vice-versa).
  //
  // NOTE: DeepSeek's official Claude Code guide uses ANTHROPIC_AUTH_TOKEN
  // (Bearer). The UI defaults to auth_token for this reason. If a user picks
  // api_key and the gateway returns an opaque 404 (not 401), authMode is a
  // likely culprit — some gateways hide endpoint existence on bad auth.
  if (cfg.authMode === "api_key") {
    env.ANTHROPIC_API_KEY = cfg.authToken;
    env.ANTHROPIC_AUTH_TOKEN = undefined;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
    env.ANTHROPIC_API_KEY = undefined;
  }

  // Per-tier bindings — inject each EXPLICITLY BOUND role's requestModel into
  // its tier env var so BACKGROUND requests (sub-agent Task tool, haiku-class
  // side calls) also route to the user's gateway. The selected role's tier
  // var additionally carries the `[1m]` suffix when it declares supports1m
  // (mirroring DeepSeek's documented config, which sets e.g.
  // ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]). Non-selected tiers use
  // the bare name — background requests are short-context by nature.
  //
  // We do NOT auto-fill unbound tiers: a hand-written DeepSeek config (the
  // reference that works) leaves fable/subagent unset, and Claude Code
  // gracefully falls back to its built-in model names for background requests
  // under those tiers. Auto-filling with the selected role's model previously
  // caused routing mismatches (haiku channel receiving a `deepseek-v4-pro[1m]`
  // it doesn't serve).
  const selectedSupports1m = Boolean(cfg.roles[cfg.selectedRole]?.supports1m);

  for (const key of CUSTOM_MODEL_ROLES) {
    const binding: RoleBinding | undefined = cfg.roles[key];
    const rawModel = binding?.requestModel?.trim();
    if (!rawModel) continue; // unbound tier — leave the SDK default untouched
    const use1m = key === cfg.selectedRole && selectedSupports1m;
    env[ROLE_ENV_VAR[key]] = use1m ? with1MSuffix(rawModel) : rawModel;
  }

  // Legacy haiku alias: older Claude Code builds read ANTHROPIC_SMALL_FAST_MODEL
  // (37 hits in the v0.3.218 binary) before ANTHROPIC_DEFAULT_HAIKU_MODEL existed.
  // Mirror the haiku binding if one is set so background "small/fast" requests
  // route correctly on builds that still consult the legacy name. Never carries
  // the [1m] suffix (haiku is a background tier).
  if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  }

  // DeepSeek private convention: ANTHROPIC_DEFAULT_SONNET_MODEL_NAME records
  // the logical sonnet model name WITHOUT the `[1m]` suffix, even when the
  // sonnet tier binding carries it. The gateway consults this for internal
  // routing. Set whenever sonnet is bound, always to the bare name.
  const sonnetRaw = cfg.roles.sonnet?.requestModel?.trim();
  if (sonnetRaw) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = sonnetRaw;
  }

  // Non-essential traffic (telemetry, etc.) — almost always desirable to
  // disable on a third-party gateway, since those endpoints don't exist there
  // and produce noise/errors.
  if (cfg.disableNonEssentialTraffic) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }

  // Pin the primary turn's model via ANTHROPIC_MODEL. This is the channel the
  // binary uses to route the foreground request; it's what DeepSeek's official
  // Claude Code integration configures. Carries the `[1m]` suffix when the
  // selected role declares supports1m, so a 1M-context turn is routed
  // correctly. (We deliberately do NOT also pass Options.model / --model —
  // see the file header; one channel is enough and avoids disagreement.)
  const mainModel = resolveActiveModel(cfg);
  if (mainModel) {
    env.ANTHROPIC_MODEL = mainModel;
  }

  // Per-request timeout (ms). The SDK honors API_TIMEOUT_MS.
  if (cfg.timeoutMs && cfg.timeoutMs > 0) {
    env.API_TIMEOUT_MS = String(cfg.timeoutMs);
  }

  return env;
}
