/** Left bar: project switcher, session list, task list.
 * P0 renders empty-state placeholders; P2 wires to the session store. */
export function LeftBar() {
  return (
    <div className="flex flex-col gap-4 px-2 py-2 text-sm">
      <section>
        <h3 className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Sessions
        </h3>
        <div className="rounded-md border border-dashed border-zinc-800 px-3 py-6 text-center text-xs text-zinc-600">
          No session yet.
          <br />
          <span className="text-zinc-500">Send a message to start.</span>
        </div>
      </section>

      <section>
        <h3 className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Tasks
        </h3>
        <div className="px-1 text-xs text-zinc-600">
          Tasks from claude's TodoWrite will appear here.
        </div>
      </section>
    </div>
  );
}
