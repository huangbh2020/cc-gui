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

/** Pasting a single-line shorter than this is left inline in the textarea
 *  (no chip). Anything over this OR a paste with more than
 *  {@link TAG_THRESHOLD_LINES} lines becomes a tag. */
export const TAG_THRESHOLD_CHARS = 200;

/** A paste spanning more than this many lines is promoted to a tag even if
 *  it's short — long logs / stack traces get chipped regardless of char
 *  count. A 2-3 line snippet stays inline so the user isn't interrupted
 *  for ordinary multi-line pastes. */
export const TAG_THRESHOLD_LINES = 3;

/** Source of the tag. Today only paste; future: file-drop, image-paste, etc. */
export type ContentTagKind = "paste";

/** One content tag. `id` is the React key + removal handle. `content` is the
 *  full pasted text, sent verbatim on Send. `preview` is for chip display. */
export interface ContentTag {
  id: string;
  kind: ContentTagKind;
  preview: string;
  content: string;
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
 *  Tags are appended as delimited blocks so the model can clearly see
 *  "user typed X, plus these N attachments". Order: typed text first,
 *  then tags in array order. */
export function composePromptWithTags(
  text: string,
  tags: ReadonlyArray<ContentTag>,
): string {
  const textTrimmed = text.trim();
  if (tags.length === 0) return textTrimmed;
  const blocks = tags.map(
    (tag, i) =>
      `--- pasted content ${i + 1} (${tag.content.length} chars) ---\n${tag.content}\n--- end ---`,
  );
  return textTrimmed ? `${textTrimmed}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n");
}
