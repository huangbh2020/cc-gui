/**
 * Command palette — a Cmd/Ctrl+K modal for fast keyboard navigation.
 *
 * Architecture follows the Base UI documented pattern for composing a
 * Combobox inside a Dialog:
 *   - `Dialog.Root` (controlled by `commandPaletteOpen` in the store) supplies
 *     the modal layer, backdrop, and top-centered positioning.
 *   - `Combobox.Root inline open` is embedded inside the dialog. `inline`
 *     means the list renders inline (no separate popup) and `open` is bound
 *     to the dialog so the combobox resets its query/highlight when the dialog
 *     closes. See base-ui combobox `inline` prop docs.
 *   - A custom `filter` (commandMatches) matches label + keywords.
 *   - Commands are grouped by `CommandGroup`; each group renders a label
 *     header followed by its items.
 *
 * Selection: clicking an item or pressing Enter on a highlighted item fires
 * the item's `onClick`, which runs the command's `perform` against the live
 * store and closes the palette. The list closes after every run (command
 * palettes are one-shot).
 *
 * The palette is mounted once at the App root (see App.tsx) so it overlays
 * both the workspace and settings views.
 */
import { useMemo, useRef } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Combobox } from "@base-ui/react/combobox";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  collectCommands,
  commandMatches,
  COMMAND_GROUPS,
  type CommandDef,
  type CommandGroup,
} from "@renderer/lib/commands.js";

export function CommandPalette() {
  const open = useSessionStore((s) => s.commandPaletteOpen);
  const setOpen = useSessionStore((s) => s.setCommandPaletteOpen);
  const inputRef = useRef<HTMLInputElement>(null);

  // Collect commands from the live store state. `getState()` gives us a
  // snapshot that includes dynamic session-switch commands. We re-collect on
  // every open so freshly-created sessions appear without a remount.
  const commands = useMemo<CommandDef[]>(() => {
    if (!open) return [];
    return collectCommands(useSessionStore.getState());
  }, [open]);

  const close = () => setOpen(false);

  const runCommand = (cmd: CommandDef | undefined) => {
    if (!cmd) return;
    const store = useSessionStore.getState();
    void cmd.perform(store);
    close();
  };

  // Group filtered commands for rendering, preserving COMMAND_GROUPS order.
  const grouped = useMemo(() => {
    const map = new Map<CommandGroup, CommandDef[]>();
    for (const g of COMMAND_GROUPS) map.set(g, []);
    for (const cmd of commands) {
      const bucket = map.get(cmd.group);
      if (bucket) bucket.push(cmd);
    }
    return COMMAND_GROUPS.map((g) => ({ group: g, items: map.get(g)! })).filter(
      (x) => x.items.length > 0,
    );
  }, [commands]);

  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(o) => setOpen(o)}
      // Focus the input when the dialog opens so typing works immediately.
      onOpenChangeComplete={(o) => {
        if (o) inputRef.current?.focus();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity",
          )}
        />
        <BaseDialog.Popup
          className={cn(
            "fixed left-1/2 top-[12vh] z-50 w-[min(92vw,560px)] -translate-x-1/2",
            "overflow-hidden rounded-xl border border-edge bg-surface shadow-2xl",
            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            "transition-[transform,opacity] duration-150",
          )}
        >
          {/* Combobox drives keyboard nav + filtering. `inline` + `open` is
              the documented way to embed it in a Dialog (see combobox inline
              prop). open follows the dialog so query/highlight reset on close. */}
          <Combobox.Root<CommandDef>
            open
            inline
            virtualized={false}
            filter={(item, query) => commandMatches(item, query)}
            items={commands}
            // Auto-highlight the first match so Enter runs immediately.
            autoHighlight
            /* The input value mirrors the live query for our filter; we don't
               use selection, so onValueChange is unused. */
            onValueChange={() => {
              /* no-op: commands are one-shot actions, not selectable values */
            }}
          >
            {/* Search input row */}
            <div className="flex items-center gap-2 border-b border-edge px-3">
              <Combobox.Input
                ref={inputRef}
                autoFocus
                placeholder="输入命令或搜索…"
                className={cn(
                  "h-11 flex-1 bg-transparent text-sm text-content",
                  "placeholder:text-content-subtle focus:outline-none",
                )}
              />
            </div>

            {/* Results list */}
            <div className="max-h-[52vh] overflow-y-auto p-1.5">
              <Combobox.List className="flex flex-col gap-1">
                {grouped.map(({ group, items }) => (
                  <Combobox.Group key={group} className="flex flex-col gap-0.5">
                    <Combobox.GroupLabel
                      className={cn(
                        "px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                        "text-content-subtle",
                      )}
                    >
                      {group}
                    </Combobox.GroupLabel>
                    {items.map((cmd) => {
                      const Icon = cmd.icon;
                      return (
                        <Combobox.Item
                          key={cmd.id}
                          value={cmd}
                          onClick={() => runCommand(cmd)}
                          className={cn(
                            "group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5",
                            "text-[13px] text-content",
                            "data-[highlighted]:bg-accent/12 data-[highlighted]:text-content",
                            "outline-none",
                          )}
                        >
                          {Icon && (
                            <Icon
                              size={15}
                              className="shrink-0 text-content-muted data-[highlighted]:text-accent group-data-[highlighted]:text-accent"
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                          {cmd.shortcutHint && (
                            <kbd className="shrink-0 rounded border border-edge bg-surface-muted px-1 py-0.5 text-[10px] text-content-subtle">
                              {cmd.shortcutHint}
                            </kbd>
                          )}
                        </Combobox.Item>
                      );
                    })}
                  </Combobox.Group>
                ))}
                <Combobox.Empty
                  className={cn(
                    "px-3 py-8 text-center text-[13px] text-content-subtle",
                  )}
                >
                  无匹配命令
                </Combobox.Empty>
              </Combobox.List>
            </div>

            {/* Footer hint */}
            <div
              className={cn(
                "flex items-center justify-between border-t border-edge px-3 py-1.5",
                "text-[10px] text-content-subtle",
              )}
            >
              <span className="flex items-center gap-2">
                <span>
                  <kbd className="rounded border border-edge px-1">↑</kbd>
                  <kbd className="ml-0.5 rounded border border-edge px-1">↓</kbd>
                  {" "}
                  导航
                </span>
                <span>
                  <kbd className="rounded border border-edge px-1">↵</kbd>
                  {" "}
                  执行
                </span>
                <span>
                  <kbd className="rounded border border-edge px-1">esc</kbd>
                  {" "}
                  关闭
                </span>
              </span>
              <span>{commands.length} 条命令</span>
            </div>
          </Combobox.Root>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
