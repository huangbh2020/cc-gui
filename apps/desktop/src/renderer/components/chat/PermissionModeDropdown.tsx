import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconShield,
  IconShieldCheck,
  IconShieldHalfFilled,
  IconShieldLock,
  IconChevronDown,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { PermissionMode } from "@contracts/runtime";

/**
 * Permission-mode picker for the composer toolbar — a dropdown showing the
 * 4 user-facing modes that Claude Code's own UI exposes:
 *   default · acceptEdits · plan · bypassPermissions
 *
 * The underlying `PermissionMode` union is wider (also includes `dontAsk`
 * and `auto`) so values arriving via --resume or settings sync round-trip
 * safely through the contract. Those two are not selectable from the UI —
 * the chip falls back to the raw value so it's never blank — but the union
 * stays open for future expansion.
 *
 * Uses @base-ui/react Menu for state management, keyboard navigation,
 * and positioning, with a compact chip-style trigger.
 */

/** The 4 modes shown in the menu, in Claude Code's canonical order.
 *
 *  Each mode carries a shield-style icon and a semantic color token that
 *  reflects its privilege/risk level: riskier modes get warmer colors so
 *  the chip telegraphs risk at a glance.
 *    default            → (muted)  baseline, rules-based approval
 *    plan               → info     read-only / constrained exploration
 *    acceptEdits        → warning  auto-accepts file edits (medium risk)
 *    bypassPermissions  → danger   skips ALL checks (highest risk)
 */
type ModeMeta = {
  value: PermissionMode;
  label: string;
  icon: React.ReactNode;
  color: string; // Tailwind text-color class applied to BOTH icon and label
  hint: string;
};

const UI_MODES: ReadonlyArray<ModeMeta> = [
  {
    value: "default",
    label: "Default",
    icon: <IconShield size={11} />,
    color: "",
    hint: "标准行为,工具按规则触发审批",
  },
  {
    value: "acceptEdits",
    label: "Edit Auto",
    icon: <IconShieldCheck size={11} />,
    color: "text-warning",
    hint: "工作目录内的文件编辑自动放行",
  },
  {
    value: "plan",
    label: "Plan",
    icon: <IconShieldHalfFilled size={11} />,
    color: "text-info",
    hint: "只读探索,所有写操作都需审批",
  },
  {
    value: "bypassPermissions",
    label: "Bypass",
    icon: <IconShieldLock size={11} />,
    color: "text-danger",
    hint: "跳过所有权限检查(慎用)",
  },
];

/** Lookup used by both the chip and the StatusBar. */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Edit Auto",
  plan: "Plan",
  bypassPermissions: "Bypass",
  // Not selectable from the UI but shown verbatim if they ever appear so the
  // chip / status bar never goes blank.
  dontAsk: "DontAsk",
  auto: "Auto",
};

/** Shared per-mode metadata (icon + risk color) used by both the composer
 *  chip and the StatusBar, so the two displays always agree. The "color" is
 *  an empty string for the baseline `default` mode so it inherits neutral
 *  muted text; riskier modes carry an explicit semantic token. */
export const PERMISSION_MODE_META: Record<PermissionMode, ModeMeta> = (() => {
  const byValue = new Map(UI_MODES.map((m) => [m.value, m]));
  const fallback: ModeMeta = {
    value: "default",
    label: "",
    icon: <IconShield size={11} />,
    color: "",
    hint: "",
  };
  const out = {} as Record<PermissionMode, ModeMeta>;
  (["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"] as PermissionMode[]).forEach(
    (v) => {
      out[v] = byValue.get(v) ?? { ...fallback, value: v };
    },
  );
  return out;
})();

export function PermissionModeDropdown() {
  const permissionMode = useSessionStore((s) => s.permissionMode);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);

  // Chip text falls back to the raw value for non-UI modes (dontAsk/auto).
  const chipLabel = PERMISSION_MODE_LABEL[permissionMode] ?? permissionMode;
  const chipMeta = PERMISSION_MODE_META[permissionMode];
  const chipIcon = chipMeta.icon;
  // Mode-specific color (info / warning / danger); empty for the baseline
  // "default" mode so it inherits the chip's neutral muted text.
  const modeColor = chipMeta.color;

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
          "text-content-muted hover:scale-105 hover:bg-accent/10 active:scale-95",
          // Only switch the label to accent on hover for the neutral mode —
          // riskier modes (warning/danger) keep their semantic color so the
          // chip never loses its risk telegraph.
          !modeColor && "hover:text-accent",
          modeColor,
        )}
        title="Permission mode for the next session"
      >
        <span className="shrink-0 opacity-90">{chipIcon}</span>
        <span>{chipLabel}</span>
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
            <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
              Permission mode
            </div>
            {UI_MODES.map((m) => {
              const active = m.value === permissionMode;
              return (
                <Menu.Item
                  key={m.value}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    active ? "text-accent" : "text-content-muted",
                  )}
                  onClick={() => {
                    setPermissionMode(m.value);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn("shrink-0 opacity-90", active ? "" : m.color)}>{m.icon}</span>
                    <span className={cn("font-medium", active ? "" : m.color)}>{m.label}</span>
                    <span className="truncate text-xs text-content-subtle">{m.hint}</span>
                  </span>
                  {active && <IconCheck size={14} className="shrink-0" />}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
