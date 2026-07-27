import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconBolt, IconChevronDown } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { EffortLevel } from "@contracts/runtime";

/**
 * Reasoning-effort picker for the composer toolbar — a dropdown showing the
 * 6 effort levels (Auto / Low / Med / High / XHigh / Max). Mirrors
 * PermissionModeDropdown's base-ui Menu styling so the two chips read as a
 * matched pair. Previously this was a click-to-cycle Chip; the dropdown
 * makes every level reachable in one click and shows hints inline.
 */

/** The 6 levels in increasing-effort order. `default` (= "Auto") means
 *  "let claude pick" — don't pass --effort. Higher = more thinking. */
const EFFORTS: ReadonlyArray<{
  value: EffortLevel;
  label: string;
  hint: string;
}> = [
  { value: "default", label: "Auto", hint: "让 Claude 自选" },
  { value: "low", label: "Low", hint: "最快,少思考" },
  { value: "medium", label: "Med", hint: "平衡" },
  { value: "high", label: "High", hint: "更多思考" },
  { value: "xhigh", label: "XHigh", hint: "深度思考" },
  { value: "max", label: "Max", hint: "最充分,最慢" },
];

/** Lookup used by the chip trigger label. */
const EFFORT_LABEL: Record<EffortLevel, string> = {
  default: "Auto",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function EffortDropdown() {
  const effort = useSessionStore((s) => s.effort);
  const setEffort = useSessionStore((s) => s.setEffort);

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
          "text-content-muted hover:bg-surface-muted",
        )}
        title="Reasoning effort for the next session"
      >
        <IconBolt size={11} className="shrink-0 opacity-80" />
        <span>{EFFORT_LABEL[effort] ?? effort}</span>
        <IconChevronDown size={9} className="shrink-0 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[220px] origin-bottom-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
              Reasoning effort
            </div>
            {EFFORTS.map((m) => {
              const active = m.value === effort;
              return (
                <Menu.Item
                  key={m.value}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    active ? "text-accent" : "text-content-muted",
                  )}
                  onClick={() => setEffort(m.value)}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
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
