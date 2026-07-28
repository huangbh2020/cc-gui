import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: "src/main/index.ts" },
      rollupOptions: {
        // contracts is a workspace source package — bundle it into main.
        // sql.js (asm.js build) is externalized and required at runtime like
        // electron/zod — its ~6MB asm.js file is too large to inline cleanly.
        external: ["electron", "zod", "sql.js", /^sql\.js\//],
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
      },
    },
    plugins: [
      react({
        babel: {
          plugins: [["babel-plugin-react-compiler", {}]],
        },
      }),
    ],
  },
});
