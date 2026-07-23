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
        external: ["electron", "zod"],
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
    plugins: [react()],
  },
});
