/**
 * Monaco editor bootstrap — runs once at module load, before any <Editor>
 * component mounts.
 *
 * Two concerns handled here, both forced by our packaging constraints:
 *
 * 1. **No CDN.** `@monaco-editor/react`'s default loader fetches the monaco
 *    AMD bundle from jsdelivr. Our production CSP is `script-src 'self'`
 *    (main/index.ts), so that would be blocked. We instead hand the loader
 *    the locally-bundled ESM monaco instance via `loader.config({ monaco })`.
 *    Vite then bundles monaco-editor into the renderer chunk.
 *
 * 2. **Web workers.** Monaco offloads background work (tokenization, diffing,
 *    linkify) to Web Workers. In a bundler context the worker entry must be
 *    produced by the bundler, not fetched at runtime. Vite's `?worker` suffix
 *    instantiates a worker from a module. We map each language id to the
 *    matching worker entry via `self.MonacoEnvironment.getWorker`.
 *
 *    The worker import paths (`monaco-editor/esm/vs/...`) are the form
 *    `@monaco-editor/react`'s README documents for Vite. monaco-editor
 *    0.52+ ships a package.json `exports` field whose `./*.js` wildcard
 *    would mis-map these paths; the `resolve.alias` entries in
 *    electron.vite.config.ts neutralize that by pointing the paths straight
 *    at the on-disk files.
 *
 * Importing this module (anywhere) is enough to apply both settings — the
 * side effects run at import time. `FileEditor.tsx` imports it; nothing else
 * needs to.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// Worker entries — Vite compiles each into a dedicated worker file.
// The `editorWorker` is mandatory (base services); the language workers are
// optional but enable richer highlighting/diagnostics per language.
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Configure the worker factory BEFORE telling the loader about our instance.
// Monaco reads `self.MonacoEnvironment.getWorker` lazily, but setting it up
// first avoids a race on the first model creation.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Hand the loader our bundled instance so it never hits the CDN.
loader.config({ monaco });

export { monaco };
