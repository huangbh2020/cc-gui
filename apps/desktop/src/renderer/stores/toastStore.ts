/**
 * Global in-app toast notification store.
 *
 * Fires toasts for background session events when the window IS focused (OS
 * notifications are suppressed in that case). The toast appears at the
 * bottom-right of the app, auto-dismisses after a timeout, and is clickable
 * to navigate to the source session.
 *
 * Toasts are fired from sessionStore.ingestEvent for non-active sessions:
 *  - blocking events (approval / question / plan approval) -> "warning" tone
 *  - turn completion -> "info" tone
 *  - errors -> "error" tone
 *  - background subagent completion -> "info" tone
 *
 * The Toaster component (components/layout/Toaster.tsx) reads this store and
 * renders the stack. Mounted once at the app root.
 */
import { create } from "zustand";

/** Visual severity of a toast. Drives the icon + left-border accent color. */
export type ToastKind = "info" | "warning" | "error";

/** A single toast entry in the stack. */
export interface ToastItem {
  /** Client-generated unique id (used as the React key + for dismissal). */
  id: string;
  /** Severity - drives icon + accent color. */
  kind: ToastKind;
  /** One-line title (bold). */
  title: string;
  /** Optional body text (muted, below the title). */
  body?: string;
  /** Session to navigate to on click. Absent for non-session toasts. */
  sessionId?: string;
  /** Auto-dismiss timeout in ms. 0 = sticky (must be clicked). Default 6000. */
  duration: number;
  /** Timestamp for dedup (toasts with the same title+sessionId within 2s
   *  are collapsed). */
  createdAt: number;
}

interface ToastState {
  toasts: ToastItem[];
  /** Push a toast. Deduplicates by title+sessionId within a 2s window so a
   *  burst of events from the same session doesn't stack identical toasts. */
  push: (opts: {
    kind: ToastKind;
    title: string;
    body?: string;
    sessionId?: string;
    duration?: number;
  }) => void;
  /** Remove a toast by id. */
  dismiss: (id: string) => void;
  /** Clear all toasts. */
  clear: () => void;
}

/** Module-level counter for unique ids (cheaper than crypto.randomUUID per
 *  toast). */
let idCounter = 0;
const nextId = () => `toast_${Date.now()}_${idCounter++}`;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ kind, title, body, sessionId, duration = 6000 }) => {
    const now = Date.now();
    // Dedup: if a toast with the same title + sessionId was pushed within the
    // last 2 seconds, skip this one (avoids stacking from event bursts).
    const existing = get().toasts;
    if (existing.some((t) => t.title === title && t.sessionId === sessionId && now - t.createdAt < 2000)) {
      return;
    }
    const id = nextId();
    const item: ToastItem = { id, kind, title, body, sessionId, duration, createdAt: now };
    set((s) => ({ toasts: [...s.toasts, item] }));
    // Auto-dismiss after the timeout (unless duration is 0 = sticky).
    if (duration > 0) {
      setTimeout(() => {
        get().dismiss(id);
      }, duration);
    }
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  clear: () => set({ toasts: [] }),
}));
