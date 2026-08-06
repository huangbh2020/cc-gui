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
 * Model picker for the composer toolbar — a dropdown that groups built-in
 * aliases and the user's custom-model configs.
 *
 * Each custom config can expose MULTIPLE models (one token, many models on
 * the gateway). The dropdown renders each config as a group with its models
 * as selectable entries underneath, so the user can switch between e.g.
 * deepseek-v4-pro and deepseek-v4-flash under the same config.
 *
 * Selection state is the pair (customModelId, model):
 *   - built-in alias → customModelId=null, model="sonnet"|"opus"|…
 *   - custom model   → customModelId=<cfg id>, model=<one of cfg.models>
 *
 * Built on @base-ui/react/menu like EffortDropdown: the popup renders through
 * Menu.Portal (document.body), so it isn't clipped by the composer card's
 * overflow-hidden. Config rows with bound models open a nested submenu
 * (Menu.SubmenuRoot) — base-ui owns hover delay, keyboard navigation and
 * viewport-collision flipping instead of the old hand-rolled hover timers.
 */

const BUILTIN_MODELS = [
  { id: "default", label: "Auto", hint: "让 Claude 自选" },
  { id: "sonnet", label: "Sonnet", hint: "claude-sonnet" },
  { id: "opus", label: "Opus", hint: "claude-opus" },
  { id: "fable", label: "Fable", hint: "claude-fable" },
];

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
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  // Chip label: show the active role's display name (or role label),
  // qualified by its config name when custom.
  const activeCustom = customModels.find((m) => m.id === customModelId);
  const activeRoleBinding =
    activeCustom && (CUSTOM_MODEL_ROLES as string[]).includes(model)
      ? activeCustom.roles[model as CustomModelRoleKey]
      : undefined;
  const builtin = BUILTIN_MODELS.find((b) => b.id === model);
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
            {/* Built-in models are hidden per the simplified model picker. Only
                custom-model configs are surfaced, with their concrete models on
                a hover-revealed submenu to the right. */}
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-xs uppercase tracking-wide text-content-subtle">模型列表</span>
              <span className="text-xs text-content-subtle">{customModels.length}</span>
            </div>
            {customModels.length === 0 ? (
              <div className="px-3 py-2 text-[13px] text-content-subtle">尚未添加自定义模型</div>
            ) : (
              customModels.map((m) => {
                // A config is "active" when the session is bound to it.
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
                  // Rows with bound models open a nested submenu on hover
                  // (openOnHover default on; closeDelay preserves the grace
                  // period when crossing the gap into the submenu).
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
                  // No bound models: keep the row non-committal so the hover
                  // submenu stays the primary selection path.
                  <div key={m.id} className={rowClasses} title={rowTitle}>
                    {rowContent}
                  </div>
                );
              })
            )}

            <div className="my-1 border-t border-edge" />
            <Menu.Item
              onClick={() => setSettingsOpen(true)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconPlus size={14} />
              <span>添加 / 管理模型…</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
