import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { PERMISSION_MODE_LABEL } from "@renderer/components/chat/PermissionModeDropdown.js";
import type { PermissionMode } from "@contracts/runtime";

/** Bottom status bar: claude status, active model/effort/mode, run state.
 * Mirrors the per-session settings chosen in the composer so they're always
 * visible at a glance. */
const MODEL_LABEL: Record<string, string> = {
  default: "Auto",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
};
/** Per-mode accent for the status bar. `bypassPermissions` is the only
 *  truly dangerous one — it skips every permission check — so it gets the
 *  danger color. The rest are warning-tinted to show "non-default". */
const MODE_COLOR: Record<PermissionMode, string> = {
  default: "text-content-muted",
  acceptEdits: "text-warning",
  plan: "text-warning",
  bypassPermissions: "text-danger",
  dontAsk: "text-warning",
  auto: "text-warning",
};

export function StatusBar() {
  // Per-thread running flag: the bottom bar should show "working" only when
  // the *currently active* thread has a turn in flight. A background turn in
  // another thread is invisible here (the user can check via LeftBar later).
  const isRunning = useSessionStore((s) =>
    s.activeSessionId ? !!s.runningBySession[s.activeSessionId] : false,
  );
  const installed = useSessionStore((s) => s.claudeInstalled);
  const model = useSessionStore((s) => s.model);
  const customModelId = useSessionStore((s) => s.customModelId);
  const customModels = useSessionStore((s) => s.customModels);
  const effort = useSessionStore((s) => s.effort);
  const permissionMode = useSessionStore((s) => s.permissionMode);

  const statusColor = installed === false ? "text-danger" : installed === true ? "text-accent" : "text-content-subtle";
  const statusText = installed === false ? "claude not found" : installed === true ? "claude ready" : "checking claude…";

  // When a custom config is active, qualify the model label with the config name,
  // so the bar doesn't misleadingly show the same "Sonnet" for both built-in and
  // custom endpoints.
  const activeCustom = customModelId ? customModels.find((m) => m.id === customModelId) : undefined;
  const modelLabel = activeCustom
    ? `${activeCustom.name} · ${MODEL_LABEL[model] ?? model}`
    : MODEL_LABEL[model] ?? model;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-surface px-3 text-[11px] text-content-subtle">
      <span className={statusColor}>●</span>
      <span className={installed === false ? "text-danger" : ""}>{statusText}</span>

      <span className="text-content-subtle">·</span>
      <span className="text-content-muted">{modelLabel}</span>
      {effort !== "default" && <span className="text-info">{effort}</span>}
      <span className="text-content-subtle">·</span>
      <span className={MODE_COLOR[permissionMode] ?? "text-content-muted"}>
        {PERMISSION_MODE_LABEL[permissionMode] ?? permissionMode}
      </span>

      <div className="flex-1" />

      {isRunning && (
        <span className="flex items-center gap-1 text-warning">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
          working
        </span>
      )}
      {!isRunning && <span className="text-content-subtle">ready</span>}
    </footer>
  );
}
