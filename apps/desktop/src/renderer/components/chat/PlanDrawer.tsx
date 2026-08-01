import { useEffect } from "react";
import { cn } from "@renderer/lib/cn.js";
import { IconClipboard, IconX } from "@renderer/lib/icons.js";
import { Markdown } from "./Markdown.js";

/**
 * Right-side slide-out drawer showing the full plan content.
 *
 * Rendered as an absolute overlay inside the ChatPane root (`relative flex
 * h-full flex-col`), so it covers a right-side strip of the chat area
 * (message stream + composer). Slides in from the right with a 160ms ease-out
 * animation. Closes on the X button or the Escape key.
 *
 * Triggered when the user clicks a plan title in the activity popover - the
 * popover closes and this drawer opens with that plan's full markdown. The
 * drawer is a pure reading view (no edit/approve actions here - those live in
 * the PlanApprovalPrompt sheet above the composer).
 *
 * Theme: neutral surface with a left border + heavy shadow so it reads as a
 * floating panel layered over the chat, not a replacement of it. The Markdown
 * body uses the same `prose-plan` styling as the inline PlanStreamBlock.
 */
export function PlanDrawer({
  plan,
  onClose,
}: {
  plan: string;
  onClose: () => void;
}) {
  // Esc closes the drawer (matches the ApprovalPrompt / dialog convention).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className={cn(
        "absolute right-0 top-0 bottom-0 z-40 flex w-[420px] max-w-[80%] flex-col",
        "border-l border-edge bg-surface shadow-2xl",
        "animate-[plan-drawer-in_160ms_ease-out]",
      )}
    >
      {/* Header - sticky title bar with close button. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2.5">
        <IconClipboard size={15} className="shrink-0 text-content-subtle" />
        <span className="text-xs font-semibold text-content">计划内容</span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          className={cn(
            "ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-content-muted transition-colors",
            "hover:bg-surface-muted hover:text-content",
          )}
        >
          <IconX size={15} />
        </button>
      </div>
      {/* Body - scrollable plan markdown. */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="prose-plan text-[12px] leading-relaxed text-content">
          <Markdown>{plan || "_(计划为空)_"}</Markdown>
        </div>
      </div>
    </div>
  );
}
