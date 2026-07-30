import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { CLAUDE_PATH_SETTING_KEY } from "@contracts/ipc";

/**
 * Settings panel: the claude CLI executable path.
 *
 * Extracted from the old monolithic SettingsModal so the modal can host it as
 * one pane among several in a left-nav layout. The path is validated live via
 * the "Test" button (spawns `claude --version` in main); on Save we persist and
 * re-probe health so the status bar updates immediately.
 *
 * NOTE: with the Agent SDK the path is largely vestigial (the SDK bundles its
 * own binary), but the field is kept for backward compat / power users.
 */

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; version: string }
  | { status: "fail"; error: string };

export function ClaudePathPanel() {
  const refreshClaudeHealth = useSessionStore((s) => s.refreshClaudeHealth);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  const [path, setPath] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  /** Tracks the path value when it was last tested, so a stale "ok" doesn't
   * mislead after the user edits the input. */
  const testedPathRef = useRef<string | null>(null);

  // Load the current setting on mount (panel is freshly mounted per nav switch).
  useEffect(() => {
    setTest({ status: "idle" });
    testedPathRef.current = null;
    void (async () => {
      const { value } = await api.setting.get({ key: CLAUDE_PATH_SETTING_KEY });
      setPath(value ?? "");
    })();
  }, []);

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
    <div className="space-y-3">
      <div>
        <h3 className="font-semibold text-content">Claude CLI 路径</h3>
        <p className="mt-1 text-[0.7857em] leading-relaxed text-content-subtle">
          指向 claude 可执行文件(如 <code className="text-content-muted">claude.cmd</code>、
          <code className="text-content-muted">claude.exe</code> 或
          <code className="text-content-muted">cli-wrapper.cjs</code>)。留空则自动检测。
        </p>
        <p className="mt-1 text-[0.7857em] leading-relaxed text-content-subtle">
          注:Agent SDK 已自带二进制,此项主要用于高级用户/兼容旧路径。
        </p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setTest({ status: "idle" });
          }}
          placeholder="C:\Users\you\.local\bin\claude.exe"
          className="min-w-0 flex-1 rounded border border-edge bg-surface px-2.5 py-1.5 font-mono text-[0.8571em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
          spellCheck={false}
        />
        <button
          onClick={() => void browse()}
          className="shrink-0 rounded bg-surface-muted px-3 py-1.5 text-[0.8571em] text-content-muted hover:bg-surface-hover"
        >
          浏览…
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void runTest()}
          disabled={test.status === "testing"}
          className="rounded bg-surface-muted px-3 py-1.5 text-[0.8571em] text-content-muted hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {test.status === "testing" ? "测试中…" : "测试"}
        </button>

        {test.status === "ok" && (
          <span className={`text-[0.8571em] ${testStale ? "text-content-subtle" : "text-accent"}`}>
            {testStale ? "(已编辑,请重新测试) " : "✓ "}
            {test.version}
          </span>
        )}
        {test.status === "fail" && <span className="text-[0.8571em] text-danger">✗ {test.error}</span>}
      </div>

      <div className="flex justify-end gap-2 border-t border-edge pt-3">
        <button
          onClick={() => setSettingsOpen(false)}
          className="rounded px-3 py-1.5 text-[0.8571em] text-content-muted hover:bg-surface-muted hover:text-content"
        >
          取消
        </button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="rounded bg-accent px-4 py-1.5 text-[0.8571em] font-medium text-surface hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
