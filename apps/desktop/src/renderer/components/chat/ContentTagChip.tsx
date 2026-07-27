import type { ContentTag } from "@renderer/lib/contentTag.js";

/**
 * A single content-tag chip rendered above the textarea in the composer.
 * Click the body to toggle its popover preview; click the × to remove.
 *
 * Info-blue palette matches the QuestionPrompt accent so "interactive
 * composer addition" reads the same across the input area. Visually
 * distinct from tool-approval cards (amber) and plan-approval cards
 * (violet), each of which represents a *blocking* decision; a tag is
 * just a piece of draft content the user is composing with.
 */
export function ContentTagChip({
  tag,
  open,
  onToggle,
  onRemove,
}: {
  tag: ContentTag;
  /** Whether this chip's popover is currently shown. Affects the
   *  visual emphasis (active chip gets a stronger border). */
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <span
      className={`group inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors ${
        open
          ? "border-info bg-info/40 text-info"
          : "border-info/40 bg-info/20 text-info hover:border-info/70 hover:bg-info/30"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        title={open ? "收起预览" : "查看内容"}
        className="flex items-center gap-1"
      >
        <span aria-hidden className="opacity-70">
          📋
        </span>
        <span className="max-w-[160px] truncate font-normal">{tag.preview}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        title="删除此附件"
        aria-label="删除此附件"
        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-info/70 transition-colors hover:bg-info/40 hover:text-info"
      >
        ×
      </button>
    </span>
  );
}
