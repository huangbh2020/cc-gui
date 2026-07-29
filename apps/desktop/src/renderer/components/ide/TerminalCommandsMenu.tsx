import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import {
  IconBookmark,
  IconPlus,
  IconPencil,
  IconTrash,
} from "@renderer/lib/icons.js";
import type { CustomCommand } from "@contracts/ipc";

/**
 * Terminal quick-commands menu.
 *
 * A bookmark-shaped toolbar button that opens an upward dropdown listing the
 * user's saved commands. Clicking a command runs it immediately (the parent
 * TerminalPanel writes `command + "\n"` to the active PTY). The menu also
 * carries an inline add/edit/delete flow via a Dialog — fully self-contained,
 * no trip to the settings page needed.
 *
 * Mirrors the base-ui Menu styling of EffortDropdown / PermissionModeDropdown
 * so it reads as part of the same control family. Positioned side="top" so it
 * opens upward above the bottom terminal bar.
 */
export function TerminalCommandsMenu({ onRun }: { onRun: (command: string) => void }) {
  const commands = useSessionStore((s) => s.customCommands);
  const setCommands = useSessionStore((s) => s.setCustomCommands);

  // Dialog state: null = closed, otherwise the command being edited (or a
  // blank draft for "add"). We track it by the full draft so save can decide
  // add-vs-replace by whether an id was present at open time.
  const [editing, setEditing] = useState<{ id: string | null; name: string; command: string } | null>(null);

  const openAdd = () => setEditing({ id: null, name: "", command: "" });
  const openEdit = (cmd: CustomCommand) => setEditing({ id: cmd.id, name: cmd.name, command: cmd.command });

  const save = () => {
    if (!editing) return;
    const name = editing.name.trim();
    const command = editing.command.trim();
    if (!name || !command) return; // require both fields
    if (editing.id) {
      // replace existing
      setCommands(
        commands.map((c) => (c.id === editing.id ? { ...c, name, command } : c)),
      );
    } else {
      // append new
      const next: CustomCommand = { id: `cmd-${Date.now().toString(36)}`, name, command };
      setCommands([...commands, next]);
    }
    setEditing(null);
  };

  const remove = (id: string) => {
    setCommands(commands.filter((c) => c.id !== id));
    setEditing(null);
  };

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <button
              type="button"
              title="自定义命令"
              className={cn(
                "rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content",
              )}
            />
          }
        >
          <IconBookmark size={13} className="shrink-0" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end" sideOffset={4}>
            <Menu.Popup
              className={cn(
                "z-50 min-w-[240px] origin-bottom-right rounded-md border border-edge bg-surface py-1 shadow-2xl",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
                自定义命令
              </div>

              {commands.length === 0 ? (
                <div className="px-3 py-3 text-center text-[11px] text-content-subtle">
                  暂无自定义命令
                </div>
              ) : (
                commands.map((cmd) => (
                  <div
                    key={cmd.id}
                    className="group flex items-center gap-1 px-1 py-0.5 data-[highlighted]:bg-surface-muted"
                  >
                    {/* Clickable body: name (primary) + command (secondary, mono) */}
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-baseline gap-2 px-2 py-1 text-left"
                      onClick={() => {
                        onRun(cmd.command);
                      }}
                      title={`运行:${cmd.command}`}
                    >
                      <span className="shrink-0 text-[11px] font-medium text-content">
                        {cmd.name}
                      </span>
                      <span className="min-w-0 truncate font-mono text-[10px] text-content-subtle">
                        {cmd.command}
                      </span>
                    </button>
                    {/* Hover-revealed edit / delete */}
                    <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                      <button
                        type="button"
                        className="rounded p-0.5 text-content-subtle hover:bg-surface-hover hover:text-content"
                        title="编辑"
                        onClick={() => openEdit(cmd)}
                      >
                        <IconPencil size={11} />
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-content-subtle hover:bg-surface-hover hover:text-danger"
                        title="删除"
                        onClick={() => remove(cmd.id)}
                      >
                        <IconTrash size={11} />
                      </button>
                    </div>
                  </div>
                ))
              )}

              <div className="my-1 border-t border-edge" />
              <Menu.Item
                className={cn(
                  "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] outline-none select-none",
                  "text-accent data-[highlighted]:bg-surface-muted",
                )}
                onClick={openAdd}
              >
                <IconPlus size={12} className="shrink-0" />
                添加命令
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      {/* Add / edit dialog (controlled). */}
      <Dialog.Root open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
            <Dialog.Title>{editing?.id ? "编辑命令" : "添加命令"}</Dialog.Title>
            <Dialog.Description className="mt-1">
              保存后可在终端工具栏一键运行。
            </Dialog.Description>

            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-content-muted">名称</span>
                <Input
                  value={editing?.name ?? ""}
                  placeholder="例如:启动开发服务器"
                  onChange={(e) =>
                    editing && setEditing({ ...editing, name: (e.target as HTMLInputElement).value })
                  }
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-content-muted">命令</span>
                <textarea
                  value={editing?.command ?? ""}
                  placeholder="例如:npm run dev"
                  rows={3}
                  onChange={(e) => editing && setEditing({ ...editing, command: e.target.value })}
                  className={cn(
                    "w-full resize-y rounded border border-edge bg-surface px-2.5 py-1.5 font-mono text-xs leading-relaxed text-content placeholder:text-content-subtle outline-none transition-colors",
                    "focus:border-accent",
                  )}
                />
              </label>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div>
                {editing?.id && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      // Re-check inside the closure: `editing` may have changed
                      // between render and click.
                      if (editing?.id) remove(editing.id);
                    }}
                  >
                    删除
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={save}
                  disabled={!editing?.name.trim() || !editing?.command.trim()}
                >
                  保存
                </Button>
              </div>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
