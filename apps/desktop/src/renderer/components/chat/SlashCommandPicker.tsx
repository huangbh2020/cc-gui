/**
 * Composer slash-command picker. Anchored above the textarea when the user
 * types `/` at line start or after whitespace. Visual language matches
 * FileMentionPicker.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { IconSlash } from "@renderer/lib/icons.js";
import {
  filterSlashCommands,
  type SlashCommandDef,
} from "@renderer/lib/slashCommands.js";

export interface SlashCommandPickerProps {
  open: boolean;
  /** Query after the leading `/` (may be empty). */
  query: string;
  anchorRect: DOMRect | null;
  onPick: (cmd: SlashCommandDef) => void;
  onClose: () => void;
}

export function SlashCommandPicker({
  open,
  query,
  anchorRect,
  onPick,
  onClose,
}: SlashCommandPickerProps) {
  const commands = filterSlashCommands(query);
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open, commands]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(commands.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (commands.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const cmd = commands[activeIdx];
        if (cmd) onPick(cmd);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, commands, activeIdx, onPick, onClose]);

  if (!open || !anchorRect) return null;

  const top = Math.max(8, anchorRect.top - 8);
  const left = anchorRect.left;
  const width = Math.min(Math.max(anchorRect.width, 280), 420);

  return (
    <div
      className="fixed z-[70] flex max-h-64 flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
      style={{
        left,
        width,
        top,
        transform: "translateY(-100%)",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1.5 border-b border-edge px-2.5 py-1.5 text-[11px] text-content-muted">
        <IconSlash size={12} className="shrink-0 opacity-70" />
        <span className="truncate">命令{query ? ` · /${query}` : ""}</span>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {commands.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-content-subtle">
            无匹配命令
          </div>
        ) : (
          commands.map((cmd, idx) => {
            const Icon = cmd.icon;
            const isActive = idx === activeIdx;
            return (
              <button
                key={cmd.id}
                type="button"
                data-idx={idx}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => onPick(cmd)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
                  isActive ? "bg-accent/12 text-content" : "text-content",
                )}
              >
                {Icon ? (
                  <Icon size={14} className="shrink-0 text-content-muted" />
                ) : (
                  <IconSlash size={14} className="shrink-0 text-content-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{cmd.name}</span>
                  <span className="block truncate text-[10px] text-content-subtle">
                    {cmd.description}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-content-subtle">
                  {cmd.kind === "local" ? "本地" : "发送"}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t border-edge px-2.5 py-1 text-[10px] text-content-subtle">
        <span>
          <kbd className="rounded border border-edge px-1">↑</kbd>
          <kbd className="ml-0.5 rounded border border-edge px-1">↓</kbd>
          {" "}导航{" "}
          <kbd className="ml-1 rounded border border-edge px-1">↵</kbd>
          {" "}执行
        </span>
        <span>{commands.length} 条</span>
      </div>
    </div>
  );
}
