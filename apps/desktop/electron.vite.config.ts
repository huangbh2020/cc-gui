import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/** Absolute path to the monaco-editor package root. Used to alias the worker
 *  entry imports so Vite's `?worker` resolver finds them on disk regardless
 *  of monaco-editor's package.json `exports` field (whose `./*.js` wildcard
 *  mis-maps the `esm/vs/.../foo.worker.js` paths documented for Vite).
 *
 *  `require.resolve` follows pnpm's symlinks to the real package dir. */
const monacoPkgDir = resolve(
  __dirname,
  "node_modules/monaco-editor",
);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: "src/main/index.ts" },
      rollupOptions: {
        // contracts is a workspace source package — bundle it into main.
        // sql.js (asm.js build) is externalized and required at runtime like
        // electron/zod — its ~6MB asm.js file is too large to inline cleanly.
        // node-pty is a native addon — must load from node_modules at runtime
        // (never bundle the .node binary into the main chunk).
        external: ["electron", "zod", "sql.js", /^sql\.js\//, "node-pty"],
      },
    },
    resolve: {
      alias: {
        "@contracts": resolve("../../packages/contracts/src"),
        "@main": resolve("src/main"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Two preload bundles:
      //  - index: the main window's preload (contextBridge API).
      //  - browserPicker: a minimal preload for the embedded browser
      //    WebContentsView, exposing only `window.mcodeBridge.pickElement`
      //    so the picker script (injected into the page's main world) can
      //    forward clicked elements to main without leaking any Node API.
      lib: { entry: { index: "src/preload/index.ts", browserPicker: "src/preload/browserPicker.ts" } },
      rollupOptions: { external: ["electron"] },
    },
    resolve: {
      alias: {
        "@contracts": resolve("../../packages/contracts/src"),
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      // Standard app mode (NOT lib mode): the renderer is loaded via
      // `window.loadFile()` and runs as a normal web page, so Vite must emit
      // the entry as a hashed ESM asset (`assets/index-xxxx.js`) referenced by
      // an external <script type="module">. lib mode would instead produce a
      // UMD bundle (`desktop.umd.cjs`) that <script type="module"> can't load
      // under file:// (wrong MIME: text/plain) and that violates the prod CSP.
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") },
      },
    },
    resolve: {
      alias: {
        "@contracts": resolve("../../packages/contracts/src"),
        "@renderer": resolve("src/renderer"),
        // Monaco worker entries — alias the documented `esm/vs/...` import
        // paths straight to the on-disk files. Without this, monaco-editor's
        // `exports` wildcard re-maps them to a non-existent doubled path and
        // Vite's `?worker` resolver fails. The alias is path-prefix based, so
        // every worker import (`monaco-editor/esm/vs/.../x.worker?worker`)
        // lands at `${monacoPkgDir}/esm/vs/.../x.worker`.
        "monaco-editor/esm/vs": resolve(monacoPkgDir, "esm/vs"),
      },
    },
    // monaco-editor must be EXCLUDED from the dep optimizer: its worker
    // entries (`?worker` imports in monacoSetup.ts) can't be pre-bundled, and
    // including the package makes Vite route those imports into the (empty)
    // .vite/deps cache. Excluding lets the `?worker` imports flow through the
    // normal worker pipeline. The alias above still points them at the real
    // on-disk files.
    optimizeDeps: {
      exclude: ["monaco-editor"],
    },
    plugins: [
      react({
        babel: {
          plugins: [["babel-plugin-react-compiler", {}]],
        },
      }),
    ],
    worker: {
      // Monaco's workers are plain ESM modules; build them as ESM too so the
      // `?worker` imports resolve cleanly under Vite's worker pipeline.
      format: "es",
    },
  },
});
