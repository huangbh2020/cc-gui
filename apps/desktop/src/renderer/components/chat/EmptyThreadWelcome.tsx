/**
 * Empty-thread welcome — the centered title shown above the composer on a
 * fresh thread. Kept minimal on purpose: the input box is the visual focus
 * of the home screen, the title just names it.
 *
 * A light fade-up plays once on mount (see `home-fade-up` in styles.css);
 * disabled under prefers-reduced-motion.
 */

export interface EmptyThreadWelcomeProps {
  /** Project display name; empty string degrades the title to "开始新的会话". */
  projectName: string;
}

export function EmptyThreadWelcome({ projectName }: EmptyThreadWelcomeProps) {
  return (
    <div className="mb-4 flex animate-[home-fade-up_160ms_ease-out] justify-center">
      <h2 className="text-2xl font-semibold tracking-tight text-content">
        {projectName ? `在「${projectName}」中开始新的会话` : "开始新的会话"}
      </h2>
    </div>
  );
}
