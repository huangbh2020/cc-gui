import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { CUSTOM_MODEL_ROLES, CUSTOM_MODEL_ROLE_LABELS } from "@contracts/customModel";
import type { CustomModelRoleKey } from "@contracts/customModel";

/**
 * Model picker for the composer toolbar.
 *
 * The model surface is provider-driven, not hardcoded:
 *   - Built-in aliases come from the active provider's
 *     `capabilities.builtinModels` (claude: Auto/Sonnet/Opus/Fable).
 *   - The custom-endpoint configs (user-defined gateways with per-tier role
 *     bindings) are shown only when the provider declares
 *     `supportsCustomEndpoint` (claude: true, pi: false).
 *
 * Selection state is the pair (customModelId, model):
 *   - built-in alias → customModelId=null, model=<alias id>
 *   - custom model   → customModelId=<cfg id>, model=<one of cfg.roles>
 *
 * Built on @base-ui/react/menu like EffortDropdown: the popup renders through
 * Menu.Portal (document.body), so it isn't clipped by the composer card's
 * overflow-hidden. Config rows with bound models open a nested submenu.
 */

/** Derive the host segment of a base URL for the secondary line. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ModelDropdown() {
  const model = useSessionStore((s) => s.model);
  const customModelId = useSessionStore((s) => s.customModelId);
  const customModels = useSessionStore((s) => s.customModels);
  const setCustomModel = useSessionStore((s) => s.setCustomModel);
  const setModel = useSessionStore((s) => s.setModel);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const piAvailableModels = useSessionStore((s) => s.piAvailableModels);

  const provider = providers.find((p) => p.id === providerId);
  const isPi = provider?.id === "pi-sdk";
  const isClaude = provider?.id === "claude-sdk";
  // Built-in aliases come from the provider's capabilities (claude: static
  // aliases Auto/Sonnet/Opus/Fable). Pi declares none — its models are dynamic
  // (user-configured in PiModelsPanel) and surfaced via the separate
  // `piAvailableModels` list below, NOT through builtinModels.
  const builtinModels = provider?.capabilities.builtinModels ?? [];
  const supportsCustomEndpoint = provider?.capabilities.supportsCustomEndpoint ?? false;
  const showCustomSection = supportsCustomEndpoint && customModels.length > 0;
  // Pi surfaces its dynamically-discovered models as a flat list (the same
  // shape as builtin aliases). Claude shows its user-defined gateway configs
  // as the "模型列表" section instead — its static aliases are intentionally
  // hidden from the menu (users pick from their configured endpoints).
  const showPiModels = isPi && piAvailableModels.length > 0;
  // "管理模型" lands on the settings section for the active provider.
  const manageTarget: string | null = isPi ? "pi-models" : isClaude ? "custom-models" : null;

  // Chip label: a bound custom config wins; otherwise a built-in alias or the
  // raw model string.
  const activeCustom = customModels.find((m) => m.id === customModelId);
  const activeRoleBinding =
    activeCustom && (CUSTOM_MODEL_ROLES as string[]).includes(model)
      ? activeCustom.roles[model as CustomModelRoleKey]
      : undefined;
  const builtin = builtinModels.find((b) => b.id === model);
  const chipLabel = activeCustom
    ? (activeRoleBinding?.displayName?.trim() ||
      (activeRoleBinding ? CUSTOM_MODEL_ROLE_LABELS[model as CustomModelRoleKey] : model))
    : builtin?.label ?? model;

  const pickCustomRole = (cfgId: string, roleKey: CustomModelRoleKey) => {
    setCustomModel(cfgId, roleKey);
  };

  // Bound roles for a config, in canonical order (only roles with a requestModel).
  const boundRolesOf = (cfgId: string): CustomModelRoleKey[] => {
    const cfg = customModels.find((m) => m.id === cfgId);
    if (!cfg) return [];
    return CUSTOM_MODEL_ROLES.filter((r) => cfg.roles[r]?.requestModel?.trim());
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "composer-chip flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
          "text-content-muted hover:scale-105 hover:bg-accent/10 hover:text-accent active:scale-95",
        )}
        title="选择模型"
      >
        <span className="min-w-0 max-w-[180px] truncate">
          {chipLabel}
        </span>
        <IconChevronDown size={11} className="shrink-0 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[260px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            {/* Built-in aliases (provider-declared). Claude and Pi both hide
                this section: Claude users pick from their configured gateway
                endpoints (the "模型列表" section below); Pi has no built-in
                aliases at all (its models are user-configured, surfaced via
                the pi "模型列表" section). Future providers that declare
                builtinModels still surface them here. */}
            {!isClaude && !isPi && builtinModels.length > 0 && (
              <div className="border-b border-edge/60 pb-1">
                <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
                  内置模型
                </div>
                {builtinModels.map((b) => {
                  const active = !activeCustom && model === b.id;
                  return (
                    <Menu.Item
                      key={b.id}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                        "data-[highlighted]:bg-surface-muted",
                        active ? "text-accent" : "text-content-muted",
                      )}
                      onClick={() => setCustomModel(null, b.id)}
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="font-medium">{b.label}</span>
                        {b.hint && <span className="truncate text-xs text-content-subtle">{b.hint}</span>}
                      </span>
                      {active && <IconCheck size={14} className="shrink-0" />}
                    </Menu.Item>
                  );
                })}
              </div>
            )}

            {/* Pi models: dynamically discovered from ~/.pi/agent/models.json
                (configured in the Pi models settings panel). Flat list, single
                select — each entry maps to a "providerId/modelId" string that
                PiAgentSdkProvider resolves to a Model object at turn time. We
                use setModel (not setCustomModel) because pi has no custom-config
                concept: the picked id is a concrete model, persisted verbatim
                in the session's `model` field and consumed by the provider. */}
            {showPiModels && (
              <div className="border-b border-edge/60 pb-1">
                <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
                  模型列表
                </div>
                {piAvailableModels.map((b) => {
                  const active = model === b.id;
                  return (
                    <Menu.Item
                      key={b.id}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                        "data-[highlighted]:bg-surface-muted",
                        active ? "text-accent" : "text-content-muted",
                      )}
                      onClick={() => setModel(b.id)}
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="font-medium">{b.label}</span>
                        {b.hint && <span className="truncate text-xs text-content-subtle">{b.hint}</span>}
                      </span>
                      {active && <IconCheck size={14} className="shrink-0" />}
                    </Menu.Item>
                  );
                })}
              </div>
            )}

            {/* Custom-endpoint configs (only when the provider supports them).
                Each config exposes MULTIPLE models (one token, many models on
                the gateway) as a group with a hover-revealed submenu. */}
            {showCustomSection && (
              <div className="pt-1">
                <div className="flex items-center justify-between px-3 py-1">
                  <span className="text-xs uppercase tracking-wide text-content-subtle">模型列表</span>
                  <span className="text-xs text-content-subtle">{customModels.length}</span>
                </div>
                {customModels.map((m) => {
                  const cfgActive = customModelId === m.id;
                  const hasRoles = boundRolesOf(m.id).length > 0;
                  const rowTitle = `${m.baseUrl}\ntoken: ${m.authTokenMasked} (${m.authMode === "api_key" ? "x-api-key" : "Bearer"})`;
                  const rowContent = (
                    <>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{m.name}</span>
                        {m.protocol === "openai" && (
                          <span className="shrink-0 rounded bg-surface-muted px-1 text-[10px] text-content-subtle">OpenAI</span>
                        )}
                        {cfgActive && <IconCheck size={14} className="shrink-0" />}
                      </span>
                      <span className="ml-2 flex shrink-0 items-center gap-1">
                        <span className="truncate text-xs text-content-subtle">{hostOf(m.baseUrl)}</span>
                        {hasRoles && <IconChevronRight size={12} className="opacity-60" />}
                      </span>
                    </>
                  );
                  const rowClasses = cn(
                    "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                    cfgActive ? "text-accent" : "text-content-muted",
                  );
                  return hasRoles ? (
                    <Menu.SubmenuRoot key={m.id}>
                      <Menu.SubmenuTrigger
                        openOnHover
                        closeDelay={120}
                        className={rowClasses}
                        title={rowTitle}
                      >
                        {rowContent}
                      </Menu.SubmenuTrigger>
                      <Menu.Portal>
                        <Menu.Positioner side="right" align="start" sideOffset={4}>
                          <Menu.Popup
                            className={cn(
                              "z-50 min-w-[220px] origin-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
                              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                              "transition-[transform,opacity] duration-100",
                            )}
                          >
                            {boundRolesOf(m.id).map((roleKey) => {
                              const binding = m.roles[roleKey]!;
                              const active = cfgActive && model === roleKey;
                              const label =
                                binding.displayName?.trim() || CUSTOM_MODEL_ROLE_LABELS[roleKey];
                              return (
                                <Menu.Item
                                  key={roleKey}
                                  onClick={() => pickCustomRole(m.id, roleKey)}
                                  className={cn(
                                    "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] outline-none select-none",
                                    "data-[highlighted]:bg-surface-muted",
                                    active ? "text-accent" : "text-content-muted",
                                  )}
                                >
                                  <span className="flex min-w-0 items-baseline gap-2">
                                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-content-subtle">
                                      {CUSTOM_MODEL_ROLE_LABELS[roleKey]}
                                    </span>
                                    <span className="truncate">{label}</span>
                                    {binding.supports1m && (
                                      <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] text-accent">1M</span>
                                    )}
                                  </span>
                                  {active && <IconCheck size={14} className="shrink-0" />}
                                </Menu.Item>
                              );
                            })}
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.SubmenuRoot>
                  ) : (
                    <div key={m.id} className={rowClasses} title={rowTitle}>
                      {rowContent}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Empty state: no models of any kind to show. Pi with no
                configured providers still gets the "管理模型" entry below, so
                it only hits this branch when the pi SDK itself failed to load
                (piAvailableModels stays empty but manageTarget is set). */}
            {!isClaude && !isPi && builtinModels.length === 0 && !showPiModels && !showCustomSection && (
              <div className="px-3 py-2 text-[13px] text-content-subtle">
                暂无可用模型
              </div>
            )}
            {/* Claude with no custom configs: nudge toward configuration. */}
            {isClaude && !showCustomSection && (
              <div className="px-3 py-2 text-[13px] text-content-subtle">
                尚未配置模型,点击下方添加
              </div>
            )}
            {/* Pi with no discovered models: nudge toward the Pi models panel. */}
            {isPi && !showPiModels && (
              <div className="px-3 py-2 text-[13px] text-content-subtle">
                尚未配置模型,点击下方添加
              </div>
            )}

            {/* Manage-models entry — shown for providers that own a model
                configuration panel (claude → custom-models, pi → pi-models).
                Targets the matching settings section on open. */}
            {manageTarget && (
              <>
                <div className="my-1 border-t border-edge" />
                <Menu.Item
                  onClick={() => setSettingsOpen(true, manageTarget)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                    "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                  )}
                >
                  <IconPlus size={14} />
                  <span>添加 / 管理模型…</span>
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
