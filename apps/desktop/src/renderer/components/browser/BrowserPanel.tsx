import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { PickedElement, BrowserDevicePreset } from "@contracts/ipc";
import { BrowserToolbar } from "./BrowserToolbar.js";
import { BrowserTabs, type BrowserTabDisplay } from "./BrowserTabs.js";
import { PickedElementsBar } from "./PickedElementsBar.js";

/**
 * Embedded browser panel overlay (multi-tab).
 *
 * Renders a full-workspace overlay (below the 40px titlebar) containing a tab
 * strip + a BrowserToolbar + a placeholder div. The actual web pages are
 * rendered by main-process WebContentsViews that float ABOVE the renderer at
 * OS level - one view per tab. The placeholder div is just a measurement
 * target whose getBoundingClientRect() drives `api.browser.setBounds` for the
 * active tab's view; background tabs' views stay parked offscreen.
 *
 * The main process (BrowserManager) already supports N concurrent views keyed
 * by browserId - every navigation/loading/pickResult event carries the
 * browserId so this component can route updates to the owning tab. Closing the
 * panel only hides the views (preserving browsing state); reopening restores
 * the active tab. Views are destroyed on app quit (disposeAll) or when a tab
 * is explicitly closed.
 */

/** One browser tab. `id` is renderer-local; `browserId` is the main-process
 *  view id. All navigation/loading/pick state is per-tab. */
interface BrowserTab {
  id: string;
  browserId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  pickMode: boolean;
  /** Device emulation preset (desktop = full width, mobile = narrow + centered). */
  device: BrowserDevicePreset;
}

/** Emulated viewport widths for mobile presets. The view's bounds are narrowed
 *  to this width and centered in the stage so the page renders at phone size. */
const DEVICE_WIDTH: Record<BrowserDevicePreset, number | null> = {
  desktop: null, // full stage width
  iphone: 390,
  android: 412,
};

/** Generate a renderer-local tab id (distinct from the main-process browserId). */
function newTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function BrowserPanel() {
  const open = useSessionStore((s) => s.browserPanelOpen);
  const setOpen = useSessionStore((s) => s.setBrowserPanelOpen);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const enqueueChatElement = useSessionStore((s) => s.enqueueChatElement);
  const setBrowserTabCount = useSessionStore((s) => s.setBrowserTabCount);

  /** All open tabs. Each owns a main-process WebContentsView (by browserId). */
  const [tabs, setTabs] = useState<BrowserTab[]>([]);

  // Sync the tab count to the store so the Titlebar toggle button can show a
  // badge with the current number of open browser tabs.
  useEffect(() => {
    setBrowserTabCount(tabs.length);
  }, [tabs.length, setBrowserTabCount]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Ephemeral confirmation card when an element is picked (shows what was
   *  captured + staged in the bar below). */
  const [pickFlash, setPickFlash] = useState(0);
  /** Picked elements shown in the bottom picked-elements bar (visual feedback
   *  only - the elements are also enqueued to the composer via the store).
   *  Cleared when the panel closes so each browser session starts fresh. */
  const [pickedItems, setPickedItems] = useState<PickedElement[]>([]);
  /** The most recently picked element, shown as a brief floating preview card
   *  that animates in then fades out (the "浮窗预览" feedback). */
  const [flashPreview, setFlashPreview] = useState<PickedElement | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  /** Latest bounds sent to main, so re-showing the active tab can re-sync. */
  const lastBoundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Ref mirror of tabs/activeTabId so async callbacks read fresh values. */
  const tabsRef = useRef<BrowserTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  /** Ref mirror of pickedItems so handleAddPicked reads the fresh list. */
  const pickedItemsRef = useRef<PickedElement[]>([]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  useEffect(() => {
    pickedItemsRef.current = pickedItems;
  }, [pickedItems]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  /** Resolve the active project's path (needed for browser.create). */
  const projectPath = activeProjectId
    ? projects.find((p) => p.id === activeProjectId)?.path ?? null
    : null;

  /** Helper: update a single tab's fields by browserId. */
  const patchTab = useCallback((browserId: string, patch: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((t) => (t.browserId === browserId ? { ...t, ...patch } : t)));
  }, []);

  /** Send the placeholder div's window-relative rect to main for the active
   *  tab's view. When a mobile device preset is active, the view is narrowed
   *  to the device's emulated width and centered horizontally in the stage
   *  (so the page renders at phone size with empty space on both sides).
   *  rAF-throttled by callers. Background tabs are visible:false in main, so
   *  their setBounds is a no-op - only the active view moves. */
  const syncBounds = useCallback(() => {
    const id = activeTabIdRef.current;
    const tab = tabsRef.current.find((t) => t.id === id);
    const stage = stageRef.current;
    if (!tab || !stage) return;
    const r = stage.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    // For mobile presets, narrow the view to the device width and center it.
    const devW = DEVICE_WIDTH[tab.device];
    const viewW = devW != null ? Math.min(devW, r.width) : r.width;
    const viewX = devW != null ? Math.round(r.left + (r.width - viewW) / 2) : Math.round(r.left);
    const bounds = { x: viewX, y: Math.round(r.top), w: Math.round(viewW), h: Math.round(r.height) };
    const prev = lastBoundsRef.current;
    if (prev && prev.x === bounds.x && prev.y === bounds.y && prev.w === bounds.w && prev.h === bounds.h) return;
    lastBoundsRef.current = bounds;
    void api.browser.setBounds({
      browserId: tab.browserId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
    });
  }, []);

  /** Create a new browser view (main) + a new tab entry, hide the old active
   *  tab's view, show the new one, and focus it. Returns the new tab or null. */
  const createTab = useCallback(async (): Promise<BrowserTab | null> => {
    if (!projectPath) {
      setError("请先选择一个项目");
      return null;
    }
    const res = await api.browser.create({ projectPath });
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    const browserId = res.browserId;
    const tab: BrowserTab = {
      id: newTabId(),
      browserId,
      url: "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pickMode: false,
      device: "desktop",
    };
    // Load a blank start page.
    void api.browser.loadUrl({ browserId, url: "about:blank" });
    // Hide the previously active tab's view, then show the new one.
    const prevId = activeTabIdRef.current;
    const prevTab = prevId ? tabsRef.current.find((t) => t.id === prevId) : null;
    if (prevTab) {
      // Turn off pick mode on the outgoing tab (picker doesn't cross tabs).
      if (prevTab.pickMode) {
        void api.browser.setPickMode({ browserId: prevTab.browserId, enabled: false });
      }
      void api.browser.hide({ browserId: prevTab.browserId });
    }
    void api.browser.show({ browserId });
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    setError(null);
    requestAnimationFrame(syncBounds);
    return tab;
  }, [projectPath, syncBounds]);

  // First open: create the initial tab (only when open && no tabs yet).
  useEffect(() => {
    if (!open) return;
    if (tabsRef.current.length > 0) return; // already have tabs
    void createTab();
  }, [open, createTab]);

  // Show/hide the active tab's view when the panel opens/closes. Closing the
  // panel hides the view WITHOUT destroying it (preserves browsing state);
  // reopening shows it again.
  useEffect(() => {
    if (!open) {
      // Panel closing: hide the active tab's view.
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (tab) {
        if (tab.pickMode) {
          void api.browser.setPickMode({ browserId: tab.browserId, enabled: false });
          patchTab(tab.browserId, { pickMode: false });
        }
        void api.browser.hide({ browserId: tab.browserId });
      }
      return;
    }
    // Panel opening with existing tabs: re-show the active view + sync bounds.
    if (tabsRef.current.length === 0) return; // first-open tab creation handled above
    const tab = activeTabIdRef.current
      ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      : null;
    if (tab) {
      void api.browser.show({ browserId: tab.browserId });
      requestAnimationFrame(syncBounds);
    }
  }, [open, patchTab, syncBounds]);

  // ResizeObserver -> syncBounds (rAF-throttled inside).
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(syncBounds);
    });
    ro.observe(stage);
    // Also sync on window resize (a window move changes the screen-coord rect
    // without a size change that ResizeObserver would catch).
    const onWinResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(syncBounds);
    };
    window.addEventListener("resize", onWinResize);
    raf = requestAnimationFrame(syncBounds);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
    };
  }, [open, syncBounds]);

  // Subscribe to browser:event pushes. Route each event to the owning tab by
  // browserId and update that tab's state only.
  useEffect(() => {
    if (!open) return;
    const unsub = api.on.browserEvent((msg) => {
      const tab = tabsRef.current.find((t) => t.browserId === msg.browserId);
      if (!tab) return; // not one of our tabs (e.g. stale view)
      if (msg.type === "navigation") {
        const p = msg.payload as { url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean };
        patchTab(msg.browserId, {
          ...(typeof p.url === "string" ? { url: p.url } : {}),
          ...(typeof p.title === "string" ? { title: p.title } : {}),
          ...(typeof p.canGoBack === "boolean" ? { canGoBack: p.canGoBack } : {}),
          ...(typeof p.canGoForward === "boolean" ? { canGoForward: p.canGoForward } : {}),
        });
      } else if (msg.type === "loading") {
        const p = msg.payload as { isLoading?: boolean };
        if (typeof p.isLoading === "boolean") patchTab(msg.browserId, { loading: p.isLoading });
      } else if (msg.type === "pickResult") {
        const el = msg.payload as PickedElement;
        if (el && typeof el.selector === "string") {
          // Stage the element in the picked-items bar - do NOT enqueue to the
          // composer yet. The user reviews the staged list and clicks "添加"
          // to flush all staged elements at once (handleAddPicked).
          setPickedItems((prev) => [...prev, el]);
          setFlashPreview(el);
          setPickFlash((n) => n + 1);
        }
      }
    });
    return unsub;
  }, [open, enqueueChatElement, patchTab]);

  // Clear the pick flash + floating preview after a moment.
  useEffect(() => {
    if (pickFlash === 0) return;
    const t = setTimeout(() => {
      setPickFlash(0);
      setFlashPreview(null);
    }, 1800);
    return () => clearTimeout(t);
  }, [pickFlash]);

  /** Remove a picked item from the staging bar (by index). Since elements are
   *  staged (not yet enqueued), this simply drops it from the list. */
  const handleRemovePicked = useCallback((index: number) => {
    setPickedItems((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const handleClearPicked = useCallback(() => setPickedItems([]), []);

  /** Flush all staged elements to the composer (enqueue each one) and return
   *  to the main workspace. This is the commit action for the staging bar:
   *  elements picked in the browser are only added to the input box when the
   *  user clicks "添加". */
  const handleAddPicked = useCallback(() => {
    // Read from the ref to avoid stale-closure issues if multiple adds race.
    const items = pickedItemsRef.current;
    if (items.length === 0) {
      setOpen(false);
      return;
    }
    for (const el of items) {
      enqueueChatElement(el);
    }
    setPickedItems([]);
    setOpen(false);
  }, [enqueueChatElement, setOpen]);

  /** Normalize a typed string into a URL (add https:// if it lacks a scheme). */
  const normalizeUrl = (input: string): string => {
    const s = input.trim();
    if (!s) return "about:blank";
    if (s === "about:blank") return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (!/\s/.test(s) && /\.[a-z]{2,}/i.test(s)) return `https://${s}`;
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  };

  const handleNavigate = useCallback(
    (raw: string) => {
      if (!activeTab) return;
      const u = normalizeUrl(raw);
      patchTab(activeTab.browserId, { url: u });
      void api.browser.loadUrl({ browserId: activeTab.browserId, url: u });
    },
    [activeTab, patchTab],
  );

  const handleBack = useCallback(() => {
    if (activeTab) void api.browser.goBack({ browserId: activeTab.browserId });
  }, [activeTab]);
  const handleForward = useCallback(() => {
    if (activeTab) void api.browser.goForward({ browserId: activeTab.browserId });
  }, [activeTab]);
  const handleReload = useCallback(() => {
    if (activeTab) void api.browser.reload({ browserId: activeTab.browserId });
  }, [activeTab]);

  const handleTogglePickMode = useCallback(() => {
    if (!activeTab) return;
    const next = !activeTab.pickMode;
    void api.browser.setPickMode({ browserId: activeTab.browserId, enabled: next }).then((res) => {
      if (res.ok) patchTab(activeTab.browserId, { pickMode: next });
    });
  }, [activeTab, patchTab]);

  /** Switch the active tab's device emulation preset. The main process applies
   *  Chromium device emulation (mobile viewport + touch + UA); the renderer
   *  narrows the view's bounds to the device width and centers it. The bounds
   *  re-sync happens on the next animation frame. */
  const handleDeviceChange = useCallback(
    (device: BrowserDevicePreset) => {
      if (!activeTab || activeTab.device === device) return;
      void api.browser.setDevice({ browserId: activeTab.browserId, device }).then((res) => {
        if (!res.ok) return;
        patchTab(activeTab.browserId, { device });
        // Force a bounds re-sync: the dedupe check in syncBounds compares
        // against lastBoundsRef, so we must clear it to let the new (narrower
        // or wider) rect through.
        lastBoundsRef.current = null;
        requestAnimationFrame(syncBounds);
      });
    },
    [activeTab, patchTab, syncBounds],
  );

  /** Select a tab: hide the old active view, show the new one. */
  const handleSelectTab = useCallback(
    (id: string) => {
      if (id === activeTabIdRef.current) return;
      const oldTab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      const newTab = tabsRef.current.find((t) => t.id === id);
      if (!newTab) return;
      // Turn off pick mode on the outgoing tab (picker doesn't cross tabs).
      if (oldTab && oldTab.pickMode) {
        void api.browser.setPickMode({ browserId: oldTab.browserId, enabled: false });
        patchTab(oldTab.browserId, { pickMode: false });
      }
      if (oldTab) void api.browser.hide({ browserId: oldTab.browserId });
      void api.browser.show({ browserId: newTab.browserId });
      setActiveTabId(id);
      requestAnimationFrame(syncBounds);
    },
    [patchTab, syncBounds],
  );

  /** Close a tab: destroy its view, remove it, and activate a neighbor. If it
   *  was the last tab, close the whole panel. */
  const handleCloseTab = useCallback(
    (id: string) => {
      const idx = tabsRef.current.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const closing = tabsRef.current[idx];
      void api.browser.close({ browserId: closing.browserId });
      const remaining = tabsRef.current.filter((t) => t.id !== id);
      setTabs(remaining);
      if (remaining.length === 0) {
        // Last tab closed -> close the panel.
        setActiveTabId(null);
        lastBoundsRef.current = null;
        setOpen(false);
        return;
      }
      // If we closed the active tab, activate the neighbor (previous, or the
      // new last if we closed the last tab). Otherwise keep the current active.
      if (id === activeTabIdRef.current) {
        const nextTab = remaining[Math.min(idx, remaining.length - 1)];
        setActiveTabId(nextTab.id);
        void api.browser.show({ browserId: nextTab.browserId });
        requestAnimationFrame(syncBounds);
      }
    },
    [setOpen, syncBounds],
  );

  /** New tab button: create a fresh tab and focus it. */
  const handleNewTab = useCallback(() => {
    void createTab();
  }, [createTab]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  if (!open) return null;

  // Tabs for display (strip browserId - the tab strip doesn't need it).
  const displayTabs: BrowserTabDisplay[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    loading: t.loading,
  }));

  return (
    <div className="fixed inset-x-0 top-10 bottom-0 z-40 flex flex-col bg-surface">
      <BrowserTabs
        tabs={displayTabs}
        activeTabId={activeTabId}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
      />
      <BrowserToolbar
        url={activeTab?.url ?? ""}
        loading={activeTab?.loading ?? false}
        canGoBack={activeTab?.canGoBack ?? false}
        canGoForward={activeTab?.canGoForward ?? false}
        pickMode={activeTab?.pickMode ?? false}
        device={activeTab?.device ?? "desktop"}
        onUrlChange={(u) => activeTab && patchTab(activeTab.browserId, { url: u })}
        onNavigate={handleNavigate}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onTogglePickMode={handleTogglePickMode}
        onDeviceChange={handleDeviceChange}
        onClose={handleClose}
      />
      {/* The stage is the measurement target for the active tab's
          WebContentsView. The view floats above it at OS level, so this div
          stays visually empty - its only job is to occupy the right rect. */}
      <div ref={stageRef} className="relative min-h-0 flex-1 bg-surface">
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-content-muted">{error}</p>
          </div>
        )}
        {activeTab?.pickMode && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-accent/90 px-3 py-1 text-[11px] font-medium text-white shadow">
            点击页面元素以添加到输入框 · 按 Esc 退出
          </div>
        )}
        {/* Floating preview card: appears briefly on each pick, showing the
            just-picked element's selector + preview so the user gets immediate
            visual confirmation of WHAT was added (not just that something was).
            Animates in (scale-up + fade) then fades out when pickFlash clears. */}
        {flashPreview && (
          <div
            className={cn(
              "pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2",
              "flex items-center gap-2 rounded-lg border border-green-500/40 bg-green-600/95 px-3 py-2 text-white shadow-xl",
              "transition-all duration-300",
              pickFlash > 0 ? "scale-100 opacity-100" : "scale-95 opacity-0",
            )}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/25 text-[11px]">✓</span>
            <div className="min-w-0">
              <div className="text-[11px] font-medium leading-tight">已拾取到列表</div>
              <div className="max-w-[240px] truncate text-[10px] leading-tight text-white/80">
                {flashPreview.preview || flashPreview.selector}
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Picked-elements bar: a Chrome-download-bar-style strip showing all
          elements picked in this browser session. Gives persistent feedback
          (count + what was picked) that survives beyond the brief flash card.
          Auto-hides when empty. */}
      <PickedElementsBar items={pickedItems} onRemove={handleRemovePicked} onClear={handleClearPicked} onAdd={handleAddPicked} />
    </div>
  );
}
