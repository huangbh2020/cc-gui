/**
 * Shared AskUserQuestion helpers — provider-neutral logic used by both the
 * Claude and Pi providers.
 *
 * Extracted here so the Pi provider's inline extension can register a native
 * AskUserQuestion tool (via `pi.registerTool`) without depending on the Claude
 * SDK adapter internals. The Claude provider keeps using it in `canUseTool`
 * and the sentinel-text fallback scanner.
 */
import type { AskUserQuestionItem } from "@contracts/runtime";
import type { UserInputAnswers } from "@contracts/provider";

/** Trim a value to a string, tolerating non-string input (defensive parse). */
function readStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Parse questions from tool input or sentinel JSON.
 *
 * Tolerates the SDK's `{ questions: { item: [...] } }` wrapper shape (an XML
 * serialization artifact) as well as a plain array. Invalid entries are
 * dropped; an empty array is returned on any structural problem.
 */
export function parseQuestions(input: unknown): AskUserQuestionItem[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as { questions?: unknown }).questions;
  let arr: unknown[] | null = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && typeof raw === "object" && "item" in raw) {
    const inner = (raw as Record<string, unknown>).item;
    arr = Array.isArray(inner) ? inner : null;
  }
  if (!arr) return [];
  const out: AskUserQuestionItem[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const question = readStr(obj.question);
    const header = readStr(obj.header) || question.slice(0, 24);
    const multiSelect = obj.multiSelect === true || obj.multiSelect === "true";
    const rawOpts = obj.options;
    let optsArr: unknown[] | null = null;
    if (Array.isArray(rawOpts)) {
      optsArr = rawOpts;
    } else if (rawOpts && typeof rawOpts === "object" && "item" in rawOpts) {
      optsArr = (rawOpts as Record<string, unknown>).item as unknown[];
    }
    const options = (optsArr ?? [])
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => ({ label: readStr(o.label), description: readStr(o.description) || undefined }))
      .filter((o) => o.label);
    if (question) out.push({ header, question, multiSelect, options });
  }
  return out;
}

/**
 * Format the user's answers back into a model-facing text result. The model
 * treats the AskUserQuestion tool result as the user's reply, so we surface
 * each question + the chosen option label(s).
 *
 * Unanswered questions are reported as "(no answer)" so the model knows which
 * were skipped (the host returns null for dismissed/unanswered questions).
 */
export function formatAnswersForModel(
  answers: UserInputAnswers,
  questions: AskUserQuestionItem[],
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const v = answers[q.question];
    if (v == null) {
      lines.push(`${q.question}: (no answer)`);
    } else {
      const joined = Array.isArray(v) ? v.join(", ") : v;
      lines.push(`${q.question}: ${joined}`);
    }
  }
  return lines.join("\n");
}

/**
 * System prompt describing the sentinel-delimited JSON format the model should
 * emit when no native AskUserQuestion tool is available (Claude sentinel-text
 * fallback). Also used verbatim by the Pi provider's `before_agent_start`
 * extension to teach the model the native AskUserQuestion tool's input schema.
 *
 * NOTE: on Pi the native tool IS available (registered via the inline
 * extension), so the sentinel format is informational there — but keeping a
 * single source of truth for the prompt avoids drift across providers.
 */
export const ASK_SYSTEM_PROMPT = [
  `When you need to ask the user a question or need them to choose between options, you MUST emit it in this EXACT format and nothing else on those lines:`,
  `<<<ASK_USER_QUESTION>>>`,
  `a single line of JSON with this shape: {"questions":[{"header":"short label","question":"the full question","multiSelect":false,"options":[{"label":"A","description":"why A"},{"label":"B","description":"why B"}]}]}`,
  `<<<END_ASK_USER_QUESTION>>>`,
  `Rules: emit ONLY the JSON between the sentinels (no markdown fences, no extra text on those lines). Use multiSelect:true when multiple choices are allowed. After emitting, STOP and wait for the user's answer — do not answer your own question.`,
].join(" ");
