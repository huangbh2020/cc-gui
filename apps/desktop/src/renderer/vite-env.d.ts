/// <reference types="vite/client" />

/**
 * Type declarations for Vite's `?worker` import suffix, used by the Monaco
 * bootstrap (monacoSetup.ts) to instantiate editor/language web workers from
 * bundled modules. Without this, tsc treats `"...worker?worker"` as an
 * unresolvable module.
 *
 * Vite's own `vite/client` types declare `*?worker` generically, but only
 * when the `vite/client` reference is present in a file tsc reads. This file
 * ensures that reference is always loaded for the renderer source tree.
 */
declare module "*?worker" {
  const workerConstructor: {
    new (options?: { name?: string }): Worker;
  };
  export default workerConstructor;
}
