import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import type { Block, ChatMessage } from "@renderer/stores/sessionStore.js";

/**
 * Fixed left-edge timeline of USER messages in the chat stream.
 *
 * Renders one small horizontal dash per user message, stacked vertically in
 * a fixed cluster centered on the left edge of the chat area. The cluster
 * does NOT move with the content — it stays anchored to the left edge's
 * vertical middle, so it's always visible regardless of scroll position.
 *
 * Features:
 *  - The dash whose message is currently in view (closest to the top of the
 *    viewport) is highlighted in accent color, so the user always knows
 *    "where they are" in the conversation.
 *  - Hovering a dash reveals a styled card to its right showing the
 *    message's timestamp (HH:MM:SS) and full text body (scrollable).
 *  - Clicking a dash scrolls its message to the top of the viewport.
 *
 * NOTE: because dashes are positionally decoupled from message rows, the
 * mapping is by ORDER (1st dash = oldest user message, last = newest). The
 * hover card + active highlight tie each dash back to its specific message.
 */

/** Map of messageId → row DOM element. The chat list registers each user
 *  row so this component can measure scroll positions and jump to a row. */
export type RowRefMap = Map<string, HTMLElement | null>;

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). Duplicated
 *  from ChatPane's private fmtClock to avoid widening its export surface. */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Flatten a message's blocks into plain text for the tooltip body. Mirrors
 *  ChatPane's blocksToText but kept local for the same decoupling reason. */
function blocksToText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      out.push(b.text);
    } else if (b.kind === "thinking") {
      const t = b.text.trim();
      if (t) out.push(`> ${t.replace(/\n/g, "\n> ")}`);
    }
  }
  return out.join("\n\n").trim();
}

export function MessageTimeline({
  messages,
  rowRefs,
  scrollRef,
}: {
  messages: ChatMessage[];
  rowRefs: RowRefMap;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const userMessages = messages.filter((m) => m.role === "user");
  // The id of the user message currently in view (its row is closest to the
  // top of the scroll viewport). Drives the active dash highlight.
  const [activeId, setActiveId] = useState<string | null>(null);

  // Recompute which user message is "in view" on scroll and on layout
  // changes. A message is considered in view once its top edge has scrolled
  // past (or reached) the top of the viewport; the active one is the LAST
  // such message (the most recent user prompt the reader is looking at).
  const computeActive = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = scroller.scrollTop;
    let current: string | null = null;
    for (const m of userMessages) {
      const row = rowRefs.get(m.id);
      if (!row) continue;
      // offsetTop is relative to the scroll content's offsetParent. A row
      // is "passed" when its top is at or above the viewport top. We pick
      // the last passed row (= closest to the top, most recent in view).
      if (row.offsetTop <= top + 1) current = m.id;
    }
    setActiveId(current);
  };

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    computeActive();
    scroller.addEventListener("scroll", computeActive, { passive: true });
    return () => scroller.removeEventListener("scroll", computeActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef, rowRefs, messages]);

  // Scroll a message row to the top of the viewport. Used by dash clicks.
  const jumpTo = (id: string) => {
    const scroller = scrollRef.current;
    const row = rowRefs.get(id);
    if (!scroller || !row) return;
    scroller.scrollTo({ top: row.offsetTop, behavior: "smooth" });
  };

  if (userMessages.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute left-0 top-1/2 z-10 -translate-y-1/2"
      aria-hidden
    >
      {/* Cluster of dashes, stacked vertically and centered as a group.
          pointer-events re-enabled so individual dashes are hoverable.
          NOTE: this container must NOT set overflow-y-auto — CSS spec says
          that when one overflow axis is non-visible the other computes to
          auto, which would clip the hover card that extends to the right
          (overflow-x). We bound the cluster with max-h + visible overflow
          instead so the card can break out. */}
      <div className="pointer-events-auto flex max-h-[70vh] flex-col items-center justify-center gap-1.5 py-1">
        {userMessages.map((m) => (
          <TimelineDash
            key={m.id}
            message={m}
            active={m.id === activeId}
            onJump={() => jumpTo(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** A single timeline dash with its hover-revealed detail card. */
function TimelineDash({
  message,
  active,
  onJump,
}: {
  message: ChatMessage;
  active: boolean;
  onJump: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const text = blocksToText(message.blocks);
  // Accent when this dash's message is the one in view; otherwise subtle.
  // Hover still brightens non-active dashes so the user gets feedback.
  const accent = active || hovered;

  return (
    <div
      className="relative flex h-5 w-5 cursor-pointer items-center justify-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onJump}
    >
      {/* The dash itself — a short horizontal bar. Accent-colored when its
          message is in view OR hovered; longer when active to stand out. */}
      <span
        className={cn(
          "block h-0.5 rounded-full transition-all",
          active ? "w-4 bg-accent" : hovered ? "w-4 bg-info" : "w-3 bg-content-subtle/60",
        )}
      />

      {/* Detail card — appears to the right of the dash. A child of this
          dash's relative container, so moving the cursor from the dash onto
          the card does NOT fire onMouseLeave (the card is a DOM descendant).
          The card is positioned with absolute + z-40 so it floats above the
          message stream regardless of source order. */}
      {hovered && (
        <div
          className={cn(
            "absolute left-full top-1/2 z-40 ml-2 w-72 -translate-y-1/2",
            "rounded-lg border border-edge bg-surface/95 p-3 shadow-2xl backdrop-blur",
          )}
        >
          {/* Timestamp header — accent dot when this message is in view. */}
          <div className="mb-1.5 flex items-center gap-1.5 border-b border-edge pb-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-accent" : "bg-info")} />
            <span className="text-[11px] tabular-nums text-content-muted">
              {fmtClock(message.createdAt)}
            </span>
            {active && (
              <span className="ml-auto rounded bg-accent/15 px-1 text-[9px] text-accent">当前</span>
            )}
          </div>
          {/* Message body — scrollable if long, preserves whitespace. */}
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-content">
            {text || <span className="text-content-subtle">(无文本内容)</span>}
          </div>
        </div>
      )}
    </div>
  );
}

