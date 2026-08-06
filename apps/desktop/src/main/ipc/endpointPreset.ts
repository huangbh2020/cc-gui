/**
 * IPC handlers for endpoint presets (credential-free endpoint templates shared
 * across provider config systems). A preset has no secret, so it's stored as
 * plain JSON via SettingRepo — no encryption needed.
 *
 * - list   : return all presets
 * - save   : create or update
 * - delete : remove a preset
 */
import type { IpcMain } from "electron";
import {
  IPC,
  SaveEndpointPresetSchema,
  DeleteEndpointPresetSchema,
} from "@contracts/ipc";
import { EndpointPresetStore } from "@main/lib/endpointPresetStore.js";
import { log } from "@main/lib/logger.js";

export function registerEndpointPresetHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.ENDPOINT_PRESET_LIST, () => {
    return { presets: EndpointPresetStore.list() };
  });

  ipcMain.handle(IPC.ENDPOINT_PRESET_SAVE, (_evt, raw) => {
    const input = SaveEndpointPresetSchema.parse(raw);
    const presets = EndpointPresetStore.save(input);
    log.info(`endpoint preset saved: ${input.id ? `updated ${input.id}` : `new (${presets.length} total)`}`);
    return { presets };
  });

  ipcMain.handle(IPC.ENDPOINT_PRESET_DELETE, (_evt, raw) => {
    const input = DeleteEndpointPresetSchema.parse(raw);
    const presets = EndpointPresetStore.remove(input.id);
    log.info(`endpoint preset deleted: ${input.id} (${presets.length} remaining)`);
    return { presets };
  });
}
