import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconChevronDown,
  IconPrompt,
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
  const setModel = useSessionStore((s) => s.setModel);
  const setCustomModel = useSessionStore((s) => s.setCustomModel);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const pickBuiltin = (id: string) => {
    setModel(id);
    setCustomModel(null);
    setOpen(false);
  };
  const pickCustomRole = (cfgId: string, roleKey: CustomModelRoleKey) => {
    setCustomModel(cfgId, roleKey);
    setOpen(false);
  };

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
        <IconPrompt size={11} className="shrink-0 opacity-80" />
        <span className="max-w-[180px] truncate">
          {activeCustom
            ? `${activeCustom.name} / ${chipLabel}`
            : chipLabel}
        </span>
        <IconChevronDown size={9} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute bottom-full left-0 z-50 mb-1 max-h-[60vh] min-w-[240px] overflow-y-auto",
            "rounded-md border border-edge bg-surface py-1 shadow-2xl",
          )}
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
            内置模型
          </div>
          {BUILTIN_MODELS.map((b) => {
            const active = !customModelId && model === b.id;
            return (
              <button
                key={b.id}
                onClick={() => pickBuiltin(b.id)}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-surface-muted",
                  active ? "text-accent" : "text-content-muted",
                )}
              >
                <span>
                  <span className="font-medium">{b.label}</span>
                  <span className="ml-2 text-[10px] text-content-subtle">{b.hint}</span>
                </span>
                {active && <IconCheck size={12} className="shrink-0" />}
              </button>
            );
          })}

          <div className="my-1 border-t border-edge" />

          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[10px] uppercase tracking-wide text-content-subtle">自定义模型</span>
            <span className="text-[10px] text-content-subtle">{customModels.length}</span>
          </div>
          {customModels.length === 0 ? (
            <div className="px-3 py-1.5 text-[11px] text-content-subtle">尚未添加自定义模型</div>
          ) : (
            customModels.map((m) => {
              // A config is "active" when the session is bound to it; within
              // it, exactly one role is the current selection.
              const cfgActive = customModelId === m.id;
              // Bound roles in canonical order — only roles with a requestModel.
              const boundRoles = CUSTOM_MODEL_ROLES.filter((r) =>
                m.roles[r]?.requestModel?.trim(),
              );
              return (
                <div key={m.id} className="py-0.5">
                  {/* Config group header — name + host, non-interactive. */}
                  <div
                    className="flex items-center justify-between px-3 pt-1 text-[10px] text-content-subtle"
                    title={`${m.baseUrl}\ntoken: ${m.authTokenMasked} (${m.authMode === "api_key" ? "x-api-key" : "Bearer"})`}
                  >
                    <span className="truncate font-medium uppercase tracking-wide">{m.name}</span>
                    <span className="ml-2 shrink-0 truncate">{hostOf(m.baseUrl)}</span>
                  </div>
                  {/* One selectable row per bound role under this config. */}
                  {boundRoles.map((roleKey) => {
                    const binding = m.roles[roleKey]!;
                    const active = cfgActive && model === roleKey;
                    const label = binding.displayName?.trim() || CUSTOM_MODEL_ROLE_LABELS[roleKey];
                    return (
                      <button
                        key={roleKey}
                        onClick={() => pickCustomRole(m.id, roleKey)}
                        className={cn(
                          "flex w-full items-center justify-between pl-6 pr-3 py-1 text-left text-[11px] transition-colors hover:bg-surface-muted",
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
