import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconShield,
  IconShieldCheck,
  IconShieldHalfFilled,
  IconShieldLock,
} from "@renderer/lib/icons.js";

/** Bottom status bar: claude status, active model/effort/mode, run state.
 * Mirrors the per-session settings chosen in the composer so they're always
 * visible at a glance. */
const MODEL_LABEL: Record<string, string> = {
  default: "Auto",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
};

/** Icon name → component for the permission chip (shared with the composer
 *  dropdown's icon map; kept in sync with the claude capabilities declaration
 *  in ClaudeAgentSdkProvider). */
const MODE_ICONS: Record<string, React.ReactNode> = {
  shield: <IconShield size={11} />,
  shieldCheck: <IconShieldCheck size={11} />,
  shieldHalf: <IconShieldHalfFilled size={11} />,
  shieldLock: <IconShieldLock size={11} />,
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
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);

  const statusColor = installed === false ? "text-danger" : installed === true ? "text-accent" : "text-content-subtle";
  const statusText = installed === false ? "claude not found" : installed === true ? "claude ready" : "checking claude…";

  // When a custom config is active, qualify the model label with the config name,
  // so the bar doesn't misleadingly show the same "Sonnet" for both built-in and
  // custom endpoints.
  const activeCustom = customModelId ? customModels.find((m) => m.id === customModelId) : undefined;
  const modelLabel = activeCustom
    ? `${activeCustom.name} · ${MODEL_LABEL[model] ?? model}`
    : MODEL_LABEL[model] ?? model;

  // Resolve the current mode's label/color/icon from the active provider's
  // declared permissionModes. Unknown values (e.g. pi has no permission modes,
  // or a persisted dontAsk) fall back to the raw string + neutral shield.
  const provider = providers.find((p) => p.id === providerId);
  const modeMeta = provider?.capabilities.permissionModes?.find((m) => m.value === permissionMode);
  const modeColor = modeMeta?.color ?? "";
  const modeIcon = (modeMeta?.icon && MODE_ICONS[modeMeta.icon]) || <IconShield size={11} />;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-surface px-3 text-[11px] text-content-subtle">
      <span className={statusColor}>●</span>
      <span className={installed === false ? "text-danger" : ""}>{statusText}</span>

      <span className="text-content-subtle">·</span>
      <span className="text-content-muted">{modelLabel}</span>
      {effort !== "default" && <span className="text-info">{effort}</span>}
      <span className="text-content-subtle">·</span>
      <span
        className={cn(
          "inline-flex items-center gap-1",
          modeColor || "text-content-muted",
        )}
      >
        <span className="shrink-0 opacity-90">{modeIcon}</span>
        {modeMeta?.label ?? permissionMode}
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
