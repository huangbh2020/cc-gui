import { useState } from "react";

type Tab = "files" | "git" | "terminal" | "browser";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "files", label: "Files", icon: "📁" },
  { id: "git", label: "Git", icon: "⎇" },
  { id: "terminal", label: "Terminal", icon: "▸_" },
  { id: "browser", label: "Browser", icon: "🌐" },
];

/** Right panel: tabbed inspector for files / git / terminal / browser.
 * P0 ships the tab chrome with empty bodies; P4 implements each. */
export function RightPanel() {
  const [tab, setTab] = useState<Tab>("files");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-pane-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-2 py-2 text-[11px] font-medium uppercase tracking-wide transition-colors ${
              tab === t.id
                ? "border-b-2 border-emerald-500 text-zinc-200"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <span className="mr-1">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs text-zinc-600">
        {tab === "files" && <p>File tree appears here (P4).</p>}
        {tab === "git" && <p>Git status &amp; diff appear here (P4).</p>}
        {tab === "terminal" && <p>Embedded terminal appears here (P4).</p>}
        {tab === "browser" && <p>Browser preview appears here (P5).</p>}
      </div>
    </div>
  );
}
