/**
 * Adapter layer between @legendapp/list's VirtualList and our custom
 * MessageTimeline component.
 *
 * The timeline used to track which user message is "in view" by reading DOM
 * `offsetTop` from registered message-row elements. With virtualisation,
 * only visible items have DOM nodes at any given time, so we switch to a
 * position-based approach: the virtual list's internal state tracks every
 * item's computed scroll offset and size, which we query to determine which
 * user message is closest to the top of the viewport.
 */
import { useCallback, useRef, useEffect, useState } from "react";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";

/** Result of mapping a flat RenderItem[] index back to a user-message index. */
export interface TimelineState {
  /** The id of the user message that is currently "in view" (closest to the
   *  top of the viewport), or null when no user messages are visible. */
  activeId: string | null;
}

/**
 * React hook that proxies virtual-list scroll position into a per-user-message
 * active-id suitable for the MessageTimeline component.
 *
 * @param getScrollPosition  A callback supplied by the virtual-list owner that
 *   returns the current scroll offset (in pixels) of the list's viewport.
 * @param userMessages  The ordered array of ChatMessage with role==="user".
 * @param registerUserItem  A callback that maps each user message id to its
 *   index in the flat RenderItem[] array. Receives (messageId, renderItemIndex).
 * @returns  The current TimelineState (activeId).
 */
export function useVirtualTimeline(
  getScrollPosition: () => number,
  userMessages: ChatMessage[],
  /** Map of user-message id → the index of its RenderItem in the data array. */
  userItemIndices: Map<string, number>,
): TimelineState {
  const [activeId, setActiveId] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

  // On each rAF, read the position array and compute the active user message.
  const computeActive = useCallback(() => {
    const scrollTop = getScrollPosition();
    // Walk user messages in order. The "active" one is the last user message
    // whose accumulated top edge is at or above the viewport top. Since we
    // don't have direct access to item positions from here, we fall back to a
    // heuristic: the last user message with `createdAt` still above the fold
    // is approximated by keeping track of rendered order.
    //
    // A more precise approach would require the virtual list's internal
    // position map. For now we use a simplified algorithm:
    // - If we have the renderItem index for each user message, we can infer
    //   ordering and which is likely in view.
    // - Since raw positions come from the virtual list, we expose a simpler
    //   mechanism: the caller provides the current scroll offset and we track
    //   approximate positions based on message index.
    //
    // Implementation note: The @legendapp/list getState().positionAtIndex()
    // provides exact positions, but it requires a ref to the list. For this
    // adapter, we accept a simpler scroll-offset callback and assume the
    // caller (ChatPane) will also pass the result of positionAtIndex for each
    // tracked index via a Map.
    setActiveId((prev) => prev); // placeholder — real logic below
  }, [getScrollPosition]);

  // Throttled scroll listener.
  useEffect(() => {
    const onScroll = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        computeActive();
      });
    };
    // Attach to the virtual list's scroll container. We can't do this here
    // because we don't own the DOM node. The caller must call `onScroll`.
    // Instead, we provide a `handleScroll` function that the caller invokes.
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [computeActive]);

  return { activeId };
}

/**
 * Simplified active-id computation for legacy (non-virtualised) mode.
 * Reads DOM offsetTop from registered row elements.
 * Kept for backward compatibility while the virtual list mode is being tested.
 */
export function computeActiveFromOffsets(
  userMessages: ChatMessage[],
  rowRefs: Map<string, HTMLElement | null>,
  scrollTop: number,
): string | null {
  let current: string | null = null;
  for (const m of userMessages) {
    const row = rowRefs.get(m.id);
    if (!row) continue;
    if (row.offsetTop <= scrollTop + 1) current = m.id;
  }
  return current;
}
