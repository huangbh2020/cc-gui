import { useState } from "react";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";

/**
 * "本轮文件" card — rendered at the bottom of the message stream after
 * a turn completes. Lists every file Edit/Write touched in that turn
 * and offers a one-click rewind. The actual file *content* diffs are
 * already shown in the per-tool EditToolCard / WriteToolCard inside
 * the stream, so this card is the *entry point + rewind action*, not a
 * diff viewer.
 *
 * Theme: accent (not warning) — these are *completed* file ops, not
 * pending approvals. Visually distinct from ApprovalPrompt (warning)
 * and PlanApprovalPrompt (violet).
 */
export function TurnFilesCard({
  files,
  onRewind,
}: {
  files: TurnFileEntry[];
  onRewind: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  // Local rewind-in-flight flag so the button is disabled while the
  // IPC call is in progress (main also clears the card on its
  // `turn.rewound` event, but that takes a tick after the IPC resolves).
  const [rewinding, setRewinding] = useState(false);
  // Toggle to "撤销成功" briefly after success, so the user gets
  // confirmation before the card disappears (turn.rewound clears
  // turnFiles, unmounting the card).
  const [done, setDone] = useState(false);

  const handleRewind = async () => {
    if (rewinding) return;
    setRewinding(true);
    try {
      await onRewind();
      setDone(true);
    } finally {
      setRewinding(false);
    }
  };

  // Group by kind for a compact summary line: "本轮修改了 N 个文件
  // (创建 X · 修改 Y)".
  const created = files.filter((f) => f.kind === "created").length;
  const modified = files.length - created;

  return (
    <div className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-content-muted backdrop-blur">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span aria-hidden>📝</span>
        <span className="font-semibold text-accent">
          本轮修改了 {files.length} 个文件
        </span>
        <span className="text-content-subtle">
          ({created > 0 ? `创建 ${created}` : ""}
          {created > 0 && modified > 0 ? " · " : ""}
          {modified > 0 ? `修改 ${modified}` : ""})
        </span>
        <span className="ml-auto text-content-subtle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1 border-t border-accent/30 pt-2">
          {files.map((f) => (
            <FileRow key={f.filePath} entry={f} />
          ))}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => setOpen(false)}
              className="rounded-md bg-surface-muted px-2 py-1 text-content-muted transition-colors hover:bg-surface-hover"
            >
              收起
            </button>
            <button
              onClick={handleRewind}
              disabled={rewinding || done}
              className="rounded-md bg-accent px-3 py-1 font-medium text-surface transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle"
              title="把本轮所有文件恢复为轮开始前的状态"
            >
              {done ? "已撤销 ✓" : rewinding ? "撤销中…" : "撤销本轮"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One row in the file list. Path is shown as a fixed-width monospace
 *  string; the cwd-prefix is highlighted in a slightly brighter color
 *  so the project root jumps out. */
function FileRow({ entry }: { entry: TurnFileEntry }) {
  const isCreated = entry.kind === "created";
  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      <span aria-hidden title={isCreated ? "本轮新建" : "本轮修改"}>
        {isCreated ? "🆕" : "✎"}
      </span>
      <span className="truncate" title={entry.filePath}>
        {entry.filePath}
      </span>
    </div>
  );
}
