/**
 * Endpoint preset store — CRUD over the `endpointPresets` settings key.
 *
 * A preset is a credential-free "endpoint template" (name + baseUrl +
 * authMode) shared across provider config systems. Because it carries no
 * secret, it's stored as plain JSON via SettingRepo — no safeStorage needed
 * (unlike customModelKeys, which encrypt the token).
 *
 * See contracts/endpointPreset.ts for the type and the rationale for why
 * presets are separate from claude's customModel configs.
 */
import { uid } from "@main/utils.js";
import { SettingRepo } from "@main/store/repositories.js";
import type { EndpointPreset, EndpointPresetInput } from "@contracts/endpointPreset";
import { log } from "@main/lib/logger.js";

const PRESETS_SETTING_KEY = "endpointPresets";

function readPresets(): EndpointPreset[] {
  const raw = SettingRepo.get(PRESETS_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EndpointPreset[]) : [];
  } catch (err) {
    log.error(`endpointPresets: failed to parse: ${(err as Error).message}`);
    return [];
  }
}

function writePresets(list: EndpointPreset[]): void {
  SettingRepo.set(PRESETS_SETTING_KEY, JSON.stringify(list));
}

export const EndpointPresetStore = {
  list(): EndpointPreset[] {
    return readPresets();
  },

  save(input: EndpointPresetInput): EndpointPreset[] {
    const list = readPresets();
    const now = Date.now();
    if (input.id) {
      // Update in place; preserve createdAt.
      const existing = list.find((p) => p.id === input.id);
      const idx = list.findIndex((p) => p.id === input.id);
      if (idx >= 0) {
        const updated: EndpointPreset = {
          ...list[idx],
          name: input.name.trim(),
          baseUrl: input.baseUrl.trim(),
          authMode: input.authMode ?? "auth_token",
        };
        list[idx] = updated;
        writePresets(list);
        return list;
      }
      // Id not found — fall through to create (mirrors CustomModelStore).
    }
    const preset: EndpointPreset = {
      id: `ep_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      authMode: input.authMode ?? "auth_token",
      createdAt: now,
    };
    writePresets([...list, preset]);
    return readPresets();
  },

  remove(id: string): EndpointPreset[] {
    const list = readPresets().filter((p) => p.id !== id);
    writePresets(list);
    return readPresets();
  },
};

/** Generate an id without uid()'s prefix when callers want explicit control
 *  (uid is project-local; kept here for symmetry with other stores). */
export function newPresetId(): string {
  return uid("ep_");
}
