/** Process environment helpers. */
export const is = {
  get dev() {
    return !!process.env["ELECTRON_RENDERER_URL"];
  },
  get prod() {
    return !this.dev;
  },
};

/** Generate a short unique id (good enough for client-side session/message ids). */
export function uid(prefix = ""): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}${time}${rand}`;
}
