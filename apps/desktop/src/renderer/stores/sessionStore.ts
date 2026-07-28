import { create } from "zustand";
import type { Project, Session, MessageRecord, SessionTodoItem, SessionPlanDraft } from "@contracts/session";
import type {
  RuntimeEvent,
  PermissionMode,
  EffortLevel,
  AskUserQuestionItem,
  ApprovalRequestEvent,
  PlanApprovalRequestEvent,
  PlanUpdateEvent,
  SubagentSnapshot,
  ContextSnapshot,
} from "@contracts/runtime";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { isValidSnapshot } from "@renderer/lib/contextWindow.js";
import type { CustomModelPublic } from "@contracts/customModel";
import { CUSTOM_MODEL_ROLES } from "@contracts/customModel";
import { api } from "@renderer/lib/api.js";
import {
  DISPLAY_MODE_SETTING_KEY,
  UI_CHAT_FONT_SIZE_SETTING_KEY,
  UI_USER_MSG_COLOR_SETTING_KEY,
  UI_ACCENT_COLOR_SETTING_KEY,
  type DisplayMode,
} from "@contracts/ipc";
import type { UserInputAnswers } from "@contracts/provider";

/** A single content block within a message (mirrors how claude structures output). */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; toolName: string; input: unknown; status: "running" | "done" | "error"; result?: unknown }
  | { kind: "error"; message: string };

/** Turn-level timing metadata. Attached to the FIRST assistant message of
 *  a turn (the one created when the first text.delta / thinking / tool.use
 *  arrives) so the renderer can show "started at · duration" once per turn,
 *  above that message. `endedAt` is set when `turn.done` (or `error`) lands;
 *  while undefined the turn is still running and the duration ticks live.
 *
 *  Persisted as part of the message snapshot, so the stats survive reload. */
export interface TurnMeta {
  /** Wall-clock ms when the turn started (first assistant block arrived). */
  startedAt: number;
  /** Wall-clock ms when the turn ended (turn.done / error). Undefined while
   *  the turn is still streaming — the renderer treats this as "live". */
  endedAt?: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  blocks: Block[];
  createdAt: number;
  /** Present only on the first assistant message of a turn. Drives the
   *  per-turn "开始时间 · 工作时长" stat row above the answer. */
  turnMeta?: TurnMeta;
}

/** A single todo item from claude's TodoWrite tool. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/** Per-session plan-mode draft for the activity capsule. `plan: ""` and
 *  `phase: "cleared"` means "not in plan mode" — the capsule drops the Plan
 *  section entirely. */
export interface PlanDraft {
  plan: string;
  phase: PlanUpdateEvent["phase"];
}

interface SessionState {
  /* ── projects & sessions (tree cache) ──
   * sessions are cached per-project so the left-bar tree can render every
   * project's threads without a round-trip per expand. `sessions` is kept
   * as a convenience alias for the active project's sessions. */
  projects: Project[];
  activeProjectId: string | null;
  /** Active (non-archived) sessions per project — paginated: only the first
   *  `SESSION_PAGE_SIZE` rows are loaded on init / project expand, and
   *  `loadMoreSessions(projectId)` appends the next page. `sessions` is kept
   *  as a convenience alias for the active project's loaded page. */
  sessionsByProject: Record<string, Session[]>;
  /** `true` when a project has more active sessions on the server than are
   *  currently loaded into `sessionsByProject[pid]`. Drives the "加载更多"
   *  affordance under the project's thread list. */
  sessionsHasMoreByProject: Record<string, boolean>;
  /** Total active-session count per project (server-side). Lets the UI show
   *  "还有 N 条" alongside the load-more button. */
  sessionsTotalByProject: Record<string, number>;
  /** Archived sessions per project (unpaginated). Powers the bottom "已归档"
   *  bin, which is now grouped by project rather than a flat dump. Only
   *  populated for projects that have ≥1 archived session. */
  archivedSessionsByProject: Record<string, Session[]>;
  /** Sessions of the active project (derived view; components may read either). */
  sessions: Session[];
  activeSessionId: string | null;
  /** Which projects are expanded in the tree (UI-only, not persisted). */
  expandedProjects: Record<string, boolean>;
  /** Whether the "archived" section at the bottom of the tree is expanded. */
  archivedViewOpen: boolean;

  /* ── tab state (center pane) ──
   *  `openTabs` is the ordered list of sessionIds the user has open in the
   *  center pane. In `single` displayMode the renderer only mounts the
   *  `activeSessionId` chat pane (so the list is mostly informational); in
   *  `tabs` mode the list drives the SessionTabs strip and switching
   *  between them is the primary way to navigate. We always write the
   *  list (regardless of mode) so flipping the mode switch never loses
   *  the user's open sessions. */
  openTabs: string[];
  /** How the center pane renders. Persisted in the `settings` table. */
  displayMode: DisplayMode;
  /** Chat content font size in px (12–20). Persisted in the `settings`
   *  table. Applied to <html> as the --chat-font-size CSS var by
   *  lib/appearance.ts so it cascades into the message rows + markdown. */
  chatFontSize: number;
  /** Custom user-message background color as an "R G B" triplet string
   *  (e.g. "124 58 237"), or null to use the theme default. Persisted in
   *  the `settings` table. Applied to <html> as --user-bubble. */
  userMessageColor: string | null;
  /** Custom global brand/accent color as an "R G B" triplet string
   *  (e.g. "5 150 105"), or null to use the theme default. Persisted in
   *  the `settings` table. Applied to <html> as --accent, which cascades
   *  into the `accent` Tailwind token used by buttons, links, selected
   *  states, focus rings, and the prompt-card accents. */
  accentColor: string | null;

  messagesBySession: Record<string, ChatMessage[]>;
  /** Per-session running flag. Keyed by sessionId so a turn running in
   *  thread A doesn't lock the composer in thread B — the user can keep
   *  composing / inspecting other threads while a background turn streams.
   *  `false` / missing entry = idle. Reads should go through the
   *  `isRunningForActiveSession` selector below (or compute on the fly)
   *  so consumers always see "am I running?" relative to the active thread. */
  runningBySession: Record<string, boolean>;
  claudeInstalled: boolean | null;
  /** Settings modal visibility (opened from the LeftBar ⚙ footer and the CLI-missing CTA). */
  settingsOpen: boolean;
  /** Permission mode for the next session. The 6-value union
   *  (default / acceptEdits / plan / bypassPermissions / dontAsk / auto)
   *  mirrors the Claude Agent SDK's accepted literals; the composer chip
   *  only surfaces the 4 user-facing ones. See PermissionMode in
   *  @contracts/runtime for the full list. */
  permissionMode: PermissionMode;
  /** Model for the next session ("default" = let claude pick). → --model. */
  model: string;
  /** Custom-model config bound to the active session (null = built-in). */
  customModelId: string | null;
  /** User-defined custom-model configs (desensitized — tokens masked). */
  customModels: CustomModelPublic[];
  /** Reasoning effort for the next session ("default" = don't pass --effort).
   *  Defaults to "high" so new sessions get the most thinking out of the
   *  box — users can cycle down to Auto if they want claude to pick. */
  effort: EffortLevel;
  /** Latest task list per session (from claude's TodoWrite; null = none yet). */
  todosBySession: Record<string, TodoItem[]>;
  /** Per-session plan-mode draft (empty = not in plan mode). Drives the
   *  Plan section of the activity capsule. */
  planBySession: Record<string, PlanDraft>;
  /** Per-session subagent roster (REPLACE semantics from `subagent.update`).
   *  Empty array = no subagents active. Includes recently-completed ones
   *  until the next turn clears them. */
  subagentsBySession: Record<string, SubagentSnapshot[]>;
  /** Per-session context-window snapshot (from `token-usage.updated` events).
   *  The adapter already did all the math (usedTokens / maxTokens / pct /
   *  warning), so the renderer only stores + renders. Keyed by sessionId so
   *  each tab shows its own occupancy. Hydrated from the session row on
   *  select/open (the snapshot is persisted), then kept live as
   *  `token-usage.updated` events stream in. */
  contextSnapshotBySession: Record<string, ContextSnapshot>;
  /** Per-session pending AskUserQuestion. Keyed by sessionId so a
   *  question popping up in tab B doesn't clobber tab A's. The sessionId
   *  lives on the inner record for cross-checking at render time.
   *
   *  `requestId` correlates the answer back to the provider's pending
   *  user-input Deferred — submitting answers resolves that Deferred so
   *  the SAME turn continues (it does NOT start a new turn). Absent only
   *  for the sentinel-fallback path (no Deferred to resolve). */
  pendingQuestionBySession: Record<string, { questions: AskUserQuestionItem[]; requestId?: string }>;
  /** Per-session tool-approval queue. The head (index 0 of the sub-array
   *  for the session) is what's rendered in the composer overlay. The
   *  top-level array holds all sessions' pending approvals; UI filters
   *  by sessionId. */
  pendingApprovals: ApprovalRequestEvent[];
  /** Per-session pending ExitPlanMode approval. Unlike tool approvals
   *  (which queue), plan approval is one-at-a-time per session — the model
   *  calls ExitPlanMode once per plan. `null` = no plan awaiting decision.
   *  Keyed by sessionId so each tab tracks its own. */
  pendingPlanApprovalBySession: Record<string, PlanApprovalRequestEvent>;

  /** Files modified or created in the most recent turn (for the
   *  "本轮文件" rewind card). Per-session: a new turn in session A does
   *  not overwrite session B's card. The card is cleared on
   *  `turn.rewound` for the same session. */
  turnFilesBySession: Record<string, TurnFileEntry[]>;

  // actions
  init: () => Promise<void>;
  addProjectFromFolder: () => Promise<string | null>;
  selectProject: (projectId: string) => Promise<void>;
  toggleProjectExpanded: (projectId: string) => void;
  setArchivedViewOpen: (open: boolean) => void;
  /** Fetch the next page of active sessions for a project and append it to
   *  `sessionsByProject[projectId]`. No-op when there are no more to load. */
  loadMoreSessions: (projectId: string) => Promise<void>;
  startSession: (projectId?: string) => Promise<void>;
  /** Switch the active session (and load its history if not cached).
   *  Always replaces the center pane content. In `single` displayMode
   *  this is the only navigation primitive; in `tabs` mode it's used
   *  by SessionTabs to flip between already-open tabs. */
  selectSession: (sessionId: string) => Promise<void>;
  /** Open a session as a tab. If it's already in `openTabs` this is a
   *  no-op except for the activeSessionId flip; otherwise it's appended
   *  to the end of the list. This is the LeftBar's "click a thread"
   *  entry point in both display modes — the difference is purely
   *  cosmetic (single mode hides the tab strip, tabs mode shows it). */
  openTab: (sessionId: string) => Promise<void>;
  /** Remove a session from the tab strip. If it was the active tab,
   *  focus shifts to the previous one (or the next, if there is no
   *  previous); running turns are NOT cancelled — they keep streaming
   *  in the background and the user can re-open the tab to see them. */
  closeTab: (sessionId: string) => void;
  deleteProject: (id: string) => Promise<void>;
  archiveProject: (id: string, archived: boolean) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  sendPrompt: (prompt: string) => Promise<void>;
  interrupt: () => Promise<void>;
  ingestEvent: (e: RuntimeEvent) => void;
  setSettingsOpen: (open: boolean) => void;
  /** Update the center-pane display mode. Persists to the `settings`
   *  table so the choice survives restart. */
  setDisplayMode: (mode: DisplayMode) => Promise<void>;
  /** Update the chat content font size (clamped to 12–20 px). Persists to
   *  the `settings` table. */
  setChatFontSize: (px: number) => Promise<void>;
  /** Update the user-message background color (R G B triplet, or null =
   *  theme default). Persists to the `settings` table. */
  setUserMessageColor: (rgb: string | null) => Promise<void>;
  /** Set the global brand/accent color ("R G B" triplet, or null for the
   *  theme default). Persists to the `settings` table. */
  setAccentColor: (rgb: string | null) => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => void;
  setModel: (model: string) => void;
  setEffort: (effort: EffortLevel) => void;
  setCustomModel: (id: string | null, model?: string) => void;
  reloadCustomModels: () => Promise<void>;
  dismissQuestion: () => void;
  /** Submit answers to the head AskUserQuestion for the active session.
   *  Calls `claude:respondQuestion` which resolves the provider's pending
   *  user-input Deferred — the SAME turn then continues (the model receives
   *  the answers and proceeds). This is the correct path: it does NOT start
   *  a new turn. For sentinel-fallback requests (no Deferred), main composes
   *  the answers into a prompt and starts a follow-up turn itself. */
  submitQuestion: (answers: UserInputAnswers) => Promise<void>;
  /** Approve or deny the head of the approval queue. Called by the
   *  composer overlay; resolves the matching canUseTool on the main side
   *  and shifts the head off. If the queue has more items, the next one
   *  auto-promotes. */
  decideApproval: (requestId: string, granted: boolean, always?: boolean) => Promise<void>;
  /** Submit the user's approve/reject decision on a pending ExitPlanMode
   *  plan. Resolves the provider's pending plan-approval Deferred via
   *  `claude:respondPlanApproval` so the SAME turn continues — approve →
   *  SDK exits plan mode and starts executing; reject → SDK stays in plan
   *  mode and the model can revise. On success the pending card clears;
   *  on IPC failure it stays so the user can retry. */
  submitPlanApproval: (requestId: string, approved: boolean, editedPlan?: string, reason?: string) => Promise<void>;
  /** Rewind the most recent turn: restore all files Edit/Write touched
   *  to their pre-turn state. The IPC call returns the list of restored
   *  paths; we leave the UI state update to the `turn.rewound` event
   *  that main emits after restore completes (single source of truth
   *  for "files are back"). The call is fire-and-await; failures log
   *  to console and leave state untouched so the user can retry. */
  rewindTurn: () => Promise<void>;
  refreshClaudeHealth: () => Promise<void>;
}

/** Map of messageId → msg for fast delta accumulation. */
function findMsg(list: ChatMessage[], messageId: string): ChatMessage | undefined {
  return list.find((m) => m.id === messageId);
}

/* ─── ChatMessage ↔ MessageRecord ───
 * The DB stores `content` as JSON. New rows store an object
 * `{ blocks, turnMeta? }`; legacy rows stored just the `blocks` array, which
 * we detect with Array.isArray for backward compatibility. Reloading a
 * session round-trips the exact blocks (and turn timing) the renderer built. */
function toRecords(sessionId: string, messages: ChatMessage[]): MessageRecord[] {
  return messages.map((m) => ({
    id: m.id,
    sessionId,
    role: m.role,
    content: m.turnMeta ? { blocks: m.blocks, turnMeta: m.turnMeta } : m.blocks,
    createdAt: m.createdAt,
  }));
}

function fromRecords(records: MessageRecord[]): ChatMessage[] {
  return records.map((r) => {
    // Legacy rows: content is the blocks array. New rows: content is
    // { blocks, turnMeta? }. Degrade gracefully on unknown shapes.
    let blocks: Block[] = [];
    let turnMeta: TurnMeta | undefined;
    if (Array.isArray(r.content)) {
      blocks = r.content as Block[];
    } else if (r.content && typeof r.content === "object") {
      const obj = r.content as { blocks?: Block[]; turnMeta?: TurnMeta };
      if (Array.isArray(obj.blocks)) blocks = obj.blocks;
      if (obj.turnMeta) turnMeta = obj.turnMeta;
    }
    return {
      id: r.id,
      sessionId: r.sessionId,
      role: r.role === "user" ? "user" : "assistant",
      blocks,
      createdAt: r.createdAt,
      ...(turnMeta ? { turnMeta } : {}),
    };
  });
}

/** Stable empty arrays so selectors never return a fresh [] (Zustand Object.is). */
export const EMPTY_MESSAGES: ChatMessage[] = [];
export const EMPTY_TODOS: TodoItem[] = [];
export const EMPTY_TURN_FILES: TurnFileEntry[] = [];
const EMPTY_CUSTOM_MODELS: CustomModelPublic[] = [];
const EMPTY_SESSIONS: Session[] = [];
export const EMPTY_SUBAGENTS: SubagentSnapshot[] = [];
/** Stable cleared-plan reference — used both as the initial state and as
 * the "not in plan mode" placeholder returned by selectors. */
export const EMPTY_PLAN: PlanDraft = { plan: "", phase: "cleared" };

/** Min/max chat content font size (px). The slider in Settings uses the
 *  same bounds; setChatFontSize clamps to this range defensively. */
export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 20;

/** Clamp a font-size value to the allowed slider range. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return 14;
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, Math.round(px)));
}

/** Matches a well-formed space-separated "R G B" triplet (0–255 each),
 *  e.g. "124 58 237". Used to validate the user-message color setting
 *  (which feeds the --user-bubble CSS var). */
const RGB_TRIPLET_RE = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/;

/** Page size for the left-bar thread list. The first page is fetched on
 *  init / project expand; further pages are appended on "加载更多". */
const SESSION_PAGE_SIZE = 5;

/** Find a session across both the active and archived per-project caches by
 *  id. The archived cache is consulted so that config hydration still finds
 *  a session a user just restored (and so deleted/restored fallbacks don't
 *  miss rows that were moved between caches). */
function findSession(
  sessionsByProject: Record<string, Session[]>,
  archivedByProject: Record<string, Session[]>,
  id: string,
): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    const hit = list?.find((s) => s.id === id);
    if (hit) return hit;
  }
  for (const list of Object.values(archivedByProject)) {
    const hit = list?.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Read a session's persisted config (model / effort / permissionMode /
 *  customModelId) into the global view slots so the composer renders the
 *  active thread's choices. If the session can't be found (not yet loaded,
 *  or unknown id), leaves the slot untouched — better to keep a previous
 *  valid value than to flash a placeholder while the cache is filling. */
function syncConfigFromSession(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, sessionId);
  if (!sess) return;
  set({
    model: sess.model,
    effort: sess.effort,
    permissionMode: sess.permissionMode,
    customModelId: sess.customModelId,
  });
}

/** Hydrate the per-session context-window snapshot from the session row.
 *  The snapshot is persisted by main on every `token-usage.updated` event
 *  (RuntimeManager.emit), so on select/open-tab we can restore the last
 *  known occupancy without waiting for the next event. Pre-refactor rows
 *  may hold a stale raw-usage object (no `usedTokens` / `pct` / …) —
 *  `isValidSnapshot` guards against those so the chip doesn't render NaN.
 *  A null/invalid snapshot is cleared (set to undefined) so switching FROM
 *  a session with a snapshot TO one without doesn't leave the old chip up. */
function hydrateContextSnapshot(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, sessionId);
  const snapshot = sess?.contextSnapshot;
  set((s) => {
    const next = { ...s.contextSnapshotBySession };
    if (snapshot && isValidSnapshot(snapshot)) {
      next[sessionId] = snapshot;
    } else {
      delete next[sessionId];
    }
    return { contextSnapshotBySession: next };
  });
}

/** Hydrate the capsule state slices (todos / subagents / plan draft) from
 *  the session row. Each slice is restored independently — a session may
 *  have todos but no subagents, etc. Slices absent on the row are cleared
 *  so switching FROM a session with data TO one without doesn't leave the
 *  previous capsule stale. Mirrors hydrateContextSnapshot's pattern. */
function hydrateCapsule(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, sessionId);
  const todos = sess?.todos ?? null;
  const subagents = sess?.subagents ?? null;
  const planDraft = sess?.planDraft ?? null;
  set((s) => {
    const todosBySession = { ...s.todosBySession };
    if (todos && Array.isArray(todos) && todos.length > 0) {
      todosBySession[sessionId] = todos as TodoItem[];
    } else {
      delete todosBySession[sessionId];
    }
    const subagentsBySession = { ...s.subagentsBySession };
    if (subagents && Array.isArray(subagents) && subagents.length > 0) {
      subagentsBySession[sessionId] = subagents;
    } else {
      delete subagentsBySession[sessionId];
    }
    const planBySession = { ...s.planBySession };
    if (planDraft && planDraft.phase !== "cleared" && planDraft.plan) {
      planBySession[sessionId] = planDraft as PlanDraft;
    } else {
      delete planBySession[sessionId];
    }
    return { todosBySession, subagentsBySession, planBySession };
  });
}

/** Hydrate the per-turn modified-files card from the session row. The card is
 *  persisted so it survives a session reopen. An absent/empty turnFiles on the
 *  row is cleared so switching FROM a session with a card TO one without
 *  doesn't leave the old card up. Mirrors hydrateCapsule's pattern. */
function hydrateTurnFiles(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, sessionId);
  const turnFiles = sess?.turnFiles ?? null;
  set((s) => {
    const next = { ...s.turnFilesBySession };
    if (turnFiles && Array.isArray(turnFiles) && turnFiles.length > 0) {
      next[sessionId] = turnFiles;
    } else {
      delete next[sessionId];
    }
    return { turnFilesBySession: next };
  });
}

export const useSessionStore = create<SessionState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessionsByProject: {},
  sessionsHasMoreByProject: {},
  sessionsTotalByProject: {},
  archivedSessionsByProject: {},
  sessions: [],
  activeSessionId: null,
  expandedProjects: {},
  archivedViewOpen: false,
  // openTabs is filled by `init` (lands on the first non-archived session,
  // if any) and by `startSession`. Defaulting to [] here means there's no
  // phantom active tab before hydration completes.
  openTabs: [],
  // Persisted in `settings` table; init() overwrites from the DB.
  displayMode: "single",
  // Persisted in `settings` table; init() overwrites from the DB. Defaults
  // mirror the CSS var defaults in styles.css (14px = text-sm).
  chatFontSize: 14,
  userMessageColor: null,
  accentColor: null,
  messagesBySession: {},
  runningBySession: {},
  claudeInstalled: null,
  settingsOpen: false,
  permissionMode: "default",
  model: "default",
  customModelId: null,
  customModels: EMPTY_CUSTOM_MODELS,
  effort: "high",
  todosBySession: {},
  planBySession: {},
  subagentsBySession: {},
  contextSnapshotBySession: {},
  pendingQuestionBySession: {},
  pendingApprovals: [],
  pendingPlanApprovalBySession: {},
  turnFilesBySession: {},

  init: async () => {
    // Per-thread config (model / effort / permissionMode / customModelId) is
    // hydrated by `selectSession` from the session row, not from a global
    // default. Initial slot values are placeholders for the brief moment
    // before the first `selectSession` call resolves; they get overwritten
    // immediately by `syncConfigFromSession`. Keeping `effort: "high"` as the
    // pre-hydration default preserves the existing "new sessions get the most
    // thinking" behavior for the corner case where there's no first session.
    const health = await api.claudeHealthCheck();
    set({ claudeInstalled: health.installed });
    // Load custom-model configs early so the model dropdown can offer them.
    void get().reloadCustomModels();

    // Hydrate displayMode from the settings table (default = "single"). Done
    // before the project/session load so the first render with the right
    // center-pane layout; falls back to "single" if the read fails.
    try {
      const { value } = await api.setting.get({ key: DISPLAY_MODE_SETTING_KEY });
      if (value === "single" || value === "tabs") {
        set({ displayMode: value });
      }
    } catch (err) {
      console.error("setting.get(displayMode) failed:", err);
    }

    // Hydrate the appearance settings (font size, user-message bg color,
    // and global accent color). All three are optional — missing/invalid
    // values leave the store defaults in place. lib/appearance.ts picks
    // these up and writes the corresponding CSS vars on <html> so the first
    // paint uses the right values (no flash of the default font size / color).
    try {
      const [fontRes, colorRes, accentRes] = await Promise.all([
        api.setting.get({ key: UI_CHAT_FONT_SIZE_SETTING_KEY }),
        api.setting.get({ key: UI_USER_MSG_COLOR_SETTING_KEY }),
        api.setting.get({ key: UI_ACCENT_COLOR_SETTING_KEY }),
      ]);
      if (fontRes.value != null) {
        const px = Number(fontRes.value);
        if (Number.isFinite(px)) set({ chatFontSize: clampFontSize(px) });
      }
      // Accept only well-formed "R G B" triplets; anything else (incl.
      // empty string) is treated as "use theme default" → null.
      if (colorRes.value && RGB_TRIPLET_RE.test(colorRes.value)) {
        set({ userMessageColor: colorRes.value });
      }
      if (accentRes.value && RGB_TRIPLET_RE.test(accentRes.value)) {
        set({ accentColor: accentRes.value });
      }
    } catch (err) {
      console.error("setting.get(appearance) failed:", err);
    }

    const { projects } = await api.project.list();
    set({ projects });

    if (projects.length === 0) return;

    // Eagerly load the FIRST page of active sessions for every project so
    // the tree renders without a round-trip per expand. The archived bin is
    // also pre-fetched (grouped by project) so the bottom section is ready.
    // Both are local SQLite reads, so this stays instant.
    const byProject: Record<string, Session[]> = {};
    const hasMoreByProject: Record<string, boolean> = {};
    const totalByProject: Record<string, number> = {};
    const archivedByProject: Record<string, Session[]> = {};
    await Promise.all(
      projects.map(async (p) => {
        const active = await api.project.sessions({
          projectId: p.id,
          limit: SESSION_PAGE_SIZE,
          offset: 0,
          archived: false,
        });
        byProject[p.id] = active.sessions;
        hasMoreByProject[p.id] = active.hasMore;
        totalByProject[p.id] = active.total;
        // Archived threads power the bottom "已归档" bin — fetch all (no
        // pagination there). The handler unpaginates when archived:true.
        const archived = await api.project.sessions({
          projectId: p.id,
          archived: true,
        });
        if (archived.sessions.length > 0) {
          archivedByProject[p.id] = archived.sessions;
        }
      }),
    );

    // Pick the first non-archived project (fall back to the first project) and
    // its latest non-archived session as the landing target.
    const firstActive =
      projects.find((p) => !p.archived) ?? projects[0];
    const firstSessions = byProject[firstActive.id] ?? [];
    const firstSession = firstSessions.find((s) => !s.archived);

    set({
      sessionsByProject: byProject,
      sessionsHasMoreByProject: hasMoreByProject,
      sessionsTotalByProject: totalByProject,
      archivedSessionsByProject: archivedByProject,
      sessions: firstSessions,
      activeProjectId: firstActive.id,
      // Auto-expand the active project so its threads are visible on load.
      expandedProjects: { [firstActive.id]: true },
      // Seed the tab list with the landing session (if any). In `single`
      // mode this is informational; in `tabs` mode it shows the initial
      // open tab. Either way the user starts with a coherent state.
      openTabs: firstSession ? [firstSession.id] : [],
    });
    if (firstSession) {
      await get().selectSession(firstSession.id);
    }
  },

  addProjectFromFolder: async () => {
    const { path } = await api.pickFolder();
    if (!path) return null;
    const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
    const { project } = await api.project.create({ name, path });
    set((s) => ({
      projects: [...s.projects, project],
      sessionsByProject: { ...s.sessionsByProject, [project.id]: [] },
      sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [project.id]: false },
      sessionsTotalByProject: { ...s.sessionsTotalByProject, [project.id]: 0 },
      activeProjectId: project.id,
      sessions: [],
      activeSessionId: null,
      // Expand the newly added project.
      expandedProjects: { ...s.expandedProjects, [project.id]: true },
    }));
    return project.id;
  },

  /** Switch the active project and (re)load its session list from cache. */
  selectProject: async (projectId) => {
    const sessions = get().sessionsByProject[projectId] ?? [];
    // Pick the latest non-archived session of this project to land on.
    const next = sessions.find((s) => !s.archived);
    set((s) => ({
      activeProjectId: projectId,
      sessions,
      activeSessionId: next?.id ?? null,
      expandedProjects: { ...s.expandedProjects, [projectId]: true },
      // Switching projects is a hard reset of the tab strip — tabs belong to
      // a project, so we don't carry them across. The new project lands on
      // its own first session.
      openTabs: next ? [next.id] : [],
    }));
    if (next) {
      await get().selectSession(next.id);
    }
  },

  toggleProjectExpanded: (projectId) =>
    set((s) => ({
      expandedProjects: {
        ...s.expandedProjects,
        [projectId]: !s.expandedProjects[projectId],
      },
    })),

  setArchivedViewOpen: (open) => set({ archivedViewOpen: open }),

  /** Fetch the next page of active sessions for a project and append to the
   *  cached list. Updates `hasMore` / `total` from the server response so the
   *  "加载更多" affordance reflects the truth. No-op when nothing more to load. */
  loadMoreSessions: async (projectId) => {
    if (!get().sessionsHasMoreByProject[projectId]) return;
    const offset = (get().sessionsByProject[projectId] ?? []).length;
    const page = await api.project.sessions({
      projectId,
      limit: SESSION_PAGE_SIZE,
      offset,
      archived: false,
    });
    set((s) => {
      const prev = s.sessionsByProject[projectId] ?? [];
      // De-dup in case a session was created mid-fetch (newest-first means
      // newly-created rows would slide in ahead of the next page; we drop
      // any overlap by id rather than risk showing a row twice).
      const seen = new Set(prev.map((x) => x.id));
      const merged = [...prev, ...page.sessions.filter((x) => !seen.has(x.id))];
      const isActive = projectId === s.activeProjectId;
      return {
        sessionsByProject: { ...s.sessionsByProject, [projectId]: merged },
        sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: page.hasMore },
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: page.total },
        sessions: isActive ? merged : s.sessions,
      };
    });
  },

  startSession: async (projectIdArg) => {
    const projectId = projectIdArg ?? get().activeProjectId;
    if (!projectId) return;
    const { session } = await api.claude.startSession({
      projectId,
      model: get().model !== "default" ? get().model : undefined,
      effort: get().effort,
      permissionMode: get().permissionMode,
      customModelId: get().customModelId,
    });
    set((s) => {
      const prevList = s.sessionsByProject[projectId] ?? [];
      const nextByProject = { ...s.sessionsByProject, [projectId]: [session, ...prevList] };
      const isactive = projectId === s.activeProjectId;
      return {
        sessionsByProject: nextByProject,
        // A brand-new session sits at the head (newest created_at) and bumps
        // the active-thread total by one. `hasMore` flips on if the page now
        // exceeds SESSION_PAGE_SIZE — the load-more button reveals to fetch
        // the next page rather than growing the cache unbounded.
        sessionsTotalByProject: {
          ...s.sessionsTotalByProject,
          [projectId]: (s.sessionsTotalByProject[projectId] ?? 0) + 1,
        },
        sessionsHasMoreByProject: {
          ...s.sessionsHasMoreByProject,
          [projectId]: (s.sessionsTotalByProject[projectId] ?? 0) + 1 > SESSION_PAGE_SIZE,
        },
        sessions: isactive ? nextByProject[projectId] : s.sessions,
        activeProjectId: projectId,
        activeSessionId: session.id,
        expandedProjects: { ...s.expandedProjects, [projectId]: true },
        messagesBySession: { ...s.messagesBySession, [session.id]: [] },
        // New session lands as a fresh tab. If it was somehow already open
        // (e.g. a duplicate id — shouldn't happen) we don't double-add.
        openTabs: s.openTabs.includes(session.id) ? s.openTabs : [...s.openTabs, session.id],
      };
    });
  },

  /** Activate an existing session and load its persisted history.
   *  Per-thread config (model / effort / permissionMode / customModelId) is
   *  hydrated from the session row via `syncConfigFromSession` BEFORE the
   *  activeSessionId flip — that way the chip components see the right
   *  values on their next render and never show the previous thread's
   *  config as a flash while messages are still loading.
   *
   *  Pure focus switch: doesn't touch the tab strip or any per-session
   *  data buckets. The user can flip between already-open tabs (in
   *  `tabs` mode) or between arbitrary sessions (in `single` mode) with
   *  the same code path. */
  selectSession: async (sessionId) => {
    syncConfigFromSession(set, get, sessionId);
    hydrateContextSnapshot(set, get, sessionId);
    hydrateCapsule(set, get, sessionId);
    hydrateTurnFiles(set, get, sessionId);
    set({ activeSessionId: sessionId });
    if (get().messagesBySession[sessionId]) return;
    const { messages } = await api.session.messages({ sessionId });
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: fromRecords(messages) },
    }));
  },

  /** Open a session as a tab. Already-open tabs simply become active; new
   *  ones get appended. Both display modes call this; the difference is
   *  purely cosmetic (the tab strip only renders in `tabs` mode).
   *
   *  The full logic chain matches `selectSession` (sync config + load
   *  history) so the first time a tab opens, its messages show up. */
  openTab: async (sessionId) => {
    syncConfigFromSession(set, get, sessionId);
    hydrateContextSnapshot(set, get, sessionId);
    hydrateCapsule(set, get, sessionId);
    set((s) => ({
      activeSessionId: sessionId,
      // Append only if not already present; preserves the order in which
      // tabs were opened (newer tabs on the right).
      openTabs: s.openTabs.includes(sessionId) ? s.openTabs : [...s.openTabs, sessionId],
    }));
    if (!get().messagesBySession[sessionId]) {
      const { messages } = await api.session.messages({ sessionId });
      set((s) => ({
        messagesBySession: { ...s.messagesBySession, [sessionId]: fromRecords(messages) },
      }));
    }
  },

  /** Remove a session from the tab strip. If it was the active tab, the
   *  focus shifts to the previous tab (the one to the left), or if there
   *  is none, to the new tail. Closing the last tab leaves the center
   *  pane empty (rendered as the "no session" placeholder).
   *
   *  In-flight turns are NOT cancelled — they keep streaming in the
   *  background, the events still get bucketed by sessionId, and the
   *  user can re-open the tab to see the latest state. We only drop the
   *  tab from the strip; the underlying session row + runtime binding
   *  are untouched. */
  closeTab: (sessionId) => {
    set((s) => {
      const idx = s.openTabs.indexOf(sessionId);
      if (idx === -1) return {};
      const nextTabs = s.openTabs.filter((id) => id !== sessionId);
      let nextActive = s.activeSessionId;
      if (s.activeSessionId === sessionId) {
        // Prefer the tab to the left (idx - 1), or fall back to the new
        // tail (which used to be at idx). If neither exists, leave
        // activeSessionId null so the empty-state placeholder shows.
        if (nextTabs.length === 0) {
          nextActive = null;
        } else if (idx > 0) {
          nextActive = nextTabs[idx - 1];
        } else {
          nextActive = nextTabs[0];
        }
      }
      // If the new active tab changed, sync its config so the composer
      // chips reflect the right model/effort/permission.
      if (nextActive && nextActive !== s.activeSessionId) {
        // Defer to the set body: we can't call syncConfigFromSession
        // here because it uses the same `set`. Inline the same lookup.
        const sess = findSession(s.sessionsByProject, s.archivedSessionsByProject, nextActive);
        return {
          openTabs: nextTabs,
          activeSessionId: nextActive,
          model: sess?.model ?? s.model,
          effort: sess?.effort ?? s.effort,
          permissionMode: sess?.permissionMode ?? s.permissionMode,
          customModelId: sess?.customModelId ?? s.customModelId,
        };
      }
      return { openTabs: nextTabs, activeSessionId: nextActive };
    });
  },

  /** Hard-delete a project; its sessions + messages cascade-delete in the DB.
   *  If it was active, fall back to the first remaining project. */
  deleteProject: async (id) => {
    await api.project.delete({ id });
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== id);
      const sessionsByProject = { ...s.sessionsByProject };
      const archivedByProject = { ...s.archivedSessionsByProject };
      const totalByProject = { ...s.sessionsTotalByProject };
      const hasMoreByProject = { ...s.sessionsHasMoreByProject };
      // Capture the deleted project's sessionIds BEFORE dropping the entries
      // so we can scrub them from the tab strip — both caches may hold rows.
      const removedSessionIds = new Set([
        ...(sessionsByProject[id] ?? []).map((sess) => sess.id),
        ...(archivedByProject[id] ?? []).map((sess) => sess.id),
      ]);
      delete sessionsByProject[id];
      delete archivedByProject[id];
      delete totalByProject[id];
      delete hasMoreByProject[id];
      const wasActive = s.activeProjectId === id;
      if (!wasActive) {
        // Still need to scrub any open tabs that belonged to the deleted
        // project (tabs the user may have opened earlier in a different
        // active project).
        const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
        const activeSessionId = openTabs.includes(s.activeSessionId ?? "")
          ? s.activeSessionId
          : (openTabs[0] ?? null);
        return {
          projects, sessionsByProject, archivedSessionsByProject: archivedByProject,
          sessionsTotalByProject: totalByProject, sessionsHasMoreByProject: hasMoreByProject,
          openTabs, activeSessionId,
        };
      }
      // Pick a new active project + its latest session.
      const next = projects.find((p) => !p.archived) ?? projects[0];
      const nextSessions = next ? (sessionsByProject[next.id] ?? []) : [];
      const nextSession = nextSessions.find((sess) => !sess.archived);
      // Tabs that belonged to other (still-living) projects survive; tabs
      // for the deleted project are gone.
      const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
      return {
        projects,
        sessionsByProject,
        archivedSessionsByProject: archivedByProject,
        sessionsTotalByProject: totalByProject,
        sessionsHasMoreByProject: hasMoreByProject,
        activeProjectId: next?.id ?? null,
        sessions: nextSessions,
        activeSessionId: nextSession?.id ?? null,
        openTabs: nextSession ? [nextSession.id] : openTabs,
      };
    });
  },

  /** Set a project's archived flag (soft-delete; restorable from the archived view). */
  archiveProject: async (id, archived) => {
    const { project } = await api.project.archive({ id, archived });
    set((s) => {
      const projects = s.projects.map((p) => (p.id === id ? project : p));
      // If we just archived the active project, jump to the next active one.
      const wasActive = s.activeProjectId === id;
      // Scrub tabs belonging to the archived project — archived sessions
      // shouldn't linger in the center pane.
      const removedSessionIds = new Set((s.sessionsByProject[id] ?? []).map((sess) => sess.id));
      const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
      if (!wasActive || !archived) {
        return { projects, openTabs };
      }
      const next = projects.find((p) => !p.archived);
      const nextSessions = next ? (s.sessionsByProject[next.id] ?? []) : [];
      const nextSession = nextSessions.find((sess) => !sess.archived);
      return {
        projects,
        activeProjectId: next?.id ?? null,
        sessions: nextSessions,
        activeSessionId: nextSession?.id ?? null,
        openTabs: nextSession ? [nextSession.id] : openTabs,
      };
    });
  },

  /** Hard-delete a session; its messages cascade-delete in the DB. The row is
   *  removed from whichever per-project cache currently holds it (active or
   *  archived). If it was active, fall back to the next session in the same
   *  project. */
  deleteSession: async (id) => {
    await api.session.delete({ id });
    set((s) => {
      // Find which project + cache owns this session.
      let projectId: string | undefined;
      let inArchived = false;
      for (const [pid, list] of Object.entries(s.sessionsByProject)) {
        if (list?.some((sess) => sess.id === id)) { projectId = pid; inArchived = false; break; }
      }
      if (!projectId) {
        for (const [pid, list] of Object.entries(s.archivedSessionsByProject)) {
          if (list?.some((sess) => sess.id === id)) { projectId = pid; inArchived = true; break; }
        }
      }
      if (!projectId) return {};
      const prevList = (inArchived ? s.archivedSessionsByProject : s.sessionsByProject)[projectId] ?? [];
      const nextList = prevList.filter((sess) => sess.id !== id);
      const sessionsByProject = { ...s.sessionsByProject };
      const archivedByProject = { ...s.archivedSessionsByProject };
      // Replace the touched cache. Empty archived cache entries are dropped
      // so the "已归档" bin doesn't render empty project groups.
      if (inArchived) {
        if (nextList.length > 0) archivedByProject[projectId] = nextList;
        else delete archivedByProject[projectId];
      } else {
        sessionsByProject[projectId] = nextList;
      }
      // Active-thread totals only move when an active (non-archived) row is
      // deleted; deleting an already-archived row doesn't change the active
      // count.
      const totalActive = inArchived
        ? (s.sessionsTotalByProject[projectId] ?? 0)
        : Math.max((s.sessionsTotalByProject[projectId] ?? 0) - 1, 0);
      const hasMoreActive = totalActive > nextList.length;
      // Also drop all per-session buckets for this id. The session is gone
      // for good; no point keeping its messages / running flag / question
      // / approval queue / files in memory.
      const messagesBySession = { ...s.messagesBySession };
      delete messagesBySession[id];
      const runningBySession = { ...s.runningBySession };
      delete runningBySession[id];
      const todosBySession = { ...s.todosBySession };
      delete todosBySession[id];
      const planBySession = { ...s.planBySession };
      delete planBySession[id];
      const subagentsBySession = { ...s.subagentsBySession };
      delete subagentsBySession[id];
      const pendingQuestionBySession = { ...s.pendingQuestionBySession };
      delete pendingQuestionBySession[id];
      const turnFilesBySession = { ...s.turnFilesBySession };
      delete turnFilesBySession[id];
      const contextSnapshotBySession = { ...s.contextSnapshotBySession };
      delete contextSnapshotBySession[id];
      const pendingPlanApprovalBySession = { ...s.pendingPlanApprovalBySession };
      delete pendingPlanApprovalBySession[id];
      const pendingApprovals = s.pendingApprovals.filter((p) => p.sessionId !== id);
      // Drop the session from the tab strip too. If it was the active tab,
      // the focus jumps to the previous tab (openTab logic replicated
      // inline since we're already in a `set` callback).
      const idx = s.openTabs.indexOf(id);
      const openTabs = idx === -1 ? s.openTabs : s.openTabs.filter((sid) => sid !== id);
      const wasActive = s.activeSessionId === id;
      if (!wasActive) {
        return {
          sessionsByProject,
          archivedSessionsByProject: archivedByProject,
          sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: totalActive },
          sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
          messagesBySession,
          runningBySession,
          todosBySession,
          planBySession,
          subagentsBySession,
          pendingQuestionBySession,
          turnFilesBySession,
          contextSnapshotBySession,
          pendingPlanApprovalBySession,
          pendingApprovals,
          openTabs,
        };
      }
      // Was the active tab. Land on the previous tab if any, otherwise the
      // new tail, otherwise null (empty-state placeholder).
      let nextActive: string | null = null;
      if (openTabs.length > 0) {
        nextActive = idx > 0 ? openTabs[idx - 1] : openTabs[0];
      }
      const isActiveProject = projectId === s.activeProjectId;
      const nextInProject = isActiveProject
        ? nextList.find((sess) => !sess.archived)
        : null;
      // If the new active session is the fallback one, sync its config
      // into the global slots so the composer chips show the right
      // model/effort/permission.
      const finalActive = nextActive ?? nextInProject?.id ?? null;
      const sess = finalActive ? findSession(sessionsByProject, archivedByProject, finalActive) : undefined;
      return {
        sessionsByProject,
        archivedSessionsByProject: archivedByProject,
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: totalActive },
        sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
        messagesBySession,
        runningBySession,
        todosBySession,
        planBySession,
        subagentsBySession,
        pendingQuestionBySession,
        turnFilesBySession,
        contextSnapshotBySession,
        pendingPlanApprovalBySession,
        pendingApprovals,
        openTabs: finalActive ? openTabs : openTabs,
        sessions: isActiveProject ? nextList : s.sessions,
        activeSessionId: finalActive,
        model: sess?.model ?? s.model,
        effort: sess?.effort ?? s.effort,
        permissionMode: sess?.permissionMode ?? s.permissionMode,
        customModelId: sess?.customModelId ?? s.customModelId,
      };
    });
  },

  /** Set a session's archived flag (soft-delete; restorable). The session
   *  MOVES between the active cache (`sessionsByProject`) and the archived
   *  cache (`archivedSessionsByProject`) of its project so each list only
   *  contains rows in the matching state — the left-bar tree renders active
   *  threads inline under the project, and archived threads in the bottom
   *  "已归档" bin, also grouped by project. Totals are recomputed from the
   *  server response so `hasMore` / the load-more button stay accurate. */
  archiveSession: async (id, archived) => {
    const { session } = await api.session.archive({ id, archived });
    set((s) => {
      const projectId = session.projectId;
      const isActiveProject = projectId === s.activeProjectId;

      // Pull the row out of whichever cache currently holds it and push the
      // server-fresh copy into the opposite cache. Newest-first ordering is
      // preserved by inserting at the head (the API returns DESC by created_at,
      // and these archive flips don't change created_at).
      const oldActive = s.sessionsByProject[projectId] ?? [];
      const oldArchived = s.archivedSessionsByProject[projectId] ?? [];
      let nextActive: Session[];
      let nextArchived: Session[];
      if (archived) {
        nextActive = oldActive.filter((x) => x.id !== id);
        nextArchived = [session, ...oldArchived.filter((x) => x.id !== id)];
      } else {
        nextArchived = oldArchived.filter((x) => x.id !== id);
        nextActive = [session, ...oldActive.filter((x) => x.id !== id)];
      }
      const sessionsByProject = { ...s.sessionsByProject, [projectId]: nextActive };
      const archivedByProject = { ...s.archivedSessionsByProject };
      if (nextArchived.length > 0) {
        archivedByProject[projectId] = nextArchived;
      } else {
        delete archivedByProject[projectId];
      }
      // Keep the active-thread totals in lockstep with the cache move. The
      // archive cache isn't paginated, so no hasMore/total tracking needed
      // there.
      const totalActive = (s.sessionsTotalByProject[projectId] ?? 0) + (archived ? -1 : 1);
      const hasMoreActive = totalActive > nextActive.length;

      // Archived sessions shouldn't stay open in the tab strip — the user
      // archived them, they don't want to see them in the center pane.
      const idx = s.openTabs.indexOf(id);
      const openTabs = archived && idx !== -1 ? s.openTabs.filter((sid) => sid !== id) : s.openTabs;
      const wasActive = s.activeSessionId === id;
      if (!isActiveProject || !wasActive || !archived) {
        return {
          sessionsByProject,
          archivedSessionsByProject: archivedByProject,
          sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: Math.max(totalActive, 0) },
          sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
          sessions: isActiveProject ? nextActive : s.sessions,
          openTabs,
        };
      }
      // Archived the active session → jump to the next visible one.
      const next = nextActive.find((sess) => !sess.archived);
      let nextActiveId: string | null = next?.id ?? null;
      // If the new active was the previous tab (idx > 0), keep that; else
      // fall back to the new tail of the now-shortened list.
      if (openTabs.length > 0) {
        nextActiveId = idx > 0 ? openTabs[idx - 1] : openTabs[0];
      }
      const sess = nextActiveId
        ? findSession(sessionsByProject, archivedByProject, nextActiveId)
        : undefined;
      return {
        sessionsByProject,
        archivedSessionsByProject: archivedByProject,
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: Math.max(totalActive, 0) },
        sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
        sessions: nextActive,
        openTabs,
        activeSessionId: nextActiveId,
        model: sess?.model ?? s.model,
        effort: sess?.effort ?? s.effort,
        permissionMode: sess?.permissionMode ?? s.permissionMode,
        customModelId: sess?.customModelId ?? s.customModelId,
      };
    });
  },

  sendPrompt: async (prompt) => {
    const sessionId = get().activeSessionId;
    if (!sessionId || !prompt.trim()) return;
    // Per-thread guard: only block this thread from sending if IT is running.
    // Another thread's running turn shouldn't lock the composer in this one.
    if (get().runningBySession[sessionId]) return;

    // 1. immediately show the user's message
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks: [{ kind: "text", text: prompt }],
      createdAt: Date.now(),
    };
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg],
      },
      runningBySession: { ...s.runningBySession, [sessionId]: true },
    }));

	    // 2. fire the turn; events stream back via ingestEvent. Ship the
	    //    current model / customModelId / effort / permissionMode from the
	    //    store as per-turn overrides — the DB row may be stale because
	    //    `setModel` / `setCustomModel` persist via fire-and-forget
	    //    `updateSettings`, which races `sendTurn`. The main handler
	    //    applies these overrides to the in-memory session so
	    //    RuntimeManager always sees the latest UI state.
	    const { model, customModelId, effort, permissionMode } = get();
	    const { session: updated } = await api.claude.sendTurn({
	      sessionId,
	      prompt,
	      model,
	      effort,
	      permissionMode,
	      customModelId,
	    });
    set((s) => {
      const pid = updated.projectId;
      const prevList = s.sessionsByProject[pid] ?? [];
      const nextList = prevList.map((sess) => (sess.id === updated.id ? updated : sess));
      return {
        sessionsByProject: { ...s.sessionsByProject, [pid]: nextList },
        sessions: pid === s.activeProjectId ? nextList : s.sessions,
      };
    });
  },

  interrupt: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await api.claude.interrupt({ sessionId });
    // Clear only the interrupted thread's flag. The `turn.done` (with reason
    // "interrupted") event from main will also clear it; doing it here too
    // is a defensive in case the event races with the user click.
    set((s) => ({ runningBySession: { ...s.runningBySession, [sessionId]: false } }));
  },

  ingestEvent: (e) => {
    const sid = e.sessionId;

    // todo.update is an independent state slice — handle and skip the
    // message-accumulation logic below.
    if (e.type === "todo.update") {
      set((s) => ({ todosBySession: { ...s.todosBySession, [sid]: e.todos } }));
      return;
    }
    // plan.update: drives the Plan section of the activity capsule. Phase
    // "cleared" with empty plan = not in plan mode (capsule hides section).
    if (e.type === "plan.update") {
      set((s) => ({
        planBySession: {
          ...s.planBySession,
          [sid]: { plan: e.plan, phase: e.phase },
        },
      }));
      return;
    }
    // subagent.update: REPLACE semantics — swap the full roster.
    if (e.type === "subagent.update") {
      set((s) => ({ subagentsBySession: { ...s.subagentsBySession, [sid]: e.agents } }));
      return;
    }
    // token-usage.updated: replace this session's context snapshot. The
    // adapter already normalized everything (usedTokens / maxTokens / pct /
    // warning), so we just store + the chip renders. Main also persists this
    // to the session row, so it round-trips on reload via hydrateContextSnapshot.
    if (e.type === "token-usage.updated") {
      set((s) => ({
        contextSnapshotBySession: { ...s.contextSnapshotBySession, [sid]: e.snapshot },
      }));
      return;
    }
    if (e.type === "question.ask") {
      set((s) => ({
        pendingQuestionBySession: {
          ...s.pendingQuestionBySession,
          [sid]: { questions: e.questions, requestId: e.requestId },
        },
      }));
      return;
    }
    if (e.type === "approval.request") {
      // Mirror the main-side ApprovalBridge queue: head = element 0.
      // De-dup by requestId so a re-emitted event doesn't double-push.
      set((s) => ({
        pendingApprovals: [
          ...s.pendingApprovals.filter((p) => p.requestId !== e.requestId),
          e,
        ],
      }));
      return;
    }
    if (e.type === "plan.approval_request") {
      // ExitPlanMode: the model drafted a plan and is awaiting the user's
      // approve/reject decision. One-at-a-time per session (the model calls
      // ExitPlanMode once per plan). REPLACE so a re-emit doesn't stack.
      set((s) => ({
        pendingPlanApprovalBySession: {
          ...s.pendingPlanApprovalBySession,
          [sid]: e,
        },
      }));
      return;
    }
    if (e.type === "turn.files") {
      // Per-session bucket: a turn.files event for session A does not
      // clobber session B's rewind card. Replaces only the entry for
      // this session.
      set((s) => ({ turnFilesBySession: { ...s.turnFilesBySession, [sid]: e.files } }));
      return;
    }
    if (e.type === "turn.rewound") {
      // Clear only this session's rewind card. Other tabs keep theirs.
      set((s) => ({ turnFilesBySession: { ...s.turnFilesBySession, [sid]: [] } }));
      return;
    }

    set((s) => {
      const list = s.messagesBySession[sid] ?? [];
      let next: ChatMessage[] = list;

      switch (e.type) {
        case "text.delta": {
          let msg = findMsg(next, e.messageId);
          if (!msg) {
            // Is this the first assistant block of a new turn? If the last
            // message is a user prompt (or there are no assistant messages
            // yet), stamp turnMeta so the renderer can show the per-turn
            // "started at · duration" row above this message.
            // Is this the first assistant block of a NEW turn? A turn is
            // "open" while any assistant message has a turnMeta with no
            // endedAt (i.e. turn.done hasn't landed yet). If no open turn
            // exists, this delta starts a fresh one — stamp turnMeta so
            // the renderer shows the per-turn stat row above this message.
            // Past turns' messages still carry their (now-ended) turnMeta,
            // so we must check endedAt, not just presence.
            const isNewTurn = !next.some(
              (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
            );
            msg = {
              id: e.messageId,
              sessionId: sid,
              role: "assistant",
              blocks: [],
              createdAt: Date.now(),
              ...(isNewTurn ? { turnMeta: { startedAt: Date.now() } } : {}),
            };
            next = [...next, msg];
          }
          const lastBlock = msg.blocks[msg.blocks.length - 1];
          if (lastBlock && lastBlock.kind === "text") {
            const updatedMsg = { ...msg, blocks: [...msg.blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + e.text }] };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          } else {
            const updatedMsg = { ...msg, blocks: [...msg.blocks, { kind: "text", text: e.text } as Block] };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          }
          break;
        }
        case "thinking": {
          let msg = findMsg(next, e.messageId);
          if (!msg) {
            // Is this the first assistant block of a NEW turn? A turn is
            // "open" while any assistant message has a turnMeta with no
            // endedAt (i.e. turn.done hasn't landed yet). If no open turn
            // exists, this delta starts a fresh one — stamp turnMeta so
            // the renderer shows the per-turn stat row above this message.
            // Past turns' messages still carry their (now-ended) turnMeta,
            // so we must check endedAt, not just presence.
            const isNewTurn = !next.some(
              (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
            );
            msg = {
              id: e.messageId,
              sessionId: sid,
              role: "assistant",
              blocks: [],
              createdAt: Date.now(),
              ...(isNewTurn ? { turnMeta: { startedAt: Date.now() } } : {}),
            };
            next = [...next, msg];
          }
          const lastBlock = msg.blocks[msg.blocks.length - 1];
          if (lastBlock && lastBlock.kind === "thinking") {
            const updatedMsg = { ...msg, blocks: [...msg.blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + e.text }] };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          } else {
            const updatedMsg = { ...msg, blocks: [...msg.blocks, { kind: "thinking", text: e.text } as Block] };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          }
          break;
        }
        case "tool.use": {
          let lastAssistant = [...next].reverse().find((m) => m.role === "assistant");
          if (!lastAssistant) {
            // Is this the first assistant block of a NEW turn? A turn is
            // "open" while any assistant message has a turnMeta with no
            // endedAt (i.e. turn.done hasn't landed yet). If no open turn
            // exists, this delta starts a fresh one — stamp turnMeta so
            // the renderer shows the per-turn stat row above this message.
            // Past turns' messages still carry their (now-ended) turnMeta,
            // so we must check endedAt, not just presence.
            const isNewTurn = !next.some(
              (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
            );
            lastAssistant = {
              id: `a_${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              blocks: [],
              createdAt: Date.now(),
              ...(isNewTurn ? { turnMeta: { startedAt: Date.now() } } : {}),
            };
            next = [...next, lastAssistant];
          }
          const block: Block = { kind: "tool_use", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input, status: "running" };
          const updated = { ...lastAssistant, blocks: [...lastAssistant.blocks, block] };
          next = next.map((m) => (m.id === lastAssistant!.id ? updated : m));
          break;
        }
        case "tool.result": {
          next = next.map((m) => {
            const hasBlock = m.blocks.some((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
            if (!hasBlock) return m;
            return {
              ...m,
              blocks: m.blocks.map((b) =>
                b.kind === "tool_use" && b.toolCallId === e.toolCallId
                  ? { ...b, status: e.isError ? "error" : "done", result: e.content }
                  : b,
              ),
            };
          });
          break;
        }
        case "error": {
          next = [...next, { id: `err_${Date.now()}`, sessionId: sid, role: "assistant", blocks: [{ kind: "error", message: e.message }], createdAt: Date.now() }];
          // An error terminates the turn just like turn.done — stamp the
          // end time so the duration row freezes.
          const errEndedAt = Date.now();
          next = next.map((m) =>
            m.turnMeta && m.turnMeta.endedAt === undefined
              ? { ...m, turnMeta: { ...m.turnMeta, endedAt: errEndedAt } }
              : m,
          );
          set((s) => ({
            runningBySession: { ...s.runningBySession, [sid]: false },
            // Only drop approvals + files belonging to this session; the
            // head pendingApprovals is per-session already, but it's a
            // flat array — filter down to the affected one.
            pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid),
            turnFilesBySession: { ...s.turnFilesBySession, [sid]: [] },
          }));
          break;
        }
        case "turn.done": {
          // Close out any tool_use still "running": the turn ended without a
          // matching tool.result (plan mode, or interrupted).
          next = next.map((m) => ({
            ...m,
            blocks: m.blocks.map((b) =>
              b.kind === "tool_use" && b.status === "running"
                ? { ...b, status: "done" as const, result: b.result ?? "(no result — turn ended)" }
                : b,
            ),
          }));
          // Stamp the turn's end time on its first assistant message so
          // the per-turn "工作时长" stat row freezes (stops ticking live).
          const endedAt = Date.now();
          next = next.map((m) =>
            m.turnMeta && m.turnMeta.endedAt === undefined
              ? { ...m, turnMeta: { ...m.turnMeta, endedAt } }
              : m,
          );
          // Any pending approvals are stale: the turn ended, the SDK won't
          // be waiting on them anymore. Drop the queue for this session so
          // a stale card doesn't linger in another tab's composer.
          // turnFilesBySession is NOT cleared here — the `turn.files` event
          // already arrived (immediately before turn.done via flushFinal)
          // and populated it. Clearing here would race with that and could
          // wipe the file list mid-event. The `turn.rewound` event is
          // what clears it on user rewind.
          //
          // Activity-capsule state (plan draft, subagent roster) is also
          // wiped here. The adapter normally emits `plan.update phase:cleared`
          // and final `subagent.update` events before turn.done, so this
          // is a defensive net for turns where neither was active (e.g.
          // a pure Q&A turn that never spawned anything). Either way, the
          // next turn starts with a clean capsule.
          set((s) => {
            const { [sid]: _dropPlan, ...restPlanApprovals } = s.pendingPlanApprovalBySession;
            return {
              runningBySession: { ...s.runningBySession, [sid]: false },
              pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid),
              pendingPlanApprovalBySession: restPlanApprovals,
              planBySession: { ...s.planBySession, [sid]: { plan: "", phase: "cleared" } },
              subagentsBySession: { ...s.subagentsBySession, [sid]: [] },
            };
          });
          break;
        }
        default:
          break;
      }

      return { messagesBySession: { ...s.messagesBySession, [sid]: next } };
    });

    // At terminal events the snapshot is final — persist it so the history
    // survives restart. Fire-and-forget; don't block the UI.
    if (e.type === "turn.done" || e.type === "error") {
      const snapshot = get().messagesBySession[sid];
      if (snapshot) {
        void api.session.saveMessages({ sessionId: sid, messages: toRecords(sid, snapshot) });
      }
    }
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  /** Update the center-pane display mode. The local store flips
   *  immediately so the layout change is instant; the DB write is
   *  fire-and-forget so a failed write doesn't block the UI. On the
   *  next app start, `init` re-hydrates from the `settings` table. */
  setDisplayMode: async (mode) => {
    set({ displayMode: mode });
    try {
      await api.setting.set({ key: DISPLAY_MODE_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(displayMode) failed:", err);
    }
  },

  setChatFontSize: async (px) => {
    const clamped = clampFontSize(px);
    set({ chatFontSize: clamped });
    try {
      await api.setting.set({
        key: UI_CHAT_FONT_SIZE_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(chatFontSize) failed:", err);
    }
  },

  setUserMessageColor: async (rgb) => {
    // null or malformed → treat as "use theme default" and clear any stored
    // value so the default re-asserts cleanly on reload.
    const safe = rgb && RGB_TRIPLET_RE.test(rgb) ? rgb : null;
    set({ userMessageColor: safe });
    try {
      await api.setting.set({
        key: UI_USER_MSG_COLOR_SETTING_KEY,
        value: safe ?? "",
      });
    } catch (err) {
      console.error("setting.set(userMessageColor) failed:", err);
    }
  },

  setAccentColor: async (rgb) => {
    // Same normalization as setUserMessageColor: null or malformed → clear
    // the override so the per-theme --accent default re-asserts.
    const safe = rgb && RGB_TRIPLET_RE.test(rgb) ? rgb : null;
    set({ accentColor: safe });
    try {
      await api.setting.set({
        key: UI_ACCENT_COLOR_SETTING_KEY,
        value: safe ?? "",
      });
    } catch (err) {
      console.error("setting.set(accentColor) failed:", err);
    }
  },

  /** Persist the active session's permission mode. The local slot is updated
   *  immediately so the chip reflects the change without a round-trip; the
   *  DB write is fire-and-forget — if it fails, the next `selectSession`
   *  (or app restart) will re-hydrate from the row. */
  setPermissionMode: (mode) => {
    const sessionId = get().activeSessionId;
    set({ permissionMode: mode });
    if (sessionId) {
      void api.session.updateSettings({ sessionId, permissionMode: mode }).catch((err) => {
        console.error("updateSettings(permissionMode) failed:", err);
      });
    }
  },

  /** Persist the active session's model. See `setPermissionMode` for the
   *  optimistic-local / fire-and-forget pattern. */
  setModel: (model) => {
    const sessionId = get().activeSessionId;
    set({ model });
    if (sessionId) {
      void api.session.updateSettings({ sessionId, model }).catch((err) => {
        console.error("updateSettings(model) failed:", err);
      });
    }
  },
  /** Persist the active session's reasoning effort. See `setPermissionMode`
   *  for the pattern. */
  setEffort: (effort) => {
    const sessionId = get().activeSessionId;
    set({ effort });
    if (sessionId) {
      void api.session.updateSettings({ sessionId, effort }).catch((err) => {
        console.error("updateSettings(effort) failed:", err);
      });
    }
  },

  /** Pick a built-in model or one of a custom-config's roles. Both
   *  `customModelId` and `model` (the role key) are part of the session's
   *  persisted config, so a single updateSettings patch covers the change. */
  setCustomModel: (id, roleArg) => {
    set((s) => {
      let nextModel: string;
      if (!id) {
        nextModel = "default";
      } else if (roleArg) {
        // Caller picked a specific role (e.g. "sonnet"); trust it.
        nextModel = roleArg;
      } else {
        // No role given — fall back to the config's first bound role so the
        // chip/dropdown shows something meaningful. If none is bound (shouldn't
        // happen for a saved config), fall back to "default".
        const cfg = s.customModels.find((m) => m.id === id);
        const firstBound = cfg
          ? (CUSTOM_MODEL_ROLES.find((r) => cfg.roles[r]?.requestModel?.trim()) ?? "default")
          : "default";
        nextModel = firstBound;
      }
      return { customModelId: id, model: nextModel };
    });
    // Persist the new binding + role to the session row. We compute the
    // resolved model from the same logic as above (re-read post-set to be
    // sure) and send both fields in one patch.
    const sessionId = get().activeSessionId;
    if (sessionId) {
      const { model, customModelId } = get();
      void api.session.updateSettings({ sessionId, model, customModelId }).catch((err) => {
        console.error("updateSettings(customModel) failed:", err);
      });
    }
  },

  reloadCustomModels: async () => {
    try {
      const { models } = await api.customModel.list();
      set({ customModels: models });
    } catch (err) {
      console.error("reloadCustomModels failed:", err);
    }
  },

  dismissQuestion: () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.pendingQuestionBySession;
      return { pendingQuestionBySession: rest };
    });
  },

  /** Submit the user's answers to the active session's pending
   *  AskUserQuestion. Resolves the provider's pending user-input Deferred
   *  via `claude:respondQuestion` so the SAME turn continues — this is the
   *  fix for the old bug where submitting answers started a *new* turn
   *  (via sendPrompt) instead of resuming the in-flight one.
   *
   *  `requestId` correlation: the question.ask event carried a requestId;
   *  we pass it back so main finds the right Deferred. Sentinel-fallback
   *  requests (no Deferred on the main side) are handled by main — it
   *  composes the answers into a follow-up prompt. Either way we clear
   *  the local pending card; if the IPC fails the card stays so the user
   *  can retry. */
  submitQuestion: async (answers) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const pending = get().pendingQuestionBySession[sessionId];
    if (!pending) return;
    const requestId = pending.requestId ?? `sentinel_${sessionId}_${Date.now()}`;
    try {
      await api.claude.respondQuestion({ sessionId, requestId, answers });
      // Only dismiss on success — a failed IPC leaves the card in place
      // so the user can retry instead of thinking they answered.
      set((s) => {
        const { [sessionId]: _drop, ...rest } = s.pendingQuestionBySession;
        return { pendingQuestionBySession: rest };
      });
    } catch (err) {
      console.error("claude.respondQuestion failed:", err);
    }
  },

  /** Approve or deny the head of the approval queue. The IPC resolves the
   *  matching canUseTool on the main side. Only on a successful resolve do
   *  we shift the head off — a failed IPC leaves the card in place so the
   *  user can retry instead of thinking they approved something they didn't. */
  decideApproval: async (requestId, granted, always) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    // Find the head matching this id (defensive — UI always passes head[0]).
    const head = get().pendingApprovals.find((p) => p.requestId === requestId);
    if (!head) return;
    try {
      await api.claude.approve({ sessionId, requestId, granted, always });
    } catch (err) {
      // Don't shift on failure; surface the error to the console so the
      // user/dev can see it without a modal interrupting the queue flow.
      console.error("claude.approve failed:", err);
      return;
    }
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((p) => p.requestId !== requestId),
    }));
  },

  /** Submit the user's approve/reject decision on a pending ExitPlanMode
   *  plan. Calls `claude:respondPlanApproval` which resolves the provider's
   *  pending plan-approval Deferred — the SAME turn then continues (approve
   *  → SDK exits plan mode + starts executing; reject → SDK stays in plan
   *  mode, model revises). Clears the pending card on success; on failure
   *  the card stays so the user can retry. */
  submitPlanApproval: async (requestId, approved, editedPlan, reason) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const pending = get().pendingPlanApprovalBySession[sessionId];
    if (!pending || pending.requestId !== requestId) return;
    try {
      await api.claude.respondPlanApproval({ sessionId, requestId, approved, editedPlan, reason });
      set((s) => {
        const { [sessionId]: _drop, ...rest } = s.pendingPlanApprovalBySession;
        return { pendingPlanApprovalBySession: rest };
      });
    } catch (err) {
      console.error("claude.respondPlanApproval failed:", err);
    }
  },

  rewindTurn: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    if ((get().turnFilesBySession[sessionId] ?? []).length === 0) {
      // Nothing to rewind — defensive (UI shouldn't allow the click).
      return;
    }
    try {
      await api.claude.rewindTurn({ sessionId });
      // Don't optimistically clear turnFiles — wait for the `turn.rewound`
      // event from main so the UI only updates when files are actually
      // back on disk. If the IPC call returns successfully but main fails
      // partway through restore, the (smaller) restored list still
      // arrives via the event and we clear from there.
    } catch (err) {
      console.error("claude.rewindTurn failed:", err);
    }
  },

  refreshClaudeHealth: async () => {
    const health = await api.claudeHealthCheck();
    set({ claudeInstalled: health.installed });
  },
}));

// Stable empty arrays (e.g. EMPTY_MESSAGES, EMPTY_TODOS) are exported
// directly at their declaration site (see the "Stable empty arrays" block
// above) so they can be imported individually without a re-export step.
