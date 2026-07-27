import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconSettings,
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

  const [open, setOpen] = useState(false);
  const [hoveredCfgId, setHoveredCfgId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close on outside click / ESC.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reset hover state when the dropdown closes.
  useEffect(() => {
    if (!open) setHoveredCfgId(null);
  }, [open]);

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
    setOpen(false);
  };

  // Bound roles for a config, in canonical order (only roles with a requestModel).
  const boundRolesOf = (cfgId: string): CustomModelRoleKey[] => {
    const cfg = customModels.find((m) => m.id === cfgId);
    if (!cfg) return [];
    return CUSTOM_MODEL_ROLES.filter((r) => cfg.roles[r]?.requestModel?.trim());
  };

  // Hover handlers with a small grace delay so users can cross the gap
  // between a config row and its submenu without losing focus.
  const enterConfig = (cfgId: string) => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHoveredCfgId(cfgId);
  };
  const leaveConfig = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHoveredCfgId(null), 120);
  };

  const hoveredRoles = hoveredCfgId ? boundRolesOf(hoveredCfgId) : [];

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
          "text-content-muted hover:bg-surface-muted",
        )}
        title="选择模型"
      >
        <span className="max-w-[180px] truncate">
          {chipLabel}
        </span>
        <IconChevronDown size={9} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute bottom-full left-0 z-50 mb-1 min-w-[240px]",
            "rounded-md border border-edge bg-surface py-1 shadow-2xl",
          )}
          onMouseLeave={leaveConfig}
        >
          {/* Built-in models are hidden per the simplified model picker. Only
              custom-model configs are surfaced, with their concrete models on
              a hover-revealed submenu to the right. */}

          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[10px] uppercase tracking-wide text-content-subtle">模型列表</span>
            <span className="text-[10px] text-content-subtle">{customModels.length}</span>
          </div>
          {customModels.length === 0 ? (
            <div className="px-3 py-1.5 text-[11px] text-content-subtle">尚未添加自定义模型</div>
          ) : (
            customModels.map((m) => {
              // A config is "active" when the session is bound to it.
              const cfgActive = customModelId === m.id;
              const cfgHovered = hoveredCfgId === m.id;
              const hasRoles = boundRolesOf(m.id).length > 0;
              return (
                <div
                  key={m.id}
                  className="relative py-0.5"
                  onMouseEnter={() => hasRoles && enterConfig(m.id)}
                >
                  {/* One row per config — name + host. Hover reveals the
                      concrete-model submenu to the right. */}
                  <button
                    type="button"
                    onClick={() => {
                      // No submenu to open: keep the row non-committal so the
                      // hover submenu stays the primary selection path.
                      if (!hasRoles) return;
                      enterConfig(m.id);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] transition-colors",
                      cfgHovered
                        ? "bg-surface-muted text-content"
                        : "text-content-muted hover:bg-surface-muted hover:text-content",
                      cfgActive && "text-accent",
                    )}
                    title={`${m.baseUrl}\ntoken: ${m.authTokenMasked} (${m.authMode === "api_key" ? "x-api-key" : "Bearer"})`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{m.name}</span>
                      {cfgActive && <IconCheck size={12} className="shrink-0" />}
                    </span>
                    <span className="ml-2 flex shrink-0 items-center gap-1">
                      <span className="truncate text-[10px] text-content-subtle">{hostOf(m.baseUrl)}</span>
                      {hasRoles && <IconChevronRight size={10} className="opacity-60" />}
                    </span>
                  </button>

                  {/* Submenu: concrete models for this config. Rendered to the
                      right edge of the root so long config names don't push it
                      off-screen. */}
                  {cfgHovered && hasRoles && (
                    <div
                      className={cn(
                        "absolute bottom-0 left-full z-50 ml-1 min-w-[200px] rounded-md border border-edge bg-surface py-1 shadow-2xl",
                      )}
                      onMouseEnter={enterConfig.bind(null, m.id)}
                    >
                      {hoveredRoles.map((roleKey) => {
                        const binding = m.roles[roleKey]!;
                        const active = cfgActive && model === roleKey;
                        const label = binding.displayName?.trim() || CUSTOM_MODEL_ROLE_LABELS[roleKey];
                        return (
                          <button
                            key={roleKey}
                            onClick={() => pickCustomRole(m.id, roleKey)}
                            className={cn(
                              "flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-surface-muted",
                              active ? "text-accent" : "text-content-muted",
                            )}
                          >
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="shrink-0 text-[9px] uppercase tracking-wide text-content-subtle">
                                {CUSTOM_MODEL_ROLE_LABELS[roleKey]}
                              </span>
                              <span className="truncate">{label}</span>
                              {binding.supports1m && (
                                <span className="shrink-0 rounded bg-accent/15 px-1 text-[9px] text-accent">1M</span>
                              )}
                            </span>
                            {active && <IconCheck size={12} className="shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}

          <div className="my-1 border-t border-edge" />
          <button
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors",
              "text-content-muted hover:bg-surface-muted hover:text-content",
            )}
          >
            <IconPlus size={12} />
            <span>添加 / 管理模型…</span>
          </button>
        </div>
      )}
    </div>
  );
}
