/**
 * Composer skill-command data layer.
 *
 * The `/` menu lists skills discovered from the local filesystem (user-global
 * `~/.claude/skills/` + active-project `.claude/skills/`). The store fetches
 * the list over IPC and caches it; this module provides the type the cache
 * holds and the filter used by the picker.
 *
 * Selecting a skill creates an atomic skill tag (a chip above the textarea,
 * replacing the `/query` trigger token); the user then types their message and
 * sends the turn. The `/name` invocation is injected into the prompt by
 * composePromptWithTags on Send. The SDK is started with `skills: "all"`, so
 * the agent recognizes and runs the skill.
 *
 * This is intentionally separate from the Cmd/Ctrl+K app command palette
 * (`lib/commands.ts`) and from terminal custom commands.
 */
import type { SkillInfo } from "@contracts/ipc";

/** Re-exported so UI code imports the skill shape from one place. */
export type { SkillInfo } from "@contracts/ipc";
export type { SkillSource } from "@contracts/ipc";

/** Case-insensitive match on skill name + description. Empty query = all.
 *  Mirrors the old static filterSlashCommands shape, now over a dynamic list. */
export function filterSkillCommands(query: string, skills: SkillInfo[]): SkillInfo[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) return skills;
  return skills.filter((s) => {
    if (s.name.toLowerCase().includes(q)) return true;
    return s.description.toLowerCase().includes(q);
  });
}
