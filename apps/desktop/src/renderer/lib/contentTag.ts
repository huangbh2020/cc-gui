/**
 * Content-tag model — a pasted chunk that's been promoted from "inline text"
 * to a small chip displayed above the textarea.
 *
 * Why: long pastes (logs, stack traces, file contents) bury the input area
 * and crowd out the visible message stream. Promoting them to tags keeps the
 * composer compact and lets the user click a chip to inspect or remove the
 * payload before sending.
 *
 * State is owned by the composer (ChatPane); it is intentionally not in the
 * Zustand store because it's ephemeral per-turn UI state, not session data.
 */

/** Display char count for a tag's preview text. Single line, whitespace
 *  collapsed; an ellipsis is appended if the original was longer. */
export const TAG_PREVIEW_CHARS = 24;

/** Custom DataTransfer MIME type used by the file-tree → composer drag.
 *  Using a custom type (instead of text/plain) ensures only OUR file nodes
 *  trigger a drop — external text/image drags are ignored by the composer. */
export const FILE_DRAG_MIME = "application/x-file-path";

/** Pasting a single-line shorter than this is left inline in the textarea
 *  (no chip). Anything over this OR a paste with more than
 *  {@link TAG_THRESHOLD_LINES} lines becomes a tag. */
export const TAG_THRESHOLD_CHARS = 200;

/** A paste spanning more than this many lines is promoted to a tag even if
 *  it's short — long logs / stack traces get chipped regardless of char
 *  count. A 2-3 line snippet stays inline so the user isn't interrupted
 *  for ordinary multi-line pastes. */
export const TAG_THRESHOLD_LINES = 3;

/** Source of the tag:
 *  - "paste": bulky clipboard content promoted to a chip.
 *  - "file": a file dragged in from the file tree (path reference only — no
 *    content is read).
 *  - "skill": a skill selected from the `/` menu. Treated as an atomic,
 *    undeletable-in-parts block: it lives as a chip in the composer and as a
 *    standalone card in the message stream. Its `content` is `/name`, sent to
 *    the SDK as a bare line so the agent recognizes the skill invocation. */
export type ContentTagKind = "paste" | "file" | "skill";

/** One content tag. `id` is the React key + removal handle. `content` is the
 *  payload sent verbatim on Send: the full pasted text (paste), an `@path`
 *  reference string (file), or `/name` (skill). `preview` is for chip display.
 *  `filePath` is only set for file tags (the absolute path of the dragged
 *  file). */
export interface ContentTag {
  id: string;
  kind: ContentTagKind;
  preview: string;
  content: string;
  /** Absolute path of the dragged file. Only set when kind === "file". */
  filePath?: string;
}

/** Decide whether a pasted string should become a tag rather than be
 *  inserted into the textarea. Empty / whitespace-only is never a tag.
 *  Promote only when the paste is genuinely bulky: over the char threshold
 *  OR spanning more than the line threshold. Short multi-line snippets
 *  (2-3 lines) stay inline so ordinary pastes aren't interrupted. */
export function shouldPromoteToTag(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > TAG_THRESHOLD_CHARS) return true;
  // Count lines: a string with N newlines has N+1 lines, but a trailing
  // newline (already trimmed away) shouldn't inflate the count.
  const lineCount = t.split("\n").length;
  return lineCount > TAG_THRESHOLD_LINES;
}

/** Build a ContentTag from a raw pasted string. Trims and collapses
 *  whitespace for the preview; the full content is preserved untouched. */
export function makeContentTag(text: string): ContentTag {
  const trimmed = text.trim();
  // Collapse internal whitespace so the preview fits on one chip line and
  // the chip width stays bounded. The full content is kept verbatim — that
  // is what gets sent to the SDK.
  const collapsed = trimmed.replace(/\s+/g, " ");
  const preview =
    collapsed.length > TAG_PREVIEW_CHARS
      ? collapsed.slice(0, TAG_PREVIEW_CHARS) + "…"
      : collapsed;
  return {
    id: cryptoRandomId(),
    kind: "paste",
    preview,
    content: trimmed,
  };
}

/** Build a ContentTag for a file dragged in from the file tree. Unlike paste
 *  tags, a file tag carries only a PATH reference (the agent reads the file
 *  itself via its tools) — no file content is loaded. `preview` is the base
 *  file name; `content` is the `@path` reference injected into the prompt. */
export function makeFileTag(filePath: string): ContentTag {
  // Derive a short display name from the last path segment (handles both /
  // and \ separators for cross-platform paths).
  const segs = filePath.split(/[/\\]/);
  const name = segs[segs.length - 1] || filePath;
  const preview =
    name.length > TAG_PREVIEW_CHARS ? name.slice(0, TAG_PREVIEW_CHARS) + "…" : name;
  return {
    id: cryptoRandomId(),
    kind: "file",
    preview,
    content: `@${filePath}`,
    filePath,
  };
}

/** Build a ContentTag for a skill chosen from the `/` menu. Unlike file/paste
 *  tags a skill carries no payload — its `content` is just `/name`, the form
 *  the SDK recognizes as a skill invocation. `preview` is the skill name. */
export function makeSkillTag(skill: { name: string }): ContentTag {
  return {
    id: cryptoRandomId(),
    kind: "skill",
    preview: skill.name,
    content: `/${skill.name}`,
  };
}

/** Browser-safe UUID. Electron renderer has `crypto.randomUUID()` in secure
 *  contexts; fall back to a Math.random-based id for any environment that
 *  doesn't (defensive — shouldn't happen in Electron, but keeps the code
 *  portable for tests). */
function cryptoRandomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // RFC 4122 v4-ish fallback.
  return "t-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Compose the final prompt string from the textarea text + all tags.
 *  Tags are appended so the model can clearly see "user typed X, plus these
 *  N attachments". Order: typed text first, then tags in array order.
 *
 *  - Skill tags become bare `/name` lines — the SDK recognizes this as a skill
 *    invocation. They are NOT delimited: a bare command line is how skills are
 *    triggered, and wrapping it in markers would break recognition.
 *  - Paste tags become delimited content blocks (full text wrapped in
 *    `--- pasted content N ---` / `--- end ---` markers).
 *  - File tags become bare `@path` reference lines (one per line) — the
 *    agent reads the file itself via its tools, so no content is inlined. */
export function composePromptWithTags(
  text: string,
  tags: ReadonlyArray<ContentTag>,
): string {
  const textTrimmed = text.trim();
  if (tags.length === 0) return textTrimmed;
  // Walk the tags in array order, emitting each tag's contribution. Skill and
  // file tags contribute a bare single line (`/name` / `@path`); paste tags
  // contribute a delimited block. Parts are joined by blank lines.
  const parts: string[] = [];
  let pasteIdx = 0;
  for (const tag of tags) {
    if (tag.kind === "skill" || tag.kind === "file") {
      parts.push(tag.content); // "/name" or "@path"
    } else {
      pasteIdx += 1;
      parts.push(
        `--- pasted content ${pasteIdx} (${tag.content.length} chars) ---\n${tag.content}\n--- end ---`,
      );
    }
  }
  const tagBlock = parts.join("\n\n");
  return textTrimmed ? `${textTrimmed}\n\n${tagBlock}` : tagBlock;
}

/** Append file tags, skipping paths already present (by absolute filePath). */
export function appendUniqueFileTags(
  prev: ReadonlyArray<ContentTag>,
  filePaths: ReadonlyArray<string>,
): ContentTag[] {
  const seen = new Set(
    prev.filter((t) => t.kind === "file" && t.filePath).map((t) => t.filePath as string),
  );
  const next = [...prev];
  for (const p of filePaths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    next.push(makeFileTag(p));
  }
  return next;
}

/** Append a skill tag, skipping when the same skill name is already present.
 *  A skill is identified by its `/name` content, so we dedupe on that. */
export function appendUniqueSkillTag(
  prev: ReadonlyArray<ContentTag>,
  skill: { name: string },
): ContentTag[] {
  const content = `/${skill.name}`;
  if (prev.some((t) => t.kind === "skill" && t.content === content)) {
    return [...prev];
  }
  return [...prev, makeSkillTag(skill)];
}
