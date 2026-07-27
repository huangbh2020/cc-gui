import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconPlayerPlay,
  IconEdit,
  IconBolt,
  IconPlayerSkipForward,
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

/** The 4 modes shown in the menu, in Claude Code's canonical order. */
const UI_MODES: ReadonlyArray<{
  value: PermissionMode;
  label: string;
  icon: React.ReactNode;
  hint: string;
}> = [
  { value: "default", label: "Default", icon: <IconPlayerPlay size={11} />, hint: "标准行为,工具按规则触发审批" },
  { value: "acceptEdits", label: "Edit Auto", icon: <IconEdit size={11} />, hint: "工作目录内的文件编辑自动放行" },
  { value: "plan", label: "Plan", icon: <IconBolt size={11} />, hint: "只读探索,所有写操作都需审批" },
  { value: "bypassPermissions", label: "Bypass", icon: <IconPlayerSkipForward size={11} />, hint: "跳过所有权限检查(慎用)" },
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

const PERMISSION_MODE_ICON: Record<PermissionMode, React.ReactNode> = {
  default: <IconPlayerPlay size={11} />,
  acceptEdits: <IconEdit size={11} />,
  plan: <IconBolt size={11} />,
  bypassPermissions: <IconPlayerSkipForward size={11} />,
  dontAsk: <span>?</span>,
  auto: <span>◐</span>,
};

export function PermissionModeDropdown() {
  const permissionMode = useSessionStore((s) => s.permissionMode);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);

  // Chip text falls back to the raw value for non-UI modes (dontAsk/auto).
  const chipLabel = PERMISSION_MODE_LABEL[permissionMode] ?? permissionMode;
  const chipIcon = PERMISSION_MODE_ICON[permissionMode] ?? <span>·</span>;
  const isNonDefault = permissionMode !== "default";

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
          isNonDefault
            ? "bg-surface-hover/80 text-content"
            : "text-content-subtle hover:bg-surface-muted hover:text-content-muted",
        )}
        title="Permission mode for the next session"
      >
        <span className="opacity-80">{chipIcon}</span>
        <span>{chipLabel}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[240px] origin-bottom-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
              Permission mode
            </div>
            {UI_MODES.map((m) => {
              const active = m.value === permissionMode;
              return (
                <Menu.Item
                  key={m.value}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    active ? "text-accent" : "text-content-muted",
                  )}
                  onClick={() => {
                    setPermissionMode(m.value);
                  }}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 opacity-80">{m.icon}</span>
                    <span className="font-medium">{m.label}</span>
                    <span className="truncate text-[10px] text-content-subtle">{m.hint}</span>
                  </span>
                  {active && <IconCheck size={12} className="shrink-0" />}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
