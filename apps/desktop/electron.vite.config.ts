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
      lib: { entry: "src/preload/index.ts" },
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
      lib: { entry: "index.html" },
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
