/**
 * Endpoint presets — a shared "endpoint only" template that both provider
 * config systems (claude's customModel / pi's models.json) can reference,
 * so the user fills baseUrl + auth scheme once instead of in each provider's
 * panel.
 *
 * Deliberately provider-neutral and credential-free: a preset carries the
 * endpoint's URL and auth scheme, but NEVER the token — each provider keeps
 * its own credential storage (claude: safeStorage-encrypted customModelKeys;
 * pi: ~/.pi/agent/auth.json / environment variables). Importing a preset
 * fills the baseUrl/authMode fields; the token is entered fresh per provider.
 *
 * Persisted as plain JSON under the settings key `endpointPresets`
 * (SettingRepo KV). No encryption needed — there is no secret in here.
 */
import type { AuthMode } from "./customModel.js";

export interface EndpointPreset {
  id: string;
  /** User-facing name, e.g. "DeepSeek 官方" / "OpenRouter". */
  name: string;
  /** Gateway base URL, e.g. "https://api.deepseek.com". */
  baseUrl: string;
  /** How the credential is presented to the upstream (Bearer vs x-api-key). */
  authMode: AuthMode;
  createdAt: number;
}

/** Renderer-facing view — identical to the stored shape (no secrets). */
export type EndpointPresetPublic = EndpointPreset;

/** Input for creating or updating an endpoint preset. */
export interface EndpointPresetInput {
  /** Omit on create; present on update to target an existing record. */
  id?: string;
  name: string;
  baseUrl: string;
  authMode?: AuthMode;
}
