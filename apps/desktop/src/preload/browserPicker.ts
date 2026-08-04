/**
 * Preload for the embedded browser WebContentsView.
 *
 * This is deliberately far more locked down than the main window's preload: the
 * browser view loads arbitrary remote pages, so it must NOT expose any Node
 * capability. The only bridge is `window.mcodeBridge.pickElement(data)`,
 * invoked by the picker script (injected via `webContents.executeJavaScript`
 * into the page's main world) when the user clicks an element in pick mode.
 *
 * The data flows: page main world -> contextBridge -> this preload ->
 * `ipcRenderer.send` -> BrowserManager -> `sendToRenderer(BROWSER_EVENT)` ->
 * renderer store enqueue -> composer chip. No Node API ever reaches the page.
 *
 * Built as a separate bundle (`out/preload/browserPicker.mjs`) so it can be
 * passed to the WebContentsView's `webPreferences.preload` independently.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mcodeBridge", {
  /** Forward a picked element's data to the main process. The picker script
   *  calls this synchronously on click; main relays it to the renderer as a
   *  `browser:event` / `pickResult` push. */
  pickElement: (data: unknown): void => {
    ipcRenderer.send("__mcode_pick_result__", data);
  },
});
