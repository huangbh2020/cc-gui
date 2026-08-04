/**
 * DOM element-picker scripts, injected into the browser view's page main world
 * via `webContents.executeJavaScript()` when the user toggles pick mode.
 *
 * These are string constants (NOT modules) because executeJavaScript runs the
 * source in the page's own context - it has no access to our process's module
 * scope. The IIFE pattern keeps the injected state self-contained and removable.
 *
 * Security: the injected code is read-only w.r.t. the page - it only attaches
 * non-capturing listeners + a highlight overlay, reads element data on click,
 * and forwards it through `window.mcodeBridge.pickElement` (exposed by the
 * browserPicker preload). It never modifies page DOM beyond its own overlay,
 * and it never touches Node/Electron APIs.
 */

/** Cap the outerHTML we forward so a giant subtree can't blow up the prompt. */
const PICKER_HTML_CAP = 2000;

/**
 * Inject the picker: hover to highlight, click to pick (multi-select - stays
 * active until removed), Esc to exit. Each click forwards the element's
 * selector + outerHTML + url to main via `window.mcodeBridge.pickElement`.
 */
export const PICKER_INJECT_SCRIPT = `
(function () {
  if (window.__mcodePickerActive) return;
  window.__mcodePickerActive = true;

  var cap = ${PICKER_HTML_CAP};

  // Highlight overlay - a fixed, pointer-events:none box that follows the
  // hovered element. Appended to <body> (or <html> if body isn't ready).
  var overlay = document.createElement('div');
  overlay.id = '__mcode-picker-overlay';
  overlay.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;' +
    'border:2px solid #4f8cff;background:rgba(79,140,255,0.12);' +
    'transition:all 0.05s ease-out;display:none;' +
    'box-shadow:0 0 0 9999px rgba(0,0,0,0.05);';
  (document.body || document.documentElement).appendChild(overlay);

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function showOverlay(el) {
    var p = rectOf(el);
    overlay.style.left = p.left + 'px';
    overlay.style.top = p.top + 'px';
    overlay.style.width = p.width + 'px';
    overlay.style.height = p.height + 'px';
    overlay.style.display = 'block';
  }
  function hideOverlay() { overlay.style.display = 'none'; }

  // Generate a stable CSS selector for the element: prefer id, then a
  // class chain, falling back to nth-child path. Best-effort - the goal is
  // a human-readable selector the model can reason about, not uniqueness
  // under all transformations.
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + CSS.escape(node.id); parts.unshift(part); break; }
      var classes = Array.from(node.classList).filter(Boolean);
      if (classes.length) part += '.' + classes.map(function (c) { return CSS.escape(c); }).join('.');
      // Add nth-child only when siblings of the same tag exist, to keep it short.
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.from(parent.children).filter(function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) {
          var idx = sameTag.indexOf(node) + 1;
          part += ':nth-child(' + idx + ')';
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 5) break; // cap depth
    }
    return parts.join(' > ');
  }

  function previewFor(el, selector) {
    var tag = el.tagName.toLowerCase();
    var idCls = '';
    if (el.id) idCls = '#' + el.id;
    else if (el.className && typeof el.className === 'string' && el.className.trim()) {
      idCls = '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
    }
    return (selector || (tag + idCls)).slice(0, 40);
  }

  function onOver(e) {
    var el = e.target;
    if (!el || el === overlay || el.id === '__mcode-picker-overlay') return;
    if (el === document.documentElement || el === document.body) { hideOverlay(); return; }
    showOverlay(el);
  }
  function onMove(e) { onOver(e); }
  function onClick(e) {
    var el = e.target;
    if (!el || el === overlay) return;
    if (el === document.documentElement || el === document.body) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var selector = buildSelector(el);
    var html = el.outerHTML || '';
    if (html.length > cap) html = html.slice(0, cap) + '\\u2026';
    var data = {
      selector: selector,
      outerHTML: html,
      url: location.href,
      preview: previewFor(el, selector),
    };
    try {
      if (!window.mcodeBridge || typeof window.mcodeBridge.pickElement !== 'function') {
        console.error('[mcode-picker] bridge unavailable: window.mcodeBridge is not defined (preload did not load)');
        return;
      }
      window.mcodeBridge.pickElement(data);
    } catch (err) {
      console.error('[mcode-picker] pickElement failed:', err);
    }
    // Brief flash to confirm the pick, then keep the overlay for the next pick.
    overlay.style.borderColor = '#22c55e';
    setTimeout(function () { overlay.style.borderColor = '#4f8cff'; }, 250);
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      window.__mcodePickerRemove && window.__mcodePickerRemove();
    }
  }
  // capture:true so we intercept before the page's own handlers run.
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  window.__mcodePickerRemove = function () {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    window.__mcodePickerActive = false;
    delete window.__mcodePickerRemove;
  };

  // Signal that injection succeeded (used by the manager to confirm state).
  'mcode-picker-injected';
})();
`;

/**
 * Remove the picker: tears down all listeners and the overlay. Safe to run even
 * if the picker was never injected (the guard checks `__mcodePickerRemove`).
 */
export const PICKER_REMOVE_SCRIPT = `
(function () {
  if (window.__mcodePickerRemove) { window.__mcodePickerRemove(); }
  'mcode-picker-removed';
})();
`;
