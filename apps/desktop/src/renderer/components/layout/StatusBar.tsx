/** Bottom status bar: model, token usage, claude.exe version, auth state.
 * P0 shows static placeholders; P1 wires live token usage from UsageEvent. */
export function StatusBar() {
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-pane-border bg-zinc-900 px-3 text-[11px] text-zinc-500">
      <span className="text-emerald-500">●</span>
      <span>claude.exe: —</span>
      <span>tokens: 0</span>
      <div className="flex-1" />
      <span>ready</span>
    </footer>
  );
}
