import { useEffect, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { DISPLAY_MODE_SETTING_KEY, type DisplayMode } from "@contracts/ipc";

/** Settings panel: how the center pane renders when a session is active.
 *
 *  - "single" (default): clicking a thread in the left bar replaces the
 *    center pane content (legacy behavior, no tab strip).
 *  - "tabs": threads accumulate as tabs along the top of the center pane.
 *    Closing a tab leaves any in-flight turn running in the background;
 *    re-opening the thread restores the live state.
 *
 *  The choice is persisted in the `settings` table under
 *  `DISPLAY_MODE_SETTING_KEY` and re-hydrated at app start by `init()`.
 *  Switching modes never drops open tabs — we always write the full
 *  openTabs list regardless of mode, so flipping the switch back and
 *  forth is non-destructive.
 */
export function DisplayModePanel() {
  const displayMode = useSessionStore((s) => s.displayMode);
  const setDisplayMode = useSessionStore((s) => s.setDisplayMode);

  // Track the radio locally so the UI flips immediately, even if the
  // store update is awaiting the IPC persist. `displayMode` is the
  // source of truth; this is just for snappy visual feedback.
  const [pending, setPending] = useState<DisplayMode | null>(null);
  const current = pending ?? displayMode;

  // Reset the local pending state whenever the panel is freshly mounted
  // (SettingsModal unmounts each section on nav switch).
  useEffect(() => {
    setPending(null);
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-content">中间面板显示模式</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-content-subtle">
          控制点击左侧栏线程时,中间聊天区的呈现方式。
        </p>
      </div>

      <div className="space-y-2">
        <RadioCard
          checked={current === "single"}
          title="单会话模式"
          desc="点击左侧栏的线程,中间面板替换为该线程的内容(默认行为)。"
          onSelect={() => {
            setPending("single");
            void setDisplayMode("single");
          }}
        />
        <RadioCard
          checked={current === "tabs"}
          title="Tab 标签模式"
          desc="每个线程以标签形式并排在中间面板顶部,可同时打开多个,切换 tab 互不干扰;关闭 tab 后台 turn 继续运行。"
          onSelect={() => {
            setPending("tabs");
            void setDisplayMode("tabs");
          }}
        />
      </div>
    </div>
  );
}

interface RadioCardProps {
  checked: boolean;
  title: string;
  desc: string;
  onSelect: () => void;
}

function RadioCard({ checked, title, desc, onSelect }: RadioCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
        checked
          ? "border-accent/60 bg-accent/5"
          : "border-edge bg-surface/40 hover:border-edge/80 hover:bg-surface-muted/50"
      }`}
    >
      <span
        className={`mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 transition-colors ${
          checked ? "border-accent bg-accent" : "border-content-subtle/60"
        }`}
      />
      <div className="min-w-0">
        <div className="text-xs font-medium text-content">{title}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-content-subtle">{desc}</div>
      </div>
    </button>
  );
}
