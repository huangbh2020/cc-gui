import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { PermissionMode, EffortLevel } from "@contracts/runtime";

/**
 * In-composer option chips (Codex-style). Renders as a row meant to sit at the
 * *bottom* of the composer box, left-aligned, sharing a line with the send
 * button. Each chip cycles through values on click. Compact + muted so the
 * textarea stays the focal point.
 */

const MODELS = ["default", "fable", "opus", "sonnet"] as const;
const MODEL_LABEL: Record<string, string> = {
  default: "Auto",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
};

const EFFORTS: EffortLevel[] = ["default", "low", "medium", "high", "xhigh", "max"];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  default: "Auto",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const MODE_ORDER: PermissionMode[] = ["default", "plan", "acceptEdits"];
const MODE_LABEL: Record<PermissionMode, string> = { default: "Default", plan: "Plan", acceptEdits: "Edits" };
const MODE_ICON: Record<PermissionMode, string> = { default: "▸", plan: "⚡", acceptEdits: "✎" };

function Chip({
  icon,
  label,
  active = false,
  title,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
        active ? "bg-zinc-700/80 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      }`}
      title={title}
    >
      <span className="opacity-80">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export function ComposerToolbar() {
  const model = useSessionStore((s) => s.model);
  const setModel = useSessionStore((s) => s.setModel);
  const effort = useSessionStore((s) => s.effort);
  const setEffort = useSessionStore((s) => s.setEffort);
  const permissionMode = useSessionStore((s) => s.permissionMode);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);

  const cycle = <T,>(arr: readonly T[], cur: T, set: (v: T) => void) => {
    const i = arr.indexOf(cur);
    set(arr[(i + 1) % arr.length]);
  };

  return (
    <div className="flex items-center gap-0.5">
      <Chip
        icon="◆"
        label={MODEL_LABEL[model] ?? model}
        title="Model for the next session (click to cycle)"
        onClick={() => cycle(MODELS, model, setModel)}
      />
      <Chip
        icon="✦"
        label={EFFORT_LABEL[effort]}
        active={effort !== "default"}
        title="Reasoning effort for the next session (click to cycle)"
        onClick={() => cycle(EFFORTS, effort, setEffort)}
      />
      <Chip
        icon={MODE_ICON[permissionMode]}
        label={MODE_LABEL[permissionMode]}
        active={permissionMode !== "default"}
        title="Permission mode for the next session (click to cycle)"
        onClick={() => cycle(MODE_ORDER, permissionMode, setPermissionMode)}
      />
    </div>
  );
}
