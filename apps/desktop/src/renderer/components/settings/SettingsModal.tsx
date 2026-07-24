import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { CLAUDE_PATH_SETTING_KEY } from "@contracts/ipc";

/** Setting key constant — shared with main via @contracts, so the string never
 * drifts between the resolver/handler and this modal. */
type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; version: string }
  | { status: "fail"; error: string };

/**
 * Modal for configuring the claude CLI path. Controlled by `settingsOpen` in
 * the session store (opened from the TopBar ⚙ button or the CLI-missing CTA).
 *
 * The path is validated live via the "Test" button, which spawns
 * `claude --version` in the main process. On Save we persist the setting and
 * re-probe health so the status bar updates immediately.
 */
export function SettingsModal() {
  const open = useSessionStore((s) => s.settingsOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const refreshClaudeHealth = useSessionStore((s) => s.refreshClaudeHealth);

  const [path, setPath] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  /** Tracks the path value when it was last tested, so a stale "ok" doesn't
   * mislead after the user edits the input. */
  const testedPathRef = useRef<string | null>(null);

  // Load the current setting whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setTest({ status: "idle" });
    testedPathRef.current = null;
    void (async () => {
      const { value } = await api.setting.get({ key: CLAUDE_PATH_SETTING_KEY });
      setPath(value ?? "");
    })();
  }, [open]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setSettingsOpen]);

  if (!open) return null;

  const browse = async () => {
    const { path: picked } = await api.pickFile();
    if (picked) {
      setPath(picked);
      setTest({ status: "idle" });
    }
  };

  const runTest = async () => {
    if (!path.trim()) {
      setTest({ status: "fail", error: "Enter a path first." });
      return;
    }
    setTest({ status: "testing" });
    try {
      const result = await api.testClaudePath({ path: path.trim() });
      if (result.ok) {
        testedPathRef.current = path.trim();
        setTest({ status: "ok", version: result.version ?? "unknown version" });
      } else {
        setTest({ status: "fail", error: result.error ?? "Unknown error" });
      }
    } catch (err) {
      setTest({ status: "fail", error: (err as Error).message });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.setting.set({ key: CLAUDE_PATH_SETTING_KEY, value: path.trim() });
      // Persisting the claude path invalidates the resolver's cache on the main
      // side; re-probe so the status bar reflects the new state right away.
      await refreshClaudeHealth();
      setSettingsOpen(false);
    } finally {
      setSaving(false);
    }
  };

  // If the user edited the field after a successful test, the result is stale.
  const testStale = testedPathRef.current !== null && testedPathRef.current !== path.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => setSettingsOpen(false)}
    >
      <div
        className="w-[520px] max-w-[90vw] rounded-lg border border-pane-border bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-pane-border px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-300">Claude CLI path</span>
            <p className="mb-2 text-[11px] leading-relaxed text-zinc-500">
              Path to the claude executable (e.g. <code className="text-zinc-400">claude.cmd</code>,{" "}
              <code className="text-zinc-400">claude.exe</code>, or{" "}
              <code className="text-zinc-400">cli-wrapper.cjs</code>). Leave blank to auto-detect.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setTest({ status: "idle" });
                }}
                placeholder="C:\Users\you\.local\bin\claude.exe"
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
                spellCheck={false}
              />
              <button
                onClick={() => void browse()}
                className="shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                Browse…
              </button>
            </div>
          </label>

          <div className="flex items-center gap-3">
            <button
              onClick={() => void runTest()}
              disabled={test.status === "testing"}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {test.status === "testing" ? "Testing…" : "Test"}
            </button>

            {test.status === "ok" && (
              <span className={`text-xs ${testStale ? "text-zinc-500" : "text-emerald-400"}`}>
                {testStale ? "(stale — retest after editing) " : "✓ "}
                {test.version}
              </span>
            )}
            {test.status === "fail" && <span className="text-xs text-red-400">✗ {test.error}</span>}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-pane-border px-5 py-3">
          <button
            onClick={() => setSettingsOpen(false)}
            className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
