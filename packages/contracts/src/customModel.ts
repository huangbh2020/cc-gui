/**
 * Custom model configuration — lets the user plug in their own Anthropic-
 * compatible endpoint (DeepSeek's `/anthropic`, one-api/new-api gateways,
 * self-hosted proxies, etc.) alongside the built-in model aliases.
 *
 * Persisted on disk; the API key/token is encrypted with Electron safeStorage
 * (see main/lib/secretStore.ts) and NEVER crosses to the renderer in cleartext.
 * The renderer only ever sees {@link CustomModelPublic}.
 *
 * ## Model: role bindings (5 tiers)
 *
 * One config = one endpoint (baseUrl + token + authMode) plus a binding for
 * each of the five Claude Code tiers. Each tier can be bound to a gateway-side
 * model and labeled with a display name; the user then picks a TIER in the
 * model dropdown (not a raw model name), and that tier's `requestModel` is
 * injected as `ANTHROPIC_MODEL` and as the tier's matching env var:
 *
 *   haiku    → ANTHROPIC_DEFAULT_HAIKU_MODEL
 *   sonnet   → ANTHROPIC_DEFAULT_SONNET_MODEL
 *   opus     → ANTHROPIC_DEFAULT_OPUS_MODEL
 *   fable    → ANTHROPIC_DEFAULT_FABLE_MODEL
 *   subagent → CLAUDE_CODE_SUBAGENT_MODEL   (NOT a model alias — a usage context)
 *
 * (Subagent is special: it's the model the built-in Task tool spawns under,
 * not a Claude Code tier alias. The env var lives outside the ANTHROPIC_*
 * namespace, which the binary confirms.)
 *
 * 1M context support is declared PER TIER via `RoleBinding.supports1m`. When
 * the session's selected tier declares it, the provider sets
 * `options.betas = ['context-1m-2025-08-07']` on the SDK query. There is no
 * env var for this — it's a query option (sdk.d.ts:1488, type SdkBeta).
 *
 * ## Why so many fields besides the bindings?
 *
 * Claude Code's own env contract for a custom endpoint isn't just base URL +
 * key. Third-party gateways differ from the official API in three ways that
 * matter:
 *
 * 1. **Auth scheme.** The official API uses `ANTHROPIC_API_KEY` (sent as
 *    `x-api-key`). Most gateways (DeepSeek, one-api, new-api) expect
 *    `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer …`). Setting the
 *    wrong one yields "no available channel for model X" 503s from the gateway.
 *
 * 2. **Non-essential traffic.** Claude Code phones home to Anthropic's
 *    telemetry endpoints by default; on a third-party gateway those fail.
 *    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns them off.
 *
 * (Tier→model remapping is handled by the bindings above, which replaced the
 * older flat `models[]` list + 3-key alias map.)
 */

/** How the credential is presented to the upstream. */
export type AuthMode = "auth_token" | "api_key";

/** The five Claude Code tiers a custom endpoint can bind. The first four are
 *  real model aliases; subagent is a usage context (the Task-tool model). */
export type CustomModelRoleKey = "haiku" | "sonnet" | "opus" | "fable" | "subagent";

/** Canonical, ordered list of roles — used by UI to render the table and by
 *  the dropdown to enumerate bindable tiers. */
export const CUSTOM_MODEL_ROLES: CustomModelRoleKey[] = [
  "haiku",
  "sonnet",
  "opus",
  "fable",
  "subagent",
];

/** Human-readable label for each role key. */
export const CUSTOM_MODEL_ROLE_LABELS: Record<CustomModelRoleKey, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
  fable: "Fable",
  subagent: "Subagent",
};

/** A single tier's binding within a custom-model config. All fields optional —
 *  an unbound role (no `requestModel`) is simply not exposed in the dropdown. */
export interface RoleBinding {
  /** Gateway-side display name shown in the dropdown, e.g. "pro". Falls back
   *  to the role label (e.g. "Sonnet") when unset. */
  displayName?: string;
  /** The actual model id the gateway routes to, e.g. "deepseek-v4-pro".
   *  Injected as the role's matching env var; when this role is selected for a
   *  turn it is also passed as ANTHROPIC_MODEL. */
  requestModel?: string;
  /** Declare 1M-token context support. When the session selects this role, the
   *  provider sets betas=['context-1m-2025-08-07'] on the SDK query. */
  supports1m?: boolean;
}

/** Per-config role bindings. Any subset of the five keys may be present; only
 *  roles with a `requestModel` are selectable in the UI. */
export interface RoleBindings {
  haiku?: RoleBinding;
  sonnet?: RoleBinding;
  opus?: RoleBinding;
  fable?: RoleBinding;
  subagent?: RoleBinding;
}

/** Fully-resolved config passed to the provider at turn time (main-process
 *  only — carries the cleartext credential, never crosses IPC). */
export interface ApiConfig {
  baseUrl: string;
  /** Cleartext credential. */
  authToken: string;
  authMode: AuthMode;
  /** The role the session has selected for this turn (one of the bindable
   *  keys). Its `requestModel` becomes ANTHROPIC_MODEL; its `supports1m`
   *  decides whether betas are sent. Falls back to the first bound role. */
  selectedRole: CustomModelRoleKey;
  /** Per-tier bindings. Every tier with a `requestModel` is injected as its
   *  matching env var so background requests also route correctly. */
  roles: RoleBindings;
  /** Disable Claude Code's non-essential (telemetry) traffic. Default true
   *  for custom endpoints — almost always what you want on a gateway. */
  disableNonEssentialTraffic: boolean;
  /** Per-request timeout in ms (passed through as API_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** Credential storage shape (encrypted at rest, decrypted in main only). */
export interface StoredCredential {
  authToken: string;
  authMode: AuthMode;
}

/** A stored custom-model config (main-process side; holds the cleartext token).
 *  One config = one endpoint + per-tier role bindings. */
export interface CustomModel {
  id: string;
  /** User-facing name, e.g. "DeepSeek 中转". */
  name: string;
  baseUrl: string;
  /** Cleartext token. Only exists in main memory; persisted encrypted. */
  authToken: string;
  authMode: AuthMode;
  roles: RoleBindings;
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  createdAt: number;
}

/**
 * Renderer-facing (desensitized) view of a custom model. The token is masked
 * (e.g. "sk-***ab12"); the cleartext never leaves the main process.
 */
export interface CustomModelPublic {
  id: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  /** Masked token, e.g. "sk-***ab12". For display only. */
  authTokenMasked: string;
  roles: RoleBindings;
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  createdAt: number;
}

/** Persisted metadata record (everything except the credential, which lives
 *  in the encrypted secret store keyed by id). Stored as JSON under the
 *  settings key `customModels`. */
export interface CustomModelMeta {
  id: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  roles: RoleBindings;
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  createdAt: number;
}

/** Input for creating or updating a custom model. `authToken` is optional on
 *  update so the user can edit other fields without re-entering the secret
 *  (omitting it = keep the existing stored token). */
export interface CustomModelInput {
  /** Omit on create; present on update to target an existing record. */
  id?: string;
  name: string;
  baseUrl: string;
  authMode?: AuthMode;
  /** Cleartext. Required on create; optional on update (omit = keep existing). */
  authToken?: string;
  roles: RoleBindings;
  disableNonEssentialTraffic?: boolean;
  timeoutMs?: number;
}

/** Result of a connection probe using the user-supplied (not-yet-saved) values. */
export interface TestCustomModelResult {
  ok: boolean;
  /** claude's version string or model echo, when available. */
  detail?: string;
  /** Error message on failure (auth / network / timeout / bad model). */
  error?: string;
}
