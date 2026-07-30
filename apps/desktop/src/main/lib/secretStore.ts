/**
 * Encrypted storage for secrets (auth tokens) backed by Electron safeStorage.
 *
 * safeStorage uses the OS-native keychain: Windows DPAPI, macOS Keychain,
 * Linux libsecret. The cleartext token NEVER touches disk — only an opaque
 * base64 ciphertext blob does, stored as JSON under the `settings` table
 * key `customModelKeys` (a `{ [modelId]: base64Ciphertext }` map). The
 * non-secret metadata (name, baseUrl, authMode, roles, …) lives under
 * `customModels`.
 *
 * When safeStorage is unavailable (e.g. some headless Linux without a
 * secret service), we fall back to plain base64 of the cleartext and log a
 * loud warning — the feature still works, but the token is only obfuscated,
 * not encrypted. This is the documented Electron guidance.
 *
 * ## Schema migration (legacy → role bindings)
 *
 * Configs persisted before the role-binding refactor carry the legacy shape
 * (`models: string[]` + `alias: { haiku?, sonnet?, opus? }`) instead of the
 * current `roles: RoleBindings`. `migrateMeta()` synthesizes a `roles` map
 * on read so old configs upgrade transparently: `models[0]` becomes the
 * Sonnet binding (the default selectable tier) and any alias entry fills its
 * matching tier. The synthesized record is rewritten to disk in the new
 * format the next time the user saves.
 */
import { safeStorage } from "electron";
import type {
  CustomModelMeta,
  CustomModelPublic,
  CustomModelInput,
  ApiConfig,
  AuthMode,
  Protocol,
  RoleBindings,
  CustomModelRoleKey,
} from "@contracts/customModel";
import { CUSTOM_MODEL_ROLES, resolveProtocol } from "@contracts/customModel";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** Settings-table key for the encrypted-token map. */
const KEYS_SETTING_KEY = "customModelKeys";
/** Settings-table key for the public metadata array (no secrets). */
const META_SETTING_KEY = "customModels";

/** Default auth mode when a stored config predates the authMode field, or
 *  when the user creates one without choosing. `auth_token` is the right
 *  default for the overwhelming majority of third-party gateways (DeepSeek,
 *  one-api, new-api) — they all expect `Authorization: Bearer`. */
const DEFAULT_AUTH_MODE: AuthMode = "auth_token";

type KeyMap = Record<string, string>; // id -> base64 (ciphertext or plaintext)

let unavailableWarned = false;

function isAvailable(): boolean {
  const ok = safeStorage.isEncryptionAvailable();
  if (!ok && !unavailableWarned) {
    log.warn(
      "safeStorage encryption is NOT available — custom-model tokens will be stored as plain base64 (obfuscated only). Consider installing a system keychain/secret service.",
    );
    unavailableWarned = true;
  }
  return ok;
}

function encrypt(plain: string): string {
  if (!isAvailable()) {
    return Buffer.from(plain, "utf8").toString("base64");
  }
  return safeStorage.encryptString(plain).toString("base64");
}

function decrypt(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  if (!isAvailable()) {
    return buf.toString("utf8");
  }
  try {
    return safeStorage.decryptString(buf);
  } catch (err) {
    log.error(`secretStore.decrypt failed: ${(err as Error).message}`);
    return "";
  }
}

function readKeyMap(): KeyMap {
  const raw = SettingRepo.get(KEYS_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as KeyMap) : {};
  } catch {
    return {};
  }
}

function writeKeyMap(map: KeyMap): void {
  SettingRepo.set(KEYS_SETTING_KEY, JSON.stringify(map));
}

/** Normalize a possibly-undefined authMode to a concrete value (default
 *  auth_token). Used for both stored configs and runtime resolution. */
function resolveAuthMode(m: AuthMode | undefined): AuthMode {
  return m ?? DEFAULT_AUTH_MODE;
}

/** Read the models list off a LEGACY meta record (pre-role-binding), with
 *  backward-compat for records persisted before the model→models migration:
 *  a lone `model: string` becomes `[model]`. Empty if the record already uses
 *  the new `roles` shape. */
function readLegacyModels(m: { models?: unknown; model?: unknown }): string[] {
  if (Array.isArray(m.models) && m.models.length > 0) {
    return (m.models as string[]).filter((s) => typeof s === "string" && s.trim());
  }
  if (typeof m.model === "string" && m.model.trim()) return [m.model];
  return [];
}

/** Read the legacy 3-key alias map off a record, if present. */
function readLegacyAlias(m: { alias?: unknown }):
  | { haiku?: string; sonnet?: string; opus?: string }
  | undefined {
  if (!m.alias || typeof m.alias !== "object") return undefined;
  const a = m.alias as { haiku?: unknown; sonnet?: unknown; opus?: unknown };
  const out: { haiku?: string; sonnet?: string; opus?: string } = {};
  if (typeof a.haiku === "string" && a.haiku.trim()) out.haiku = a.haiku.trim();
  if (typeof a.sonnet === "string" && a.sonnet.trim()) out.sonnet = a.sonnet.trim();
  if (typeof a.opus === "string" && a.opus.trim()) out.opus = a.opus.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Promote a legacy meta record (models[] + alias) to the new role-binding
 *  shape. Already-migrated records pass through untouched. Strategy:
 *    - models[0] → Sonnet binding (the default selectable tier)
 *    - alias.haiku/sonnet/opus → matching tier bindings
 *    - fable / subagent → left unbound (no legacy equivalent)
 *  Sonnet always ends up bound when there was any model, since it's the
 *  default selection. If alias.sonnet is also set it takes precedence for
 *  that tier (it's the more specific value). */
function migrateMeta(meta: CustomModelMeta): CustomModelMeta {
  // Backfill the protocol field for records persisted before it existed.
  // Every pre-existing config spoke Anthropic, so "anthropic" is the safe
  // default and keeps old configs behaving exactly as before.
  const withProtocol: CustomModelMeta = meta.protocol
    ? meta
    : { ...meta, protocol: "anthropic" };

  if (withProtocol.roles) return withProtocol; // already new shape

  const legacyModels = readLegacyModels(meta as unknown as { models?: unknown; model?: unknown });
  const legacyAlias = readLegacyAlias(meta as unknown as { alias?: unknown });
  const roles: RoleBindings = {};

  if (legacyAlias?.haiku) roles.haiku = { requestModel: legacyAlias.haiku };
  if (legacyAlias?.sonnet) roles.sonnet = { requestModel: legacyAlias.sonnet };
  else if (legacyModels.length > 0) roles.sonnet = { requestModel: legacyModels[0] };
  if (legacyAlias?.opus) roles.opus = { requestModel: legacyAlias.opus };

  const { ...rest } = withProtocol;
  // Drop the legacy fields if present (they'll be re-stripped on next write).
  const cleaned = rest as Partial<CustomModelMeta> as Record<string, unknown>;
  delete cleaned.models;
  delete cleaned.model;
  delete cleaned.alias;
  return { ...(cleaned as Omit<CustomModelMeta, "roles">), roles };
}

function readMeta(): CustomModelMeta[] {
  const raw = SettingRepo.get(META_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as CustomModelMeta[]).map(migrateMeta);
  } catch {
    return [];
  }
}

function writeMeta(list: CustomModelMeta[]): void {
  // Always write the migrated (role-binding) shape — old fields already
  // stripped by migrateMeta; new saves only carry `roles`.
  SettingRepo.set(META_SETTING_KEY, JSON.stringify(list));
}

/** Mask a cleartext token for display: keep first 2 and last 4 chars. */
function maskToken(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 6) return "***";
  return `${plain.slice(0, 2)}***${plain.slice(-4)}`;
}

/** The first role (in canonical order) that has a `requestModel`. This is the
 *  fallback selection when the session's persisted selection no longer matches
 *  any bound role. Returns undefined only if no role is bound at all (which
 *  shouldn't happen for a saved config). */
function firstBoundRole(roles: RoleBindings): CustomModelRoleKey | undefined {
  for (const key of CUSTOM_MODEL_ROLES) {
    if (roles[key]?.requestModel?.trim()) return key;
  }
  return undefined;
}

/** True if at least one role has a non-empty requestModel. */
function hasAnyBoundRole(roles: RoleBindings): boolean {
  return firstBoundRole(roles) !== undefined;
}

export const CustomModelStore = {
  /** List all configs (desensitized — tokens masked, never cleartext). */
  listPublic(): CustomModelPublic[] {
    const metas = readMeta();
    const keys = readKeyMap();
    return metas.map((m) => {
      const cleartext = keys[m.id] ? decrypt(keys[m.id]) : "";
      return {
        id: m.id,
        name: m.name,
        baseUrl: m.baseUrl,
        authMode: resolveAuthMode(m.authMode),
        protocol: resolveProtocol(m.protocol),
        authTokenMasked: maskToken(cleartext),
        roles: m.roles ?? {},
        disableNonEssentialTraffic: m.disableNonEssentialTraffic ?? true,
        timeoutMs: m.timeoutMs,
        createdAt: m.createdAt,
      };
    });
  },

  /**
   * Create or update a config. On update with `authToken` omitted, the
   * existing stored token is preserved. Returns the new desensitized list.
   */
  save(input: CustomModelInput): CustomModelPublic[] {
    const metas = readMeta();
    const keys = readKeyMap();
    const now = Date.now();
    const disableTraffic = input.disableNonEssentialTraffic ?? true;

    if (input.id) {
      const idx = metas.findIndex((m) => m.id === input.id);
      if (idx < 0) throw new Error(`custom model not found: ${input.id}`);
      metas[idx] = {
        ...metas[idx],
        name: input.name,
        baseUrl: input.baseUrl,
        authMode: resolveAuthMode(input.authMode),
        protocol: resolveProtocol(input.protocol),
        roles: input.roles,
        disableNonEssentialTraffic: disableTraffic,
        timeoutMs: input.timeoutMs,
      };
      if (input.authToken) keys[input.id] = encrypt(input.authToken);
    } else {
      if (!input.authToken) throw new Error("authToken is required when creating a custom model");
      const id = `cm_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      metas.push({
        id,
        name: input.name,
        baseUrl: input.baseUrl,
        authMode: resolveAuthMode(input.authMode),
        protocol: resolveProtocol(input.protocol),
        roles: input.roles,
        disableNonEssentialTraffic: disableTraffic,
        timeoutMs: input.timeoutMs,
        createdAt: now,
      });
      keys[id] = encrypt(input.authToken);
    }

    writeMeta(metas);
    writeKeyMap(keys);
    return this.listPublic();
  },

  /** Delete a config and its encrypted token. */
  remove(id: string): CustomModelPublic[] {
    const metas = readMeta().filter((m) => m.id !== id);
    const keys = readKeyMap();
    delete keys[id];
    writeMeta(metas);
    writeKeyMap(keys);
    return this.listPublic();
  },

  /**
   * Resolve the full ApiConfig for a stored config + the role the session has
   * selected (main-process only — must NEVER be sent to the renderer).
   * Returns undefined if not found, the token can't be decrypted, or no role
   * is bound at all.
   *
   * `selectedRole` is the role key persisted on the session; if it isn't bound
   * (e.g. the user cleared it), we fall back to the first bound role.
   */
  resolveApiConfig(id: string, selectedRole?: string): ApiConfig | undefined {
    const metas = readMeta();
    const meta = metas.find((m) => m.id === id);
    if (!meta) return undefined;
    const keys = readKeyMap();
    const cipher = keys[id];
    if (!cipher) return undefined;
    const authToken = decrypt(cipher);
    if (!authToken) return undefined;
    const roles = meta.roles ?? {};
    if (!hasAnyBoundRole(roles)) return undefined;

    const fallback = firstBoundRole(roles)!;
    const isSelectedBound =
      selectedRole &&
      (CUSTOM_MODEL_ROLES as string[]).includes(selectedRole) &&
      roles[selectedRole as CustomModelRoleKey]?.requestModel?.trim();
    const resolvedRole: CustomModelRoleKey = isSelectedBound
      ? (selectedRole as CustomModelRoleKey)
      : fallback;

    return {
      baseUrl: meta.baseUrl,
      authToken,
      authMode: resolveAuthMode(meta.authMode),
      protocol: resolveProtocol(meta.protocol),
      selectedRole: resolvedRole,
      roles,
      disableNonEssentialTraffic: meta.disableNonEssentialTraffic ?? true,
      timeoutMs: meta.timeoutMs,
    };
  },
};
