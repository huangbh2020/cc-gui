import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconChevronDown, IconLock } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/**
 * Provider (AI backend) picker for the composer toolbar.
 *
 * Shows only when more than one provider is registered. Once a session has
 * messages, its provider is fixed at creation — the chip becomes read-only
 * (a lock icon replaces the chevron, and the menu doesn't open) so the user
 * can't silently swap backends mid-conversation.
 *
 * Placement: first in the chip row (provider is a higher-level choice than
 * model/effort/permission). The model dropdown adapts to the chosen provider's
 * capabilities automatically.
 */
export function ProviderDropdown() {
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const setProvider = useSessionStore((s) => s.setProvider);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  // The active thread has messages → its provider is locked.
  const hasMessages = useSessionStore((s) => {
    if (!activeSessionId) return false;
    const bucket = s.messagesBySession[activeSessionId];
    return bucket !== undefined && bucket.length > 0;
  });

  // Single-provider installs need no picker.
  if (providers.length <= 1) return null;

  const active = providers.find((p) => p.id === providerId);

  const chip = (
    <button
      type="button"
      className={cn(
        "composer-chip flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
        hasMessages
          ? "cursor-default text-content-subtle opacity-80"
          : "text-content-muted hover:scale-105 hover:bg-accent/10 hover:text-accent active:scale-95",
      )}
      title={
        hasMessages
          ? "此会话的 SDK 已在创建时固定,不可更改"
          : "选择会话使用的 SDK"
      }
    >
      <span className="min-w-0 max-w-[140px] truncate">{active?.displayName ?? providerId}</span>
      {hasMessages ? (
        <IconLock size={11} className="shrink-0 opacity-70" />
      ) : (
        <IconChevronDown size={11} className="shrink-0 opacity-60" />
      )}
    </button>
  );

  // Locked: render a plain button, no menu.
  if (hasMessages) return chip;

  return (
    <Menu.Root>
      <Menu.Trigger render={chip} />
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[220px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
              选择 SDK
            </div>
            {providers.map((p) => {
              const activeItem = p.id === providerId;
              return (
                <Menu.Item
                  key={p.id}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    activeItem ? "text-accent" : "text-content-muted",
                  )}
                  onClick={() => setProvider(p.id)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{p.displayName}</span>
                  </span>
                  {activeItem && <IconCheck size={14} className="shrink-0" />}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
