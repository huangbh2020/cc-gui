/**
 * Tiptap-based rich-text composer replacing the plain `<textarea>`.
 *
 * ## Why
 *
 * The composer needs inline, atomic "skill pills" — a `/skill` selected from
 * the slash picker becomes an undeletable-in-parts chip that lives inline with
 * the typed text (like a Slack @mention). A plain textarea can't embed rich
 * nodes, so we switch to a contenteditable powered by Tiptap. Tiptap gives us a
 * real document model (ProseMirror), proper IME/selection handling, and a
 * clean serialization path — all of which are painful to hand-roll.
 *
 * ## Design
 *
 * The skill pill is a custom Mention-style node (`name: "skill"`), `atom: true`
 * so a single backspace removes it whole. We do NOT use Tiptap's Suggestion
 * popup: the parent still owns the `SlashCommandPicker` and trigger detection
 * (reading the editor's text + caret). On pick the parent calls
 * `editorRef.insertSkill(skill)`, which replaces the `/query` token with the
 * pill node + a trailing space.
 *
 * `@` mentions and long-paste promotion stay as chip-above-editor tags in the
 * parent — unchanged from the textarea era. This component only owns the text
 * + skill pills.
 *
 * ## Serialization
 *
 * On send the parent reads `editorRef.serialize()` → `{ text, skillNames }`:
 *   - `text` has skill nodes inlined as `/name` (via the node's `renderText`),
 *     preserving their position in the sentence.
 *   - `skillNames` is the list of embedded skill names (for stream rendering).
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Mention, type MentionNodeAttrs } from "@tiptap/extension-mention";
import { cn } from "@renderer/lib/cn.js";
import type { SkillInfo } from "@contracts/ipc";

/** Result of serializing the editor's document for sending. */
export interface ComposerSerialization {
  /** Plain text with skill pills inlined as `/name` at their positions. */
  text: string;
  /** Names of the skills embedded in the document, in document order. */
  skillNames: string[];
}

/** Imperative handle the parent uses to drive the editor. */
export interface ComposerEditorHandle {
  focus: () => void;
  /** Blur the editor. */
  blur: () => void;
  /** Clear all content. */
  clear: () => void;
  /** Replace all content with plain text (no skill pills), focus the editor,
   *  and place the caret at the end. Used by suggestion prompts. */
  setText: (text: string) => void;
  /** Get the bounding rect of the editor element (for picker anchoring). */
  getRect: () => DOMRect | null;
  /**
   * Replace the text range [start, end) with a skill pill + trailing space,
   * then place the caret right after the space. `start`/`end` are offsets
   * into the editor's plain-text representation (as produced by
   * `getTextWithSkills`).
   */
  insertSkill: (skill: SkillInfo, start: number, end: number) => void;
  /** Delete the text in the plain-text range [start, end), then place the
   *  caret at `start`. Used to remove a `/query` or `@query` trigger token. */
  deleteTextRange: (start: number, end: number) => void;
  /** Serialize the current document for sending. */
  serialize: () => ComposerSerialization;
  /** Current plain text (skills inlined as `/name`), for trigger detection. */
  getTextWithSkills: () => string;
  /** Current caret offset in the plain-text representation. -1 if unknown. */
  getCaretOffset: () => number;
  /** Focus the editor and collapse the caret to the given plain-text offset. */
  setCaretOffset: (offset: number) => void;
}

interface ComposerEditorProps {
  /** Placeholder shown when empty. */
  placeholder: string;
  /** Whether the editor accepts input (false = read-only / locked). */
  editable: boolean;
  /** Called on every content change with the current plain-text-with-skills. */
  onChange: (text: string) => void;
  /** Called when the user presses Enter without Shift (the parent decides
   *  send vs enqueue based on session state). Shift+Enter inserts a newline
   *  and is NOT reported. */
  onEnter: () => void;
  /** Called with a paste that should be promoted to a tag (long / multi-line).
   *  Short pastes are inserted inline as plain text by default. */
  onPromotePaste?: (text: string) => void;
  /** Threshold check — if true, the paste is forwarded to onPromotePaste
   *  instead of inserted inline. */
  shouldPromotePaste?: (text: string) => boolean;
  /** CSS class on the editor host. */
  className?: string;
}

/**
 * Custom Mention node for skills. We extend Mention (rather than configuring
 * it) so the node type has its own name ("skill"), keeping it decoupled from a
 * potential future @-mention node. `atom: true` is inherited from Mention,
 * which makes the pill a single atomic unit for deletion/selection.
 *
 * `renderText` is what `editor.getText()` emits for the node — `/name` — so
 * serialization naturally inlines the skill invocation in place.
 */
const SkillPill = Mention.extend({
  name: "skill",
  // Render the pill: a non-editable span with the sparkles icon + /name.
  // We keep the default parseHTML (span[data-type="skill"]) so the editor can
  // rehydrate pills if we ever round-trip HTML.
  renderHTML({ node, HTMLAttributes }) {
    const name = node.attrs.label ?? node.attrs.id ?? "";
    return [
      "span",
      this.options.HTMLAttributes
        ? { "data-type": "skill", ...HTMLAttributes }
        : { "data-type": "skill", ...HTMLAttributes },
      `/${name}`,
    ];
  },
}).configure({
  // Suppress the built-in suggestion popup — the parent drives the
  // SlashCommandPicker and trigger detection itself. We provide a no-op render
  // so the suggestion plugin never creates any UI; we only need the node type
  // (atom: true, inline) from Mention, not its suggestion machinery.
  suggestion: {
    char: "/",
    render: () => ({
      onStart: () => {},
      onUpdate: () => {},
      onExit: () => {},
    }),
  },
  renderText: ({ node }) => `/${node.attrs.label ?? node.attrs.id ?? ""}`,
  HTMLAttributes: {
    class: cn(
      "skill-pill inline-flex items-center gap-0.5 rounded border border-accent/40 bg-accent/10 px-1 py-0 align-baseline",
      "text-[0.85em] text-accent",
    ),
  },
});

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  ComposerEditorProps
>(function ComposerEditor(
  {
    placeholder,
    editable,
    onChange,
    onEnter,
    onPromotePaste,
    shouldPromotePaste,
    className,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Mirror the callbacks in refs so the editor (created once) always calls the
  // latest closures without needing to recreate the editor.
  const onChangeRef = useRef(onChange);
  const onEnterRef = useRef(onEnter);
  const onPromotePasteRef = useRef(onPromotePaste);
  const shouldPromotePasteRef = useRef(shouldPromotePaste);
  onChangeRef.current = onChange;
  onEnterRef.current = onEnter;
  onPromotePasteRef.current = onPromotePaste;
  shouldPromotePasteRef.current = shouldPromotePaste;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // The composer is a single-line-ish input that soft-wraps. Shift+Enter
        // inserts a hard break; StarterKit's default is already enabled, so we
        // just accept defaults here.
      }),
      SkillPill,
    ],
    content: "",
    editable,
    editorProps: {
      attributes: {
        class: cn(
          "composer-prose outline-none",
          "min-h-[1.5rem] leading-relaxed",
        ),
        "aria-label": placeholder,
        "data-placeholder": placeholder,
      },
      // Force every paste to plain text: contenteditable would otherwise insert
      // rich HTML from external sources (browsers, other apps). If the paste is
      // bulky (per shouldPromotePaste) we hand it to the parent as a tag and
      // suppress insertion entirely.
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const promote = shouldPromotePasteRef.current?.(text);
        if (promote && onPromotePasteRef.current) {
          event.preventDefault();
          onPromotePasteRef.current(text);
          return true;
        }
        if (!text) return false;
        event.preventDefault();
        // Insert as plain text, preserving the current selection.
        view.dispatch(view.state.tr.insertText(text));
        return true;
      },
      // Enter sends (parent decides send vs enqueue); Shift+Enter = newline.
      // Suppress Enter during IME composition (so confirming a candidate
      // doesn't send the message).
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          onEnterRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(textWithSkills(editor));
    },
  });

  // Keep editable in sync with the prop without recreating the editor.
  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  /** Plain-text representation of the doc: text nodes verbatim, skill nodes as
   *  `/name`. Walks the doc so node order is preserved relative to text. */
  function textWithSkills(ed: typeof editor): string {
    if (!ed) return "";
    const { doc } = ed.state;
    let out = "";
    doc.descendants((node) => {
      if (node.isText) {
        out += node.text ?? "";
      } else if (node.type.name === "skill") {
        out += `/${node.attrs.label ?? node.attrs.id ?? ""}`;
        return false; // don't descend into the pill
      }
      return true;
    });
    return out;
  }

  /** Plain-text offset of the current selection. Maps the ProseMirror
   *  position to an offset in the `textWithSkills` string by walking the doc
   *  up to the selection. Returns -1 when the selection is inside a pill (no
   *  meaningful text offset) or the editor isn't focused. */
  function caretOffset(ed: typeof editor): number {
    if (!ed) return -1;
    const { doc, selection } = ed.state;
    const head = selection.from;
    let offset = 0;
    let found = -1;
    doc.nodesBetween(0, head, (node, pos) => {
      if (found !== -1) return false;
      const end = pos + node.nodeSize;
      if (node.isText) {
        if (head <= end) {
          found = offset + (head - pos);
          return false;
        }
        offset += node.text?.length ?? 0;
      } else if (node.type.name === "skill") {
        // A pill contributes `/name` chars.
        offset += `/${node.attrs.label ?? node.attrs.id ?? ""}`.length;
        return false;
      }
      return true;
    });
    return found === -1 ? offset : found;
  }

  /** Convert a plain-text offset (in the `textWithSkills` space) back to a
   *  ProseMirror document position. Used by insertSkill to map the
   *  trigger-token range into the doc. */
  function textOffsetToPos(ed: typeof editor, offset: number): number {
    if (!ed) return 0;
    const { doc } = ed.state;
    let pos = 0;
    let acc = 0;
    doc.descendants((node, p) => {
      if (acc >= offset) return false;
      if (node.isText) {
        const len = node.text?.length ?? 0;
        if (acc + len >= offset) {
          pos = p + (offset - acc);
          acc = offset;
          return false;
        }
        acc += len;
      } else if (node.type.name === "skill") {
        const len = `/${node.attrs.label ?? node.attrs.id ?? ""}`.length;
        if (acc + len >= offset) {
          // Snap to the pill's end — pills are atomic.
          pos = p + node.nodeSize;
          acc = offset;
          return false;
        }
        acc += len;
      }
      return true;
    });
    if (acc < offset) pos = doc.content.size; // past the end
    return pos;
  }

  useImperativeHandle(
    ref,
    (): ComposerEditorHandle => ({
      focus: () => editor?.commands.focus(),
      blur: () => editor?.commands.blur(),
      clear: () => editor?.commands.clearContent(true),
      setText: (text) => {
        if (!editor) return;
        editor.commands.clearContent(true);
        if (text) editor.commands.insertContent(text);
        editor.commands.focus("end");
      },
      getRect: () => hostRef.current?.getBoundingClientRect() ?? null,
      insertSkill: (skill, start, end) => {
        if (!editor) return;
        const from = textOffsetToPos(editor, start);
        const to = textOffsetToPos(editor, end);
        const attrs: MentionNodeAttrs = {
          id: skill.name,
          label: skill.name,
        };
        editor
          .chain()
          .focus()
          .deleteRange({ from, to })
          .insertContentAt(from, [
            { type: "skill", attrs },
            { type: "text", text: " " },
          ])
          .run();
        // Place the caret right after the inserted space. The pill occupies
        // 1 node (nodeSize 1), so in plain-text terms the caret lands at
        // start + 1 ("/name"→ we treat the pill as one unit here) + 1 (space).
        // Simpler: just move to end of the freshly inserted content.
        requestAnimationFrame(() => {
          if (!editor) return;
          // Position the caret at the position right after the inserted space.
          // insertContentAt placed the space at `from + pillNodeSize`; its text
          // ends at `from + pillNodeSize + 1`. Compute via the live doc.
          editor.commands.focus();
          editor.commands.setTextSelection(from + 2);
        });
      },
      deleteTextRange: (start, end) => {
        if (!editor) return;
        const from = textOffsetToPos(editor, start);
        const to = textOffsetToPos(editor, end);
        editor
          .chain()
          .focus()
          .deleteRange({ from, to })
          .setTextSelection(from)
          .run();
      },
      setCaretOffset: (offset) => {
        if (!editor) return;
        const pos = textOffsetToPos(editor, offset);
        editor.chain().focus().setTextSelection(pos).run();
      },
      serialize: () => {
        if (!editor) return { text: "", skillNames: [] };
        const skillNames: string[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === "skill") {
            skillNames.push(node.attrs.label ?? node.attrs.id ?? "");
          }
        });
        return { text: textWithSkills(editor), skillNames };
      },
      getTextWithSkills: () => textWithSkills(editor),
      getCaretOffset: () => caretOffset(editor),
    }),
    [editor],
  );

  return (
    <div
      ref={hostRef}
      className={cn("composer-host", className)}
    >
      <EditorContent editor={editor} />
    </div>
  );
});
