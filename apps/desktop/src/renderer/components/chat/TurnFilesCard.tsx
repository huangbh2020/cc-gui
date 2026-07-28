import { useEffect, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { lineDiff } from "@renderer/lib/lineDiff.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button } from "@renderer/components/ui/index.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconFile,
  IconLoader2,
  IconPlus,
  IconEdit,
} from "@renderer/lib/icons.js";
import { DiffView } from "./DiffView.js";

/**
 * "本轮修改" card — rendered INLINE in the message stream as a per-turn
 * trailing `kind: "turn-files"` block. Each turn that touched files keeps its
 * own card frozen in history (new turns add new cards; old cards stay as
 * read-only snapshots and are never deleted). On session reopen every
 * historical card is restored from the persisted message snapshot.
 *
 * Two expand levels:
 *  1. Card folded → "本轮修改了 N 个文件  +总A -总D". Expand to see the rows.
 *  2. Per-file row → path + `+a -d` + a placeholder "审查" button. Expand the
 *     row to see that file's full line diff (computed on demand: read the
 *     current on-disk content via `api.file.readFile` and diff against the
 *     snapshotted `before`).
 *
 * Rewind: only the LATEST turn's card (`isLatestTurn === true`) renders the
 * 撤销本轮 button — it restores files via the in-memory FileSnapshot (cleared
 * per turn, so only the most recent turn is rewindable). Older cards are
 * display-only; their rewind button is hidden. The rewind action is pulled
 * from the store directly (the card is the sole consumer), keeping the block
 * rendering path prop-free.
 *
 * Theme: neutral surface/edge tokens (no accent) — these are *completed*
 * file ops, not pending approvals. The +/- tallies keep accent/danger for
 * semantic color (green=added, red=deleted).
 */
export function TurnFilesCard({
  files,
  isLatestTurn,
}: {
  files: TurnFileEntry[];
  /** True only on the latest turn's card — gates the 撤销本轮 button.
   *  Undefined/false on historical cards (read-only snapshots). */
  isLatestTurn?: boolean;
}) {
  // Default expand state by lifecycle: the latest turn expands so the user
  // sees the fresh changes + rewind affordance; historical cards collapse to
  // a one-line summary (keeps the scroll-back history calm).
  const [open, setOpen] = useState(!!isLatestTurn);
  // rewindTurn comes from the store — only invoked when isLatestTurn, so the
  // historical cards never trigger it.
  const rewindTurn = useSessionStore((s) => s.rewindTurn);
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
      await rewindTurn();
      setDone(true);
    } finally {
      setRewinding(false);
    }
  };

  // Group by kind for a compact summary line: "本轮修改了 N 个文件
  // (创建 X · 修改 Y)".
  const created = files.filter((f) => f.kind === "created").length;
  const modified = files.length - created;
  // Aggregate tallies across all files for the folded badge.
  const totals = useMemo(
    () => files.reduce((acc, f) => ({ adds: acc.adds + f.adds, dels: acc.dels + f.dels }), { adds: 0, dels: 0 }),
    [files],
  );

  return (
    <div className="rounded-xl border border-edge bg-surface-muted/40 px-3 py-2 text-xs text-content-muted backdrop-blur">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <IconFile size={14} className="shrink-0 text-content-subtle" />
        <span className="font-semibold text-content-muted">
          本轮修改了 {files.length} 个文件
        </span>
        <span className="text-content-subtle">
          ({created > 0 ? `创建 ${created}` : ""}
          {created > 0 && modified > 0 ? " · " : ""}
          {modified > 0 ? `修改 ${modified}` : ""})
        </span>
        {/* Aggregate change tallies — the headline number reviewers care about. */}
        <span className="ml-2 inline-flex items-center gap-1 rounded bg-surface/60 px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          <span className="text-accent">+{totals.adds}</span>
          <span className="text-danger">-{totals.dels}</span>
        </span>
        <span className="ml-auto text-content-subtle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1 border-t border-edge pt-2">
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
            {/* Only the LATEST turn is rewindable (in-memory FileSnapshot is
                cleared per turn). Historical cards render read-only — the
                rewind button is hidden, leaving just 收起. */}
            {isLatestTurn && (
              <button
                onClick={handleRewind}
                disabled={rewinding || done}
                className="rounded-md bg-surface-hover px-3 py-1 font-medium text-content transition-colors hover:bg-edge disabled:cursor-not-allowed disabled:text-content-subtle"
                title="把本轮所有文件恢复为轮开始前的状态"
              >
                {done ? "已撤销 ✓" : rewinding ? "撤销中…" : "撤销本轮"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One row in the file list. Collapsed: path + per-file tallies + 审查 button +
 *  expand arrow. Expanded: the full line diff (loaded on demand). */
function FileRow({ entry }: { entry: TurnFileEntry }) {
  const [expanded, setExpanded] = useState(false);
  const isCreated = entry.kind === "created";

  return (
    <div className="rounded-md bg-surface/40">
      <div className="flex items-center gap-2 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? "收起 diff" : "展开 diff"}
        >
          <span className="shrink-0 text-content-subtle">
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </span>
          <span aria-hidden title={isCreated ? "本轮新建" : "本轮修改"} className="shrink-0 text-content-subtle">
            {isCreated ? <IconPlus size={12} /> : <IconEdit size={12} />}
          </span>
          <span className="truncate font-mono text-[11px]" title={entry.filePath}>
            {entry.filePath}
          </span>
        </button>
        {/* Per-file change tallies. */}
        <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
          {entry.adds > 0 && <span className="text-accent">+{entry.adds}</span>}
          {entry.dels > 0 && <span className="text-danger">-{entry.dels}</span>}
          {entry.adds === 0 && entry.dels === 0 && (
            <span className="text-content-subtle">无变化</span>
          )}
        </span>
        {/* Placeholder review button — P4 will wire this to a review flow.
            For now it just logs so the click is observable without effect. */}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1 px-1.5"
          title="审查(P4)"
          onClick={() => console.log("[review] (placeholder)", entry.filePath)}
        >
          <IconEye size={11} />
          审查
        </Button>
      </div>
      {expanded && <FileDiff entry={entry} />}
    </div>
  );
}

/** Lazy-loaded per-file diff. Reads the current on-disk content on mount and
 *  diffs it against the snapshotted `before`. Loading shows a spinner; a read
 *  failure (file gone / binary) shows the before-only diff gracefully. */
function FileDiff({ entry }: { entry: TurnFileEntry }) {
  // Read the post-turn content once on mount. The component unmounts on
  // collapse (parent drops it), so a re-expand re-reads — which is what we
  // want (the file may have changed again in the meantime).
  const [state, setState] = useState<"loading" | "ready">("loading");
  const [after, setAfter] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    api.file
      .readFile({ filePath: entry.filePath })
      .then(({ content }) => {
        if (cancelled) return;
        setAfter(content);
        setState("ready");
      })
      .catch(() => {
        // readFile degrades to "" on failure in main, but defend here too.
        if (cancelled) return;
        setAfter("");
        setState("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [entry.filePath]);

  if (state === "loading") {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        读取改动…
      </div>
    );
  }

  const diff = lineDiff(entry.before, after);
  return (
    <div className="px-1.5 pb-1.5">
      <DiffView diff={diff} />
    </div>
  );
}
