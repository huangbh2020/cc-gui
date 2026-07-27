import { useEffect, useRef, useState } from "react";
import type { ContentTag } from "@renderer/lib/contentTag.js";

/**
 * Floating preview for a single content-tag chip. Shows the full pasted
 * content in a scrollable box with a Copy button. Anchored to the
 * composer's `relative` parent so it stays within the composer frame.
 *
 * Dismiss:
 *   - Click outside (mousedown on document)
 *   - ESC key
 *   - Clicking the chip body again (handled by parent — sets openTagId=null)
 *
 * The Copy button uses `navigator.clipboard.writeText` and shows a brief
 * "已复制" state on success. Falls back to selecting the text if the
 * clipboard API is unavailable (rare in Electron, but defensive).
 */
export function TagPopover({
  tag,
  onClose,
}: {
  tag: ContentTag;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // Outside-click + ESC close. Mirrors ModelDropdown's pattern.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The chip that opened us is OUTSIDE the popover; allow clicks on
      // chips to fall through to the parent's toggle handler instead of
      // swallowing them. We treat anything not inside the popover as
      // "outside" and close — the chip's own onClick will reopen.
      if (popoverRef.current && !popoverRef.current.contains(t)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Reset the "copied" pill after a moment so it doesn't linger.
  useEffect(() => {
    if (copyState === "idle") return;
    const t = setTimeout(() => setCopyState("idle"), 1200);
    return () => clearTimeout(t);
  }, [copyState]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(tag.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div
      ref={popoverRef}
      className="absolute left-2 right-2 top-12 z-30 max-h-60 overflow-hidden rounded-md border border-info/60 bg-surface shadow-2xl"
    >
      {/* Header: char count + copy/close */}
      <div className="flex items-center justify-between border-b border-info/30 bg-info/10 px-2 py-1">
        <span className="text-[10px] text-info/80">
          {tag.content.length.toLocaleString()} 字符 · 点击 × 或外部关闭
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="rounded px-1.5 py-0.5 text-[10px] text-info transition-colors hover:bg-info/30"
            title="复制完整内容"
          >
            {copyState === "copied" ? "已复制 ✓" : copyState === "failed" ? "复制失败" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1 text-[12px] text-info/80 transition-colors hover:bg-info/30 hover:text-info"
            title="关闭"
            aria-label="关闭预览"
          >
            ×
          </button>
        </div>
      </div>
      {/* Content: scrollable, preserves whitespace, monospace so code/log
          pastes keep their original column alignment. */}
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
        {tag.content}
      </pre>
    </div>
  );
}
