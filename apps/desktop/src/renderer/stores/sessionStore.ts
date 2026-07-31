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
  UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
  UI_USER_MSG_COLOR_SETTING_KEY,
  UI_ACCENT_COLOR_SETTING_KEY,
  UI_RIGHT_PANEL_TAB_SETTING_KEY,
  UI_IDE_OPEN_FILES_SETTING_KEY,
  UI_IDE_ACTIVE_FILE_SETTING_KEY,
  UI_IDE_EXPANDED_DIRS_SETTING_KEY,
  UI_IDE_EDITOR_MODE_SETTING_KEY,
  UI_GIT_DIFF_OPEN_MODE_SETTING_KEY,
  UI_COMMIT_GEN_MODEL_SETTING_KEY,
  UI_COMMIT_GEN_PROMPT_SETTING_KEY,
  UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY,
  UI_GIT_COLLAPSED_REPOS_SETTING_KEY,
  UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY,
  UI_PANE_WIDTHS_SETTING_KEY,
  type DisplayMode,
  type RightPanelTab,
  type IdeEditorMode,
  type GitDiffOpenMode,
  type FileViewMode,
  type CustomCommand,
} from "@contracts/ipc";
import type { UserInputAnswers } from "@contracts/provider";

/** True for `.md` / `.markdown` files - used to default the editor into preview
 *  mode on first open. Kept here (not in lib/path) because it's a content-type
 *  decision, not a pure path operation. */
function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** A single content block within a message (mirrors how claude structures output). */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; toolName: string; input: unknown; status: "running" | "done" | "error"; result?: unknown }
  | { kind: "error"; message: string }
  | { kind: "attachment"; preview: string; content: string; attachmentKind?: "paste" | "file"; filePath?: string }
  | {
      kind: "plan";
      /** Stable id for the in-turn live plan block — "current" while the turn
       *  is streaming (single live plan per turn). Lets the store upsert /
       *  replace on each plan.update without spawning duplicate blocks. When
       *  the turn ends the block is frozen in place (its planId stays). */
      planId: string;
      /** The plan markdown text drafted by the model (EnterPlanMode →
       *  ExitPlanMode). Empty during the initial drafting phase before the
       *  model has produced any plan content. */
      plan: string;
      /** Lifecycle phase mirrored from PlanUpdateEvent: "drafting" while the
       *  model is still composing, "ready" once ExitPlanMode is approved,
       *  "cleared" is transient (handled as a remove, never persisted on a
       *  frozen block). */
      phase: PlanUpdateEvent["phase"];
      /** True while an ExitPlanMode approval is pending — drives the 待审阅
       *  badge on the inline card so it mirrors the composer approval sheet. */
      hasApproval?: boolean;
    }
  | {
      kind: "turn-files";
      /** Stable id for the in-turn live turn-files block — "current" while the
       *  turn is streaming. Same pattern as the plan block's planId: lets the
       *  store upsert/replace on each turn.files event without spawning
       *  duplicates. Stays on the block after the turn freezes. */
      filesId: string;
      /** Files touched in this turn (filePath / kind / adds / dels / before).
       *  Mirrors TurnFileEntry verbatim — the same shape crosses the
       *  turn.files event, the persisted block, and the TurnFilesCard props,
       *  so the card renders identically live and from-DB. */
      files: TurnFileEntry[];
      /** True ONLY on the LATEST turn's card — gates whether the 撤销本轮
       *  button renders. The most recent completed turn's card keeps this
       *  true (rewindable via the in-memory FileSnapshot); every older turn's
       *  card is read-only (historical snapshot, no rewind). Demoted to false
       *  the moment a new turn opens. */
      isLatestTurn?: boolean;
    };

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

/** One finalized turn's usage, appended to `usageHistoryBySession` at
 *  turn.done. Mirrors the scalar fields of ContextSnapshot so the history
 *  view can render each turn's tokens/cost without keeping the full
 *  snapshot (warnings etc. are turn-live-only). */
export interface TurnUsageRecord {
  /** Wall-clock ms when the turn finalized (turnMeta.endedAt). */
  endedAt: number;
  /** Duration of the turn in ms (endedAt − startedAt). */
  durationMs: number;
  /** Tokens processed this turn (input + output + cache). */
  totalProcessedTokens: number;
  /** Output tokens this turn. */
  outputTokens: number;
  /** Tokens read from cache this turn (0 if none). */
  cacheReadTokens: number;
  /** Tokens written to cache this turn (0 if none). */
  cacheCreationTokens: number;
  /** Estimated USD cost this turn, if known. */
  costUsd?: number;
  /** Window occupancy AFTER this turn (cumulative context size). */
  usedTokens: number;
  /** Active model for this turn, if known. */
  model?: string;
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

/** One open diff tab inside the Git diff dialog (the "dialog" open-mode).
 *  `id` is a stable client-side id used as the React key + dedup key; we reuse
 *  the absolute file path so re-clicking the same file refreshes its tab
 *  instead of opening a duplicate. */
export interface GitDiffDialogTab {
  /** Stable id. Working-tree: `${absPath}::staged|work`; history: absPath
   *  (or commit-scoped id from the history view). Used as the dedup key. */
  id: string;
  /** Absolute path of the file being diffed. */
  filePath: string;
  /** Original-side content (the "before" blob). */
  before: string;
  /** Modified-side content. When omitted, DiffPane reads the working-tree
   *  file from disk (working-tree diffs). History / staged diffs supply both. */
  after?: string;
  /** Short label for the tab (file basename). */
  title: string;
  /** Repo the file belongs to (for context / grouping). */
  repoPath: string;
  /** Where the diff came from - working tree vs a history commit. */
  source: "working" | "history";
  /** For working-tree diffs: whether this is the staged (index) side.
   *  Staged and unstaged views of the same file are distinct tabs. */
  staged?: boolean;
}

export interface SessionState {
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
  /** Global side-panel + settings font size in px (10–22). Despite the
   *  legacy field name, this drives the whole app chrome: the left project
   *  bar, the right files/git/terminal panels, AND the settings page all
   *  inherit it. Persisted in the `settings` table. Applied to <html> as the
   *  --right-panel-font-size CSS var (plus --rp-fs-* derived variants) by
   *  lib/appearance.ts, and also fed to the xterm terminal fontSize. */
  rightPanelFontSize: number;
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
  /** Per-session wall-clock ms stamped at send time - the time anchor for the
   *  "开始 · 用时" stat row BEFORE the first assistant content block arrives.
   *  Without this, the stat row only appears when the first delta/tool/plan
   *  lands (which can lag send by seconds while the model "thinks"), leaving
   *  the user with no running feedback. The three isNewTurn stamping sites
   *  (flushDeltas / tool.use / upsertLivePlanBlock) fall back to this value
   *  so the real turnMeta.continues the synthesized row's timing seamlessly.
   *  NOT persisted - it's transient: cleared on turn.done / error / interrupt
   *  / session delete, alongside runningBySession. */
  runningTurnStartedAt: Record<string, number>;
  claudeInstalled: boolean | null;
  /** Settings modal visibility (opened from the LeftBar ⚙ footer and the CLI-missing CTA). */
  settingsOpen: boolean;
  /** Command palette (Cmd/Ctrl+K) visibility. Toggled by the global hotkey
   *  wired in App.tsx and by any in-app "command palette" affordance. The
   *  palette itself (CommandPalette.tsx) reads this to mount/unmount. */
  commandPaletteOpen: boolean;
  /** Left sidebar visibility. Lifted from App.tsx local state so the
   *  command palette (and other store consumers) can toggle it. Workspace-only
   *  — the settings view pins it open. NOT persisted (matches original behavior). */
  leftOpen: boolean;
  /** Right (IDE) panel visibility. Lifted from App.tsx local state. NOT persisted.
   *  `ideFocusNonce` bumps still drive this to `true` (the App effect now
   *  calls setRightOpen(true) instead of touching local state). */
  rightOpen: boolean;
  /** Bottom terminal bar visibility. Lifted from App.tsx local state. NOT
   *  persisted. The bar stays mounted (keep-alive) regardless; this only
   *  controls whether it's expanded. */
  bottomTerminalOpen: boolean;
  /* ── Draggable pane sizes ──
   *  Persisted as one JSON blob (UI_PANE_WIDTHS_SETTING_KEY) and re-clamped
   *  on hydrate. Updated live during drag (synchronous set); the DB write is
   *  debounced so a drag doesn't hammer the settings table. */
  /** Left sidebar width in px. */
  leftWidth: number;
  /** Right IDE panel width in px. */
  rightWidth: number;
  /** Bottom terminal bar height in px (when expanded). */
  bottomTerminalHeight: number;
  /** Editor-column share of the center pane, as a percentage 0–100. The chat
   *  column gets the remainder. Only meaningful when a file is open. */
  editorWidthPct: number;
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
  /** Per-session, append-only log of finalized turn usage snapshots.
   *  Appended at `turn.done` from the latest ContextSnapshot, so each entry
   *  is the post-turn token/cost breakdown for one completed turn. Used by
   *  the activity capsule's "上下文消耗" section to show a per-turn history
   *  + a session total. Ephemeral (not persisted): a restart starts empty,
   *  same as todos/subagents. */
  usageHistoryBySession: Record<string, TurnUsageRecord[]>;
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

  /* ── IDE right-panel state ──
   *  Editor state (open files, active file, view mode, expanded tree dirs)
   *  is PER-PROJECT: switching to project B shows B's open files, and
   *  switching back to A restores A's. This mirrors the per-session bucket
   *  pattern (messagesBySession, todosBySession). Keyed by projectId.
   *
   *  A few IDE prefs remain global (not per-project) because they express a
   *  user preference, not project state: rightPanelTab, ideEditorMode,
   *  ideFocusNonce. */
  /** Active tab in the right panel. Persisted so reopening the app restores
   *  the last-used inspector. Only "files" is implemented in P4; the other
   *  three round-trip for forward-compat. */
  rightPanelTab: RightPanelTab;
  /** Per-project terminal quick-commands. Outer key = projectId, value = that
   *  project's saved commands. Persisted as a JSON object (keyed by projectId)
   *  in the settings table; read/written by the terminal toolbar's commands
   *  menu and the settings → terminal panel. */
  customCommandsByProject: Record<string, CustomCommand[]>;
  /** Per-project ordered list of absolute file paths open in the Monaco
   *  editor area. Drives the OpenTabsBar. Persisted as a JSON object keyed
   *  by projectId. */
  ideOpenFilesByProject: Record<string, string[]>;
  /** Per-project currently-active file (member of the project's open list,
   *  or null). Persisted as a JSON object keyed by projectId. */
  ideActiveFileByProject: Record<string, string | null>;
  /** Per-project per-file view mode ("diff" shows before-vs-current; "edit"
   *  is the normal editor). Outer key = projectId, inner key = filePath.
   *  NOT persisted — resets each session, since the `before` snapshot only
   *  exists for the latest turn anyway. */
  ideFileViewModeByProject: Record<string, Record<string, FileViewMode>>;
  /** How opening a file affects the open-file list:
   *   - "tabs"    (default): each file accumulates as a tab.
   *   - "replace": opening a file replaces whatever was open (≤1 file at a
   *     time). Persisted in the settings table. Global (not per-project). */
  ideEditorMode: IdeEditorMode;
  /** Where a git-diff click opens the diff viewer:
   *   - "center"  (default): center-area Monaco editor (existing behavior).
   *   - "dialog": a floating modal dialog with multiple diff tabs.
   *  Persisted in the settings table. Global (not per-project). */
  gitDiffOpenMode: GitDiffOpenMode;
  /** Diff tabs currently open in the Git diff dialog (the "dialog" open-mode).
   *  Ephemeral (NOT persisted) - restarting clears them. Dedup by file path. */
  gitDiffDialogTabs: GitDiffDialogTab[];
  /** Active tab id in the Git diff dialog, or null when none. Ephemeral. */
  gitDiffDialogActiveId: string | null;
  /** Whether the Git diff dialog is currently shown. Closing it keeps the
   *  tabs; the Git panel toolbar button re-opens it. Ephemeral. */
  gitDiffDialogOpen: boolean;
  /** How the Git diff dialog presents its open diff files:
   *   - "tabs"   (default): show a top tab strip + the left file list.
   *   - "single": hide the tab strip; navigate via the left file list only.
   *  Ephemeral (NOT persisted) - restarting resets to "tabs". */
  gitDiffDialogViewMode: "tabs" | "single";
  /** Per-project absolute directory paths expanded in the file tree.
   *  Persisted as a JSON object keyed by projectId so each project's tree
   *  re-opens to where the user left it. */
  ideExpandedDirsByProject: Record<string, string[]>;
  /** Per-project per-file git diff pair for the center Monaco DiffEditor.
   *  - Working-tree clicks stash `{ before }` only → DiffPane reads disk as after.
   *  - History clicks stash `{ before, after }` → DiffPane uses both blobs (no disk).
   *  Ephemeral (NOT persisted). Outer key = projectId, inner key = abs filePath. */
  gitDiffByProject: Record<string, Record<string, { before: string; after?: string }>>;
  /** Per-project per-file "open-as-diff" before-snapshot override. When a
   *  turn-files card opens a file for review it passes the card's frozen
   *  `before` (works for HISTORICAL turns too, whose snapshot is gone from
   *  turnFilesBySession). FileEditor uses this as a fallback diff source.
   *  Ephemeral (NOT persisted) - a stale before is harmless: the worst case
   *  is an outdated left pane until the user closes the file. */
  ideDiffBeforeByProject: Record<string, Record<string, string>>;
  /** Custom-model id used for git-commit-message generation, or null for
   *  built-in. Persisted in the settings table. */
  commitGenModel: string | null;
  /** Prompt template for commit-message generation. Persisted. Empty = use
   *  the built-in default (defined in the main-process handler). */
  commitGenPrompt: string;
  /** Custom-model id used for AI git-conflict resolution, or null for the
   *  built-in model. Stored as `"configId:roleKey"`. Persisted in the settings
   *  table; independent of commitGenModel so the two can use different models. */
  conflictResolveModel: string | null;
  /** Per-repo collapsed state in the Git panel. Persisted in the settings
   *  table as a JSON-encoded Record<string, boolean>. */
  collapsedGitRepos: Record<string, boolean>;
  /** Monotonically-increasing counter bumped whenever something requests the
   *  right panel's attention (e.g. the 审查 button on a turn-files card).
   *  App.tsx watches this via effect and opens the panel if collapsed —
   *  decoupling the store (which can't reach into App's local state) from
   *  the visibility toggle. */
  ideFocusNonce: number;

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
  /** Reorder the tab strip by moving the tab at `from` to index `to`.
   *  Pure order shuffle: activeSessionId is untouched, config sync is
   *  unaffected (it keys off the session row, not tab order), and the
   *  order is not persisted (openTabs is in-memory only). */
  reorderTab: (from: number, to: number) => void;
  deleteProject: (id: string) => Promise<void>;
  archiveProject: (id: string, archived: boolean) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  /** Rename a session (persist a user-edited title). Updates the row in
   *  `sessionsByProject` if it's in the loaded page slice, so the left bar
   *  + tab strip reflect the new title immediately. The store does NOT trim
   *  the title - the caller should pass a non-empty trimmed string. */
  renameSession: (id: string, title: string) => Promise<void>;
  sendPrompt: (
    prompt: string,
    attachments?: { preview: string; content: string; attachmentKind?: "paste" | "file"; filePath?: string }[],
    /** Text shown in the user message's text block. Defaults to `prompt`,
     *  but when attachments are present the caller passes just the typed
     *  text (without the inlined attachment content) so the card + text
     *  don't duplicate the same payload. The full `prompt` (with
     *  attachments inlined) is still what gets sent to the SDK. */
    displayText?: string,
  ) => Promise<void>;
  interrupt: () => Promise<void>;
  ingestEvent: (e: RuntimeEvent) => void;
  setSettingsOpen: (open: boolean) => void;
  /** Toggle the Cmd/Ctrl+K command palette open/closed. */
  setCommandPaletteOpen: (open: boolean) => void;
  /** Toggle the left sidebar open/closed (direct set). NOT persisted. */
  setLeftOpen: (open: boolean) => void;
  /** Toggle the right IDE panel open/closed (direct set). NOT persisted. */
  setRightOpen: (open: boolean) => void;
  /** Toggle the bottom terminal bar open/closed (direct set). NOT persisted. */
  setBottomTerminalOpen: (open: boolean) => void;
  /** Apply an incremental delta to the left sidebar width (clamped, then a
   *  debounced DB write). Called by the drag handle on every mousemove. */
  adjustLeftWidth: (deltaPx: number) => void;
  /** Apply an incremental delta to the right panel width. */
  adjustRightWidth: (deltaPx: number) => void;
  /** Apply an incremental delta to the bottom terminal height. */
  adjustBottomTerminalHeight: (deltaPx: number) => void;
  /** Apply an incremental delta to the editor-column percentage. The delta
   *  is in px; the caller converts to pct via the container width. */
  adjustEditorWidthPct: (deltaPx: number) => void;
  /** Reset a pane width to its default (double-click on the divider). */
  resetLeftWidth: () => void;
  resetRightWidth: () => void;
  resetBottomTerminalHeight: () => void;
  resetEditorWidthPct: () => void;
  /** Update the center-pane display mode. Persists to the `settings`
   *  table so the choice survives restart. */
  setDisplayMode: (mode: DisplayMode) => Promise<void>;
  /** Update the chat content font size (clamped to 12–20 px). Persists to
   *  the `settings` table. */
  setChatFontSize: (px: number) => Promise<void>;
  /** Update the right-panel base font size (clamped to 10–22 px). Persists
   *  to the `settings` table. */
  setRightPanelFontSize: (px: number) => Promise<void>;
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

  /* ── IDE right-panel actions ── */
  /** Switch the active right-panel tab. Persists to settings. */
  setRightPanelTab: (tab: RightPanelTab) => void;
  /** Replace a single project's saved terminal quick-commands. Persists the
   *  whole per-project map (JSON-encoded) to settings. Both the terminal
   *  commands menu (quick-add) and the settings -> terminal panel call this.
   *  No-op if `projectId` is null (no active project). */
  setCustomCommandsByProject: (projectId: string, commands: CustomCommand[]) => void;
  /** Append a new command to a project's list. Generates a stable id. */
  addCustomCommand: (projectId: string, cmd: Omit<CustomCommand, "id">) => void;
  /** Replace an existing command (matched by id) within a project's list. */
  updateCustomCommand: (projectId: string, cmd: CustomCommand) => void;
  /** Remove a command (matched by id) from a project's list. */
  removeCustomCommand: (projectId: string, id: string) => void;
  /** Open a file in the Monaco editor (dedup + append to ideOpenFiles, set
   *  active). `opts.diff` opens it in diff mode (used by the 审查 button when
   *  a before-snapshot exists). Also bumps ideFocusNonce so App opens the
   *  right panel if it's collapsed. */
  openFileInIde: (filePath: string, opts?: { diff?: boolean; before?: string }) => void;
  /** Remove a file from the editor's open list; active shifts to the
   *  previous file (or next, or null). */
  closeFileInIde: (filePath: string) => void;
  /** Set the active file (must already be open). */
  setIdeActiveFile: (filePath: string) => void;
  /** Set a file's view mode (edit/diff). */
  setIdeFileViewMode: (filePath: string, mode: FileViewMode) => void;
  /** Switch the editor open-mode (tabs vs replace). Persists. When switching
   *  to "replace", if more than one file is open, keeps only the active one. */
  setIdeEditorMode: (mode: IdeEditorMode) => void;
  /** Set the git-diff open-mode (center vs dialog). Persists to settings. */
  setGitDiffOpenMode: (mode: GitDiffOpenMode) => void;
  /** Open (or refresh) a diff tab in the Git diff dialog. Dedups by file path
   *  (re-clicking the same file refreshes its before/after and activates it),
   *  then opens the dialog. Ephemeral (not persisted). */
  openGitDiffDialogTab: (tab: GitDiffDialogTab) => void;
  /** Remove a diff tab from the Git diff dialog. If the active tab is closed,
   *  activation shifts to an adjacent tab; if none remain the dialog closes. */
  closeGitDiffDialogTab: (id: string) => void;
  /** Set the active diff tab in the Git diff dialog. */
  setGitDiffDialogActive: (id: string | null) => void;
  /** Show/hide the Git diff dialog. Closing keeps the tabs so they can be
   *  re-opened from the Git panel toolbar button. */
  setGitDiffDialogOpen: (open: boolean) => void;
  /** Set the Git diff dialog's view mode: "tabs" (tab strip + file list) or
   *  "single" (file list only, no tab strip). Ephemeral (not persisted). */
  setGitDiffDialogViewMode: (mode: "tabs" | "single") => void;
  /** Toggle a directory's expanded state in the file tree. Persists. */
  toggleDirExpanded: (dirPath: string) => void;
  /** Explicitly set a directory's expanded state. Persists. */
  setDirExpanded: (dirPath: string, open: boolean) => void;
  /** Write content to disk via file.writeFile. Returns ok. Does NOT touch
   *  editor state — the caller (FileEditor) keeps its own dirty tracking. */
  saveFileContent: (filePath: string, content: string) => Promise<boolean>;
  /** Stash a git diff "before" content for a file so the center editor can
   *  show a Monaco diff against the working tree. Keyed by the active project.
   *  Ephemeral. Equivalent to `setGitDiffPair(path, { before })`. */
  setGitDiffBefore: (filePath: string, before: string) => void;
  /** Stash a before/after pair for Monaco diff. When `after` is set the
   *  DiffPane uses it directly (history commits); when omitted it reads disk. */
  setGitDiffPair: (filePath: string, pair: { before: string; after?: string }) => void;
  /** Clear a file's git diff pair (e.g. after the file is staged or discarded). */
  clearGitDiffBefore: (filePath: string) => void;
  /** Set the custom-model id used for commit-message generation. Persists. */
  setCommitGenModel: (modelId: string | null) => void;
  /** Set the prompt template for commit-message generation. Persists. */
  setCommitGenPrompt: (prompt: string) => void;
  /** Set the custom-model id used for AI git-conflict resolution. Persists. */
  setConflictResolveModel: (modelId: string | null) => void;
  /** Toggle a git repo card's collapsed state. Persists. */
  toggleCollapsedGitRepo: (repoPath: string) => void;
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
/** Stable empty usage-history reference (selector must return a stable array). */
export const EMPTY_USAGE: TurnUsageRecord[] = [];
/** Stable cleared-plan reference — used both as the initial state and as
 * the "not in plan mode" placeholder returned by selectors. */
export const EMPTY_PLAN: PlanDraft = { plan: "", phase: "cleared" };

/**
 * Persist the per-project IDE buckets (open files / active file / expanded
 * dirs) to the settings table. Each is stored as a JSON object keyed by
 * projectId. Called after every IDE action that mutates a bucket — the write
 * is fire-and-forget (same pattern as setDisplayMode). `viewMode` is NOT
 * persisted here (it's ephemeral — see the field doc).
 *
 * Takes the full state snapshot so callers can pass `get()` right after a
 * `set()` without an extra read.
 */
function persistIdeBuckets(state: SessionState): void {
  void api.setting
    .set({
      key: UI_IDE_OPEN_FILES_SETTING_KEY,
      value: JSON.stringify(state.ideOpenFilesByProject),
    })
    .catch((err) => console.error("setting.set(ideOpenFiles) failed:", err));
  void api.setting
    .set({
      key: UI_IDE_ACTIVE_FILE_SETTING_KEY,
      value: JSON.stringify(state.ideActiveFileByProject),
    })
    .catch((err) => console.error("setting.set(ideActiveFile) failed:", err));
  void api.setting
    .set({
      key: UI_IDE_EXPANDED_DIRS_SETTING_KEY,
      value: JSON.stringify(state.ideExpandedDirsByProject),
    })
    .catch((err) => console.error("setting.set(ideExpandedDirs) failed:", err));
}

/** Min/max chat content font size (px). The slider in Settings uses the
 *  same bounds; setChatFontSize clamps to this range defensively. */
export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 20;

/** Clamp a font-size value to the allowed slider range. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return 14;
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, Math.round(px)));
}

/** Min/max right-panel (files / git / terminal) base font size (px). The
 *  slider in Settings uses the same bounds; setRightPanelFontSize clamps to
 *  this range defensively. */
export const RIGHT_PANEL_FONT_SIZE_MIN = 10;
export const RIGHT_PANEL_FONT_SIZE_MAX = 22;

/** Clamp a right-panel font-size value to the allowed slider range. */
export function clampRightPanelFontSize(px: number): number {
  if (!Number.isFinite(px)) return 14;
  return Math.min(
    RIGHT_PANEL_FONT_SIZE_MAX,
    Math.max(RIGHT_PANEL_FONT_SIZE_MIN, Math.round(px)),
  );
}

/* ─── Draggable pane-width bounds + clamps ───
 * Each pane's width is persisted (UI_PANE_WIDTHS_SETTING_KEY) and re-clamped
 * on hydrate so a corrupted/out-of-range stored value can't collapse a pane
 * below its usable minimum or stretch it past the screen. */

export const LEFT_WIDTH_MIN = 180;
export const LEFT_WIDTH_MAX = 500;
export const RIGHT_WIDTH_MIN = 240;
export const RIGHT_WIDTH_MAX = 640;
export const BOTTOM_TERMINAL_HEIGHT_MIN = 80;
export const BOTTOM_TERMINAL_HEIGHT_MAX = 600;
export const EDITOR_WIDTH_PCT_MIN = 20;
export const EDITOR_WIDTH_PCT_MAX = 80;

/** Clamp helper for the four persisted pane sizes. Falls back to defaults on
 *  any non-finite value so the layout never breaks. */
export function clampLeftWidth(px: number): number {
  if (!Number.isFinite(px)) return 280;
  return Math.min(LEFT_WIDTH_MAX, Math.max(LEFT_WIDTH_MIN, Math.round(px)));
}
export function clampRightWidth(px: number): number {
  if (!Number.isFinite(px)) return 360;
  return Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, Math.round(px)));
}
export function clampBottomTerminalHeight(px: number): number {
  if (!Number.isFinite(px)) return 280;
  return Math.min(
    BOTTOM_TERMINAL_HEIGHT_MAX,
    Math.max(BOTTOM_TERMINAL_HEIGHT_MIN, Math.round(px)),
  );
}
export function clampEditorWidthPct(pct: number): number {
  if (!Number.isFinite(pct)) return 50;
  return Math.min(EDITOR_WIDTH_PCT_MAX, Math.max(EDITOR_WIDTH_PCT_MIN, Math.round(pct)));
}

/** Matches a well-formed space-separated "R G B" triplet (0–255 each),
 *  e.g. "124 58 237". Used to validate the user-message color setting
 *  (which feeds the --user-bubble CSS var). */
const RGB_TRIPLET_RE = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/;

/** True if `abs` is inside `root` (prefix match on path segments, not a raw
 *  string prefix — so "/foo/bar" doesn't match root "/foo/ba"). Renderer-side
 *  mirror of main's `safeResolveOk`: used to filter persisted IDE paths at
 *  hydration time. Handles the root === abs case (a file/dir AT the root). */
function isPathWithinRoot(root: string, abs: string): boolean {
  if (abs === root) return true;
  // Ensure the root is a directory boundary in the comparison.
  const r = root.endsWith("/") || root.endsWith("\\") ? root : root + "/";
  return abs.startsWith(r);
}

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
  // Keep activeProjectId in lockstep with the active session's owning project.
  // Without this, switching to a thread in project B while activeProjectId
  // still points at project A would leave the IDE file tree (and any
  // project-scoped UI) showing the wrong project. Every entry point that
  // activates a session (selectSession / openTab / rewindTurn) routes through
  // this helper, so this single sync covers all of them.
  const prevPid = get().activeProjectId;
  const patch: Partial<SessionState> = {
    model: sess.model,
    effort: sess.effort,
    permissionMode: sess.permissionMode,
    customModelId: sess.customModelId,
    activeProjectId: sess.projectId,
  };
  // The `sessions` field is a derived view of the ACTIVE project's session
  // list (see its field doc). selectProject refreshes it, but selectSession /
  // openTab do NOT - so activating a thread in a different project left
  // `sessions` pointing at the old project's list. Titlebar resolves the
  // active thread's title via `sessions.find(activeSessionId)`, which then
  // missed (the thread isn't in the old list) and the title chip vanished.
  // Refresh the alias whenever the owning project changes.
  if (prevPid !== sess.projectId) {
    patch.sessions = get().sessionsByProject[sess.projectId] ?? EMPTY_SESSIONS;
  }
  // Auto-expand the session's owning project whenever a session is activated.
  // selectSession (tab click) and openTab (left-bar click) both route through
  // here; without this, switching to a thread in a collapsed project leaves the
  // left bar showing the project row but not the thread under it, so the user
  // can't see which thread became active. Other projects' expand state is
  // preserved.
  if (!get().expandedProjects[sess.projectId]) {
    patch.expandedProjects = { ...get().expandedProjects, [sess.projectId]: true };
  }
  set(patch);
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

/* ──────────────── Plan block helpers (inline plan in the message stream) ────────────────
 *
 * The plan is rendered as a `kind: "plan"` block attached to the CURRENT
 * turn's trailing assistant message, rather than a session-global footer card.
 * This keeps each turn's plan frozen in its place in history — different turns
 * produce different plans, none overwriting another.
 *
 * All four plan-aware code paths (plan.update, plan.approval_request,
 * turn.done, submitPlanApproval) funnel through `upsertLivePlanBlock` /
 * `freezeOrPrunePlanBlocks` so the message-array surgery stays in one place.
 */

/** Find the index of the trailing assistant message of the currently-open
 *  turn (the LAST assistant message whose turnMeta has no endedAt), or -1 if
 *  no open-turn assistant message exists. Used to locate where the live plan
 *  block should be attached / removed. */
function findOpenTurnTrailingAssistant(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      return i;
    }
  }
  return -1;
}

/** The planId used for the single "live" plan block within the current turn.
 *  There is at most one live plan per turn at a time (the model calls
 *  EnterPlanMode once, drafts, then ExitPlanMode). Frozen historical blocks
 *  retain this same id — it only needs to be unique within a message, and a
 *  frozen turn's trailing assistant message carries at most one plan block. */
const LIVE_PLAN_ID = "current";

/** Upsert (or remove) the live plan block on the current turn's trailing
 *  assistant message. Used while the turn is streaming:
 *  - phase "cleared" → remove any live plan block (plan mode exited / denied).
 *  - otherwise → insert-or-replace the live plan block with the given text /
 *    phase / hasApproval.
 *
 *  If the current turn has no assistant message yet (plan.update often
 *  arrives before any text/tool block), a new trailing assistant message is
 *  created and stamped with the current turn's `turnMeta` — mirroring the
 *  tool.use branch's "new turn" detection so we don't double-open a turn.
 *
 *  Returns the new messages array; pure (no store mutation). */
function upsertLivePlanBlock(
  messages: ChatMessage[],
  plan: string,
  phase: PlanUpdateEvent["phase"],
  hasApproval: boolean,
  /** Send-time anchor (runningTurnStartedAt) to stamp on a newly-opened
   *  turn's turnMeta, so the real row continues the synthesized pendingTurn
   *  row's timing seamlessly. Omitted on the cleared-phase path. */
  startedAtAnchor?: number,
): ChatMessage[] {
  if (phase === "cleared") {
    // Remove any live plan block from the current turn's trailing assistant
    // message. Frozen blocks (on closed turns) are untouched.
    return removeLivePlanBlock(messages);
  }
  const block: Block = {
    kind: "plan",
    planId: LIVE_PLAN_ID,
    plan,
    phase,
    hasApproval,
  };
  let next = messages;
  const targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) {
    // No open-turn assistant message exists yet. Plan events commonly arrive
    // before any text/tool block, so we open the turn here - same heuristic
    // as the tool.use branch: a turn is "open" while any assistant message
    // has turnMeta.endedAt === undefined; if none, this starts a new turn.
    const isNewTurn = !next.some(
      (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
    );
    const msg: ChatMessage = {
      id: `plan_${Date.now()}`,
      sessionId: "",
      role: "assistant",
      blocks: [block],
      createdAt: Date.now(),
      // Prefer the send-time anchor so timing is continuous with the
      // synthesized pendingTurn row; fall back to now if none was passed.
      ...(isNewTurn ? { turnMeta: { startedAt: startedAtAnchor ?? Date.now() } } : {}),
    };
    next = [...next, msg];
    // A new plan-mode turn is opening → demote any prior latest turn-files
    // card to read-only (mirrors upsertLiveTurnFilesBlock's new-turn branch).
    if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
    return next;
  }
  const target = next[targetIndex];
  const existingIdx = target.blocks.findIndex(
    (b) => b.kind === "plan" && b.planId === LIVE_PLAN_ID,
  );
  let blocks: Block[];
  if (existingIdx >= 0) {
    blocks = target.blocks.map((b, i) => (i === existingIdx ? block : b));
  } else {
    blocks = [...target.blocks, block];
  }
  next = next.map((m, i) => (i === targetIndex ? { ...m, blocks } : m));
  return next;
}

/** Remove the live plan block from the current turn's trailing assistant
 *  message. Drops the assistant message too if it would end up empty (no
 *  other blocks), so a plan-only message doesn't linger as a blank row. */
function removeLivePlanBlock(messages: ChatMessage[]): ChatMessage[] {
  let next = messages;
  const targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) return next;
  const target = next[targetIndex];
  const filtered = target.blocks.filter(
    (b) => !(b.kind === "plan" && b.planId === LIVE_PLAN_ID),
  );
  if (filtered.length === target.blocks.length) return next; // nothing to remove
  if (filtered.length === 0) {
    // Drop the now-empty assistant message entirely.
    next = next.filter((_, i) => i !== targetIndex);
  } else {
    next = next.map((m, i) => (i === targetIndex ? { ...m, blocks: filtered } : m));
  }
  return next;
}

/** Called from turn.done: freeze or prune plan blocks on the JUST-cLOSED turn.
 *  The closing turn's assistant messages were just stamped with endedAt, so we
 *  can't use the "open turn" heuristic — we key off messages whose turnMeta
 *  endedAt matches `endedAt`.
 *
 *  - A plan block with phase "ready" and non-empty text is KEPT (frozen as a
 *    historical card) — the user approved this plan; it stays in the stream.
 *  - Any other plan block (drafting / cleared / empty) is REMOVED — these are
 *    in-progress or rejected drafts that shouldn't leave a trace.
 *  - An assistant message left with zero blocks after pruning is dropped. */
function freezeOrPrunePlanBlocks(messages: ChatMessage[], endedAt: number): ChatMessage[] {
  let next = messages.map((m) => {
    if (!m.turnMeta || m.turnMeta.endedAt !== endedAt) return m;
    if (!m.blocks.some((b) => b.kind === "plan")) return m;
    const kept = m.blocks.filter((b) => {
      if (b.kind !== "plan") return true;
      return b.phase === "ready" && b.plan.trim().length > 0;
    });
    return { ...m, blocks: kept };
  });
  // Drop any assistant messages that became empty (a plan-only message whose
  // plan was pruned). Keep user / non-empty messages untouched.
  next = next.filter(
    (m) => m.role !== "assistant" || m.blocks.length > 0,
  );
  return next;
}

/* ──────────────── Turn-files block helpers (inline "本轮修改" card) ────────────────
 *
 * Mirrors the plan-block pattern: the per-turn modified-files card renders as
 * a `kind: "turn-files"` block attached to its turn's trailing assistant
 * message, frozen in place when the turn ends. Each turn that touched files
 * keeps its own card in history — new turns add new cards, old cards are
 * never deleted (only demoted to read-only once a newer turn supersedes them
 * as "the latest rewindable turn").
 *
 * Only the LATEST turn's card is rewindable (`isLatestTurn === true`); the
 * rewind itself still goes through the in-memory FileSnapshot (cleared per
 * turn), so older turns are display-only snapshots. Historical cards persist
 * to the messages table via the normal blocks round-trip (toRecords /
 * fromRecords) — no DB schema change.
 */

/** The filesId used for the single "live" turn-files block within the current
 *  turn. Same rationale as LIVE_PLAN_ID: at most one live block per turn. */
const LIVE_FILES_ID = "current";

/** Upsert the live turn-files block on the current turn's trailing assistant
 *  message. Called from the turn.files handler.
 *
 *  Attach target resolution (in priority order):
 *  1. The trailing assistant message of the currently-OPEN turn (turnMeta with
 *     no endedAt) - the normal mid-stream case.
 *  2. The most recent assistant message - the realistic late-arrival case.
 *     turn.files is emitted from flushFinal (after an async freeze()), which
 *     runs AFTER the `result` message already emitted turn.done. So by the
 *     time turn.files reaches the renderer the turn is closed and (1) finds
 *     nothing; the file list still belongs to this just-closed turn, so we
 *     attach it to the turn's (now-ended) trailing assistant message WITHOUT
 *     opening a new turn. Opening a new turn here would spawn a phantom
 *     "开始 · 用时 <1s" stat row that never finalizes.
 *  3. A brand-new assistant message (no turnMeta) - defensive fallback when no
 *     assistant message exists at all.
 *
 *  In every case the block becomes the latest rewindable card
 *  (isLatestTurn=true) and every other turn's card is demoted to read-only.
 *
 *  Returns the new messages array; pure (no store mutation). */
function upsertLiveTurnFilesBlock(messages: ChatMessage[], files: TurnFileEntry[]): ChatMessage[] {
  const block: Block = {
    kind: "turn-files",
    filesId: LIVE_FILES_ID,
    files,
    isLatestTurn: true,
  };
  let next = messages;
  let targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) {
    // turn.files normally arrives at the very end of the stream (flushFinal),
    // but the SDK emits turn.done from the `result` message BEFORE flushFinal
    // runs its async freeze() + emit. So by the time turn.files reaches the
    // renderer, turn.done has ALREADY been processed: every assistant message
    // of this turn carries a turnMeta.endedAt, and findOpenTurnTrailingAssistant
    // returns -1. The file list still belongs to THIS just-closed turn, so
    // fall back to the most recent assistant message (the turn's trailing
    // one, now ended) and attach the block there - WITHOUT opening a new turn.
    for (let i = next.length - 1; i >= 0; i--) {
      const m = next[i];
      if (m && m.role === "assistant") {
        targetIndex = i;
        break;
      }
    }
  }
  if (targetIndex === -1) {
    // Truly no assistant message at all (shouldn't happen for a turn that
    // touched files, but stay defensive): create one WITHOUT a turnMeta so we
    // don't spawn a phantom "开始 · 用时" stat row for an already-ended turn.
    const msg: ChatMessage = {
      id: `files_${Date.now()}`,
      sessionId: "",
      role: "assistant",
      blocks: [block],
      createdAt: Date.now(),
    };
    next = [...next, msg];
    next = demotePreviousLatestTurnFiles(next);
    return next;
  }
  const target = next[targetIndex];
  const existingIdx = target.blocks.findIndex(
    (b) => b.kind === "turn-files" && b.filesId === LIVE_FILES_ID,
  );
  let blocks: Block[];
  if (existingIdx >= 0) {
    blocks = target.blocks.map((b, i) => (i === existingIdx ? block : b));
  } else {
    blocks = [...target.blocks, block];
  }
  next = next.map((m, i) => (i === targetIndex ? { ...m, blocks } : m));
  // This turn's card is now the latest → demote every OTHER turn's card to
  // read-only. (Without this, a brief window between turn.files and turn.done
  // would show two cards with the rewind button: the previous turn's frozen
  // card and this turn's new one.) The current turn's block stays true because
  // demotePreviousLatestTurnFiles runs BEFORE we re-stamped it above — but to
  // be safe we re-stamp the target's own block as true after demoting.
  next = demotePreviousLatestTurnFiles(next);
  next = next.map((m, i) => {
    if (i !== targetIndex) return m;
    if (!m.blocks.some((b) => b.kind === "turn-files")) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" ? { ...b, isLatestTurn: true } : b,
      ),
    };
  });
  return next;
}

/** Remove the LATEST turn's turn-files block (called from the turn.rewound
 *  handler — the user rewound the latest turn, so its card should disappear).
 *
 *  Rewind happens AFTER the turn has ended (the user clicks 撤销本轮 on the
 *  frozen card), so the block lives on a CLOSED turn's message — we can't use
 *  findOpenTurnTrailingAssistant here. Instead we target the block marked
 *  `isLatestTurn === true`, which is exactly the rewindable card. Frozen
 *  historical blocks (isLatestTurn false/undefined) are untouched. Drops the
 *  assistant message too if it would be empty. */
function removeLiveTurnFilesBlock(messages: ChatMessage[]): ChatMessage[] {
  // Find the message carrying the latest-turn card (search from the end — the
  // latest turn is the last one with a turn-files block).
  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.blocks.some((b) => b.kind === "turn-files" && b.isLatestTurn)) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) return messages;
  let next = messages;
  const target = next[targetIndex]!;
  const filtered = target.blocks.filter(
    (b) => !(b.kind === "turn-files" && b.isLatestTurn),
  );
  if (filtered.length === target.blocks.length) return next; // nothing to remove
  if (filtered.length === 0) {
    next = next.filter((_, i) => i !== targetIndex);
  } else {
    next = next.map((m, i) => (i === targetIndex ? { ...m, blocks: filtered } : m));
  }
  return next;
}

/** Demote EVERY turn-files block's `isLatestTurn` to false. Called when a new
 *  turn opens (the previous "latest" card is no longer the latest — only the
 *  most recent completed turn is rewindable). The new turn's own card, once it
 *  arrives via turn.files, sets isLatestTurn=true on insert. */
function demotePreviousLatestTurnFiles(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!m.blocks.some((b) => b.kind === "turn-files" && b.isLatestTurn)) return m;
    changed = true;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" && b.isLatestTurn ? { ...b, isLatestTurn: false } : b,
      ),
    };
  });
  return changed ? next : messages;
}

/** Called from turn.done: finalize the just-closed turn's turn-files block.
 *  The block is already attached (turn.files arrived just before turn.done);
 *  here we only need to ensure it's marked isLatestTurn=true (it IS the latest
 *  completed turn now) and demote all earlier turns' cards to read-only.
 *
 *  Unlike plan blocks, turn-files blocks are NEVER pruned — every turn that
 *  touched files keeps its card in history. (Empty turns never produced a
 *  block in the first place, so there's nothing to clean up.) Keyed off
 *  endedAt so we only touch THIS turn's messages. */
function freezeLatestTurnFilesBlock(messages: ChatMessage[], endedAt: number): ChatMessage[] {
  // First demote all older turn-files cards to read-only.
  let next = demotePreviousLatestTurnFiles(messages);
  // Then mark this turn's turn-files block(s) as the latest (rewindable).
  // There is at most one live block per turn; a turn's assistant messages all
  // share the same endedAt stamp, so keying off endedAt catches them all.
  next = next.map((m) => {
    if (!m.turnMeta || m.turnMeta.endedAt !== endedAt) return m;
    if (!m.blocks.some((b) => b.kind === "turn-files")) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" ? { ...b, isLatestTurn: true } : b,
      ),
    };
  });
  return next;
}

/* ──────────────── Delta buffer (performance: batch text.delta per rAF) ────────────────
 *
 * Each `text.delta` / `thinking` event from the stream triggers a full `setState`
 * that rebuilds the messages array. During a long output this can happen thousands
 * of times per second. The buffer accumulates raw deltas and flushes them on a
 * `requestAnimationFrame` boundary (~60 Hz), collapsing many single-character
 * deltas into one `setState` per frame.
 *
 * Terminal events (turn.done, error) force an immediate flush so no content is
 * lost before the turn closes. The buffer is module-scoped, *not* inside the
 * Zustand store, so it doesn't trigger React re-renders on accumulation.
 */

type DeltaEntry = {
  sessionId: string;
  messageId: string;
  /** Accumulated text (via text.delta) */
  text: string;
  /** Accumulated thinking (via thinking delta) — only one of text/thinking is
   *  populated per call, but we carry both to consolidate into one flush. */
  thinking: string;
};

const deltaBuf = new Map<string, DeltaEntry>();

let flushScheduled = false;

/* ─── Adaptive throttling ───
 *
 * Instead of a fixed rAF cadence, we track the inter-arrival time of deltas
 * via a sliding window and pick a flush strategy that balances throughput
 * (batched during bursts) vs. responsiveness (near-immediate when sparse).
 *
 * Strategy matrix:
 *   avg interval    method         delay
 *   < 16ms          rAF            ~16ms (60 Hz batch)
 *   16-100ms        timer + rAF    ~50ms (moderate batch)
 *   > 100ms         microtask      0ms (flush on next tick)
 *
 * The sliding window keeps the last 5 deltas (by wall-clock ms). The window is
 * module-scoped and never triggers React renders, exactly like deltaBuf itself.
 */
const deltaArrivals: number[] = [];
const MAX_WINDOW = 5;

function avgIntervalMs(): number {
  if (deltaArrivals.length < 2) return 0;
  const min = deltaArrivals[0];
  const max = deltaArrivals[deltaArrivals.length - 1];
  return (max - min) / (deltaArrivals.length - 1);
}

function recordDeltaArrival(): void {
  const now = performance.now();
  deltaArrivals.push(now);
  if (deltaArrivals.length > MAX_WINDOW) deltaArrivals.shift();
}

function scheduleDeltaFlush(): void {
  recordDeltaArrival();
  if (flushScheduled) return;
  flushScheduled = true;

  const avg = avgIntervalMs();
  if (avg > 100 && deltaArrivals.length >= 2) {
    // Sparse deltas: flush on next microtask (near-immediate).
    queueMicrotask(flushDeltas);
  } else if (avg > 16) {
    // Moderate pace: 50 ms timer for a modest batch window.
    setTimeout(flushDeltas, 50);
  } else {
    // Dense burst: rAF (natural 60 Hz batch).
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(flushDeltas);
    } else {
      setTimeout(flushDeltas, 16);
    }
  }
}

function flushDeltas(): void {
  flushScheduled = false;
  if (deltaBuf.size === 0) return;

  // Snapshot the buffer and clear it atomically so new deltas that arrive
  // during this flush start a fresh accumulation rather than being lost.
  const entries = Array.from(deltaBuf.values());
  deltaBuf.clear();

  useSessionStore.setState((s) => {
    // Group entries by sessionId so we only iterate each session's messages
    // once per flush cycle.
    const bySession = new Map<string, DeltaEntry[]>();
    for (const e of entries) {
      const arr = bySession.get(e.sessionId);
      if (arr) arr.push(e);
      else bySession.set(e.sessionId, [e]);
    }

    for (const [sid, sessionEntries] of bySession) {
      const list = s.messagesBySession[sid] ?? [];
      let next: typeof list = list;

      for (const e of sessionEntries) {
        let msg = findMsg(next, e.messageId);
        if (!msg) {
          // First delta for this message — create a new assistant message.
          // Check if a turn is already open (assistant message without endedAt).
          const isNewTurn = !next.some(
            (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
          );
          // Prefer the send-time anchor (stamped in sendPrompt) so the real
          // turnMeta continues the synthesized pendingTurn row's timing
          // seamlessly - otherwise the duration would jump (the anchor is
          // earlier than this first-delta arrival). Falls back to now if the
          // anchor is missing (e.g. a resumed/legacy turn with no anchor).
          const startedAt =
            (isNewTurn && useSessionStore.getState().runningTurnStartedAt[sid]) || Date.now();
          msg = {
            id: e.messageId,
            sessionId: sid,
            role: "assistant",
            blocks: [],
            createdAt: Date.now(),
            ...(isNewTurn ? { turnMeta: { startedAt } } : {}),
          };
          next = [...next, msg];
          // A new turn is opening → demote the previous "latest" turn-files
          // card to read-only (it's no longer the latest rewindable turn).
          // The new turn's own card, if any, sets isLatestTurn=true on insert
          // and gets re-promoted at turn.done via freezeLatestTurnFilesBlock.
          if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
        } else {
          // Message already exists — we'll replace it below.
        }

        // Apply accumulated text
        if (e.text) {
          const blocks = msg.blocks;
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.kind === "text") {
            const updatedMsg = {
              ...msg,
              blocks: [...blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + e.text }],
            };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          } else {
            const updatedMsg = {
              ...msg,
              blocks: [...blocks, { kind: "text", text: e.text } as Block],
            };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          }
          msg = findMsg(next, e.messageId)!;
        }

        // Apply accumulated thinking
        if (e.thinking) {
          const blocks = msg!.blocks;
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.kind === "thinking") {
            const updatedMsg = {
              ...msg,
              blocks: [...blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + e.thinking }],
            };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          } else {
            const updatedMsg = {
              ...msg,
              blocks: [...blocks, { kind: "thinking", text: e.thinking } as Block],
            };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          }
        }
      }

      // Write back only if the session changed — avoid touching unrelated sessions.
      if (next !== list) {
        s.messagesBySession[sid] = next;
      }
    }

    // Return a minimal diff — we mutated messagesBySession directly inside the
    // setState callback (Zustand accepts this pattern because setState runs
    // synchronously and can detect the mutation via its proxy).
    return { messagesBySession: { ...s.messagesBySession } };
  });
}

/** Flush any buffered deltas immediately (called before terminal events). */
function forceDeltaFlush(): void {
  if (deltaBuf.size === 0) return;
  flushScheduled = false;
  deltaArrivals.length = 0; // Reset the adaptive window.
  flushDeltas();
}

/* ─── Pane-width persistence (debounced) ───
 * A drag fires many mousemove events; each calls an adjust* action that
 * updates the store synchronously (instant UI). The DB write is debounced so
 * the settings table only gets hit once, ~400ms after the last move. The
 * timer is module-scoped so successive adjust calls reset the same timer. */
let paneWidthPersistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePaneWidthPersist(get: () => SessionState): void {
  if (paneWidthPersistTimer) clearTimeout(paneWidthPersistTimer);
  paneWidthPersistTimer = setTimeout(async () => {
    paneWidthPersistTimer = null;
    const s = get();
    try {
      await api.setting.set({
        key: UI_PANE_WIDTHS_SETTING_KEY,
        value: JSON.stringify({
          left: s.leftWidth,
          right: s.rightWidth,
          bottomTerminal: s.bottomTerminalHeight,
          editor: s.editorWidthPct,
        }),
      });
    } catch (err) {
      console.error("setting.set(paneWidths) failed:", err);
    }
  }, 400);
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
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // 14px mirrors the --right-panel-font-size CSS var in styles.css.
  rightPanelFontSize: 14,
  userMessageColor: null,
  accentColor: null,
  messagesBySession: {},
  runningBySession: {},
  runningTurnStartedAt: {},
  claudeInstalled: null,
  settingsOpen: false,
  commandPaletteOpen: false,
  // Layout panel visibility — lifted from App.tsx useState. Defaults mirror
  // the original App.tsx useState initial values (left+right open, terminal
  // collapsed). NOT persisted.
  leftOpen: true,
  rightOpen: true,
  bottomTerminalOpen: false,
  // Draggable pane sizes. Persisted as one JSON blob (UI_PANE_WIDTHS_SETTING_KEY);
  // init() hydrates + clamps. These defaults match the original hardcoded
  // widths so the first-run layout is unchanged.
  leftWidth: 280,
  rightWidth: 360,
  bottomTerminalHeight: 280,
  editorWidthPct: 50,
  permissionMode: "default",
  model: "default",
  customModelId: null,
  customModels: EMPTY_CUSTOM_MODELS,
  effort: "high",
  todosBySession: {},
  planBySession: {},
  subagentsBySession: {},
  contextSnapshotBySession: {},
  usageHistoryBySession: {},
  pendingQuestionBySession: {},
  pendingApprovals: [],
  pendingPlanApprovalBySession: {},
  turnFilesBySession: {},
  // IDE right-panel. Editor state is per-project (keyed by projectId);
  // init() hydrates from the settings table. rightPanelTab / ideEditorMode
  // are global user prefs.
  rightPanelTab: "files",
  customCommandsByProject: {},
  ideOpenFilesByProject: {},
  ideActiveFileByProject: {},
  ideFileViewModeByProject: {},
  ideEditorMode: "tabs",
  gitDiffOpenMode: "center",
  gitDiffDialogTabs: [],
  gitDiffDialogActiveId: null,
  gitDiffDialogOpen: false,
  gitDiffDialogViewMode: "tabs",
  ideExpandedDirsByProject: {},
  gitDiffByProject: {},
  ideDiffBeforeByProject: {},
  commitGenModel: null,
  commitGenPrompt: "",
  conflictResolveModel: null,
  collapsedGitRepos: {} as Record<string, boolean>,
  ideFocusNonce: 0,

  init: async () => {
    // IDE hydration staging: parsed from settings above, applied after the
    // project list loads so we can drop paths that belong to no project.
    let ideHydrationPending: {
      open: Record<string, string[]>;
      active: Record<string, string | null>;
      dirs: Record<string, string[]>;
    } | null = null;

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

    // Hydrate the appearance settings (chat font size, right-panel font
    // size, user-message bg color, and global accent color). All are
    // optional - missing/invalid values leave the store defaults in place.
    // lib/appearance.ts picks these up and writes the corresponding CSS vars
    // on <html> so the first paint uses the right values (no flash of the
    // default font size / color).
    try {
      const [fontRes, rpFontRes, colorRes, accentRes] = await Promise.all([
        api.setting.get({ key: UI_CHAT_FONT_SIZE_SETTING_KEY }),
        api.setting.get({ key: UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY }),
        api.setting.get({ key: UI_USER_MSG_COLOR_SETTING_KEY }),
        api.setting.get({ key: UI_ACCENT_COLOR_SETTING_KEY }),
      ]);
      if (fontRes.value != null) {
        const px = Number(fontRes.value);
        if (Number.isFinite(px)) set({ chatFontSize: clampFontSize(px) });
      }
      if (rpFontRes.value != null) {
        const px = Number(rpFontRes.value);
        if (Number.isFinite(px)) set({ rightPanelFontSize: clampRightPanelFontSize(px) });
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

    // Hydrate draggable pane widths (one JSON blob). Each field is clamped
    // individually so a single corrupt value can't nuke the whole layout.
    try {
      const paneRes = await api.setting.get({ key: UI_PANE_WIDTHS_SETTING_KEY });
      if (paneRes.value) {
        const parsed = JSON.parse(paneRes.value) as Partial<{
          left: number; right: number; bottomTerminal: number; editor: number;
        }>;
        const patch: Partial<SessionState> = {};
        if (parsed && typeof parsed === "object") {
          if (Number.isFinite(parsed.left)) patch.leftWidth = clampLeftWidth(parsed.left!);
          if (Number.isFinite(parsed.right)) patch.rightWidth = clampRightWidth(parsed.right!);
          if (Number.isFinite(parsed.bottomTerminal)) {
            patch.bottomTerminalHeight = clampBottomTerminalHeight(parsed.bottomTerminal!);
          }
          if (Number.isFinite(parsed.editor)) patch.editorWidthPct = clampEditorWidthPct(parsed.editor!);
          if (Object.keys(patch).length > 0) set(patch);
        }
      }
    } catch (err) {
      console.error("setting.get(paneWidths) failed:", err);
    }

    // Hydrate IDE right-panel prefs (active tab, open files, active file,
    // expanded tree dirs). All are optional JSON-in-settings; missing/invalid
    // values leave the defaults. Paths that don't belong to any persisted
    // project are dropped on load (stale tabs from a removed project).
    try {
      const [tabRes, openRes, activeRes, dirsRes, modeRes, diffModeRes, commitModelRes, commitPromptRes, commandsByProjectRes, conflictModelRes] = await Promise.all([
        api.setting.get({ key: UI_RIGHT_PANEL_TAB_SETTING_KEY }),
        api.setting.get({ key: UI_IDE_OPEN_FILES_SETTING_KEY }),
        api.setting.get({ key: UI_IDE_ACTIVE_FILE_SETTING_KEY }),
        api.setting.get({ key: UI_IDE_EXPANDED_DIRS_SETTING_KEY }),
        api.setting.get({ key: UI_IDE_EDITOR_MODE_SETTING_KEY }),
        api.setting.get({ key: UI_GIT_DIFF_OPEN_MODE_SETTING_KEY }),
        api.setting.get({ key: UI_COMMIT_GEN_MODEL_SETTING_KEY }),
        api.setting.get({ key: UI_COMMIT_GEN_PROMPT_SETTING_KEY }),
        api.setting.get({ key: UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY }),
        api.setting.get({ key: UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY }),
      ]);
      // Terminal moved to the bottom bar, so "terminal" is no longer a valid
      // right-panel tab - a stale persisted value falls through to the default
      // ("files"). The schema in contracts/ipc.ts mirrors this. "browser" was
      // a P5 placeholder tab since removed, so a stale persisted value also
      // falls through to the default.
      if (tabRes.value === "files" || tabRes.value === "git") {
        set({ rightPanelTab: tabRes.value });
      }
      if (modeRes.value === "tabs" || modeRes.value === "replace") {
        set({ ideEditorMode: modeRes.value });
      }
      // Git-diff open-mode preference (center vs dialog). Stale/invalid values
      // fall through to the default ("center").
      if (diffModeRes.value === "center" || diffModeRes.value === "dialog") {
        set({ gitDiffOpenMode: diffModeRes.value });
      }
      // Commit-message generation settings.
      set({ commitGenModel: commitModelRes.value || null });
      if (commitPromptRes.value) {
        set({ commitGenPrompt: commitPromptRes.value });
      }
      // AI conflict-resolution model (from the local conflict-resolution feature).
      set({ conflictResolveModel: conflictModelRes.value || null });
      // Per-project terminal quick-commands: JSON-encoded
      // Record<string, CustomCommand[]> keyed by projectId. Parsed below
      // (after `parseBucket` is defined) so each project's array can be
      // shape-checked.
      // IDE editor state is persisted as per-project JSON objects (keyed by
      // projectId). Parse them now; path validation happens after projects
      // load (below). Legacy flat-array values (pre-per-project) are ignored
      // - a benign one-time loss of "last open files".
      const parseBucket = <T>(raw: string | null): Record<string, T> => {
        if (!raw) return {};
        try {
          const obj = JSON.parse(raw);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, T>;
        } catch {
          /* malformed JSON - leave empty */
        }
        return {};
      };
      const parsedOpen = parseBucket<string[]>(openRes.value);
      const parsedActive = parseBucket<string | null>(activeRes.value);
      const parsedDirs = parseBucket<string[]>(dirsRes.value);
      // Defer applying until we know the project roots - stash on a closure
      // var the project-load block reads below.
      ideHydrationPending = { open: parsedOpen, active: parsedActive, dirs: parsedDirs };
      // Per-project commands: parse the outer map, then defensively
      // shape-check each inner CustomCommand[] (drop malformed items).
      {
        const rawMap = parseBucket<unknown>(commandsByProjectRes.value);
        const validated: Record<string, CustomCommand[]> = {};
        for (const [pid, rawList] of Object.entries(rawMap)) {
          if (!Array.isArray(rawList)) continue;
          const valid = rawList.filter(
            (c): c is CustomCommand =>
              !!c &&
              typeof c === "object" &&
              typeof c.id === "string" &&
              typeof c.name === "string" &&
              typeof c.command === "string",
          );
          validated[pid] = valid;
        }
        set({ customCommandsByProject: validated });
      }
    } catch (err) {
      console.error("setting.get(ide) failed:", err);
    }

    // Hydrate collapsed git repo card states from the settings table. Stored
    // as a JSON-encoded Record<string, boolean> mapping repo paths to their
    // collapsed state. Falls back to empty on error.
    try {
      const { value } = await api.setting.get({ key: UI_GIT_COLLAPSED_REPOS_SETTING_KEY });
      if (value) {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          set({ collapsedGitRepos: parsed as Record<string, boolean> });
        }
      }
    } catch (err) {
      console.error("setting.get(gitCollapsedRepos) failed:", err);
    }

    const { projects } = await api.project.list();
    set({ projects });

    // Apply deferred IDE hydration now that we know the project roots.
    // For each per-project bucket, drop paths that don't sit inside that
    // project's root (stale tabs from a moved/removed folder, or paths from a
    // different machine). Also drop buckets whose projectId no longer exists.
    if (ideHydrationPending) {
      const projectById = new Map(projects.map((p) => [p.id, p]));
      const filterProjectPaths = (pid: string, paths: string[]) => {
        const proj = projectById.get(pid);
        if (!proj) return []; // project gone — drop all its paths
        return paths.filter((p) => isPathWithinRoot(proj.path, p));
      };
      const openByProject: Record<string, string[]> = {};
      const activeByProject: Record<string, string | null> = {};
      const dirsByProject: Record<string, string[]> = {};
      for (const pid of Object.keys(ideHydrationPending.open)) {
        const filtered = filterProjectPaths(pid, ideHydrationPending.open[pid] ?? []);
        if (filtered.length > 0) openByProject[pid] = filtered;
      }
      for (const pid of Object.keys(ideHydrationPending.active)) {
        const proj = projectById.get(pid);
        const active = ideHydrationPending.active[pid];
        if (proj && active && isPathWithinRoot(proj.path, active)) {
          // Only keep active if it's still in the (filtered) open list.
          const open = openByProject[pid] ?? [];
          activeByProject[pid] = open.includes(active) ? active : (open[0] ?? null);
        }
      }
      for (const pid of Object.keys(ideHydrationPending.dirs)) {
        const filtered = filterProjectPaths(pid, ideHydrationPending.dirs[pid] ?? []);
        if (filtered.length > 0) dirsByProject[pid] = filtered;
      }
      set({
        ideOpenFilesByProject: openByProject,
        ideActiveFileByProject: activeByProject,
        ideExpandedDirsByProject: dirsByProject,
      });
      ideHydrationPending = null;
    }

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

    // Normalize the chosen path so the same folder isn't imported twice under
    // different surface forms (drive-letter case, forward vs. back slashes,
    // trailing separator). Comparison is case-insensitive on Windows/macOS
    // where the filesystem is case-insensitive; on Linux paths stay as-is
    // (toLowerCase on a Linux path would wrongly merge distinct folders, but
    // it's harmless there because the only difference is the slashes).
    const normalize = (p: string) =>
      p
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
    const normalized = normalize(path);

    // An existing project already points at this folder. Don't create a
    // duplicate - just activate it (restoring if it was archived) so the user
    // lands on the folder they picked without a second entry.
    const existing = get().projects.find((p) => normalize(p.path) === normalized);
    if (existing) {
      if (existing.archived) {
        await get().archiveProject(existing.id, false);
      }
      await get().selectProject(existing.id);
      return existing.id;
    }

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

  /** Move a tab within the strip. No-op for out-of-range / same index. */
  reorderTab: (from, to) =>
    set((s) => {
      if (
        from === to ||
        from < 0 ||
        from >= s.openTabs.length ||
        to < 0 ||
        to >= s.openTabs.length
      ) {
        return {};
      }
      const next = [...s.openTabs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { openTabs: next };
    }),

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
      // Scrub the deleted project's IDE editor buckets (open files / active
      // file / view mode / expanded dirs) so they don't linger as orphans.
      const ideOpenFilesByProject = { ...s.ideOpenFilesByProject };
      const ideActiveFileByProject = { ...s.ideActiveFileByProject };
      const ideFileViewModeByProject = { ...s.ideFileViewModeByProject };
      const ideExpandedDirsByProject = { ...s.ideExpandedDirsByProject };
      const gitDiffByProject = { ...s.gitDiffByProject };
      delete ideOpenFilesByProject[id];
      delete ideActiveFileByProject[id];
      delete ideFileViewModeByProject[id];
      delete ideExpandedDirsByProject[id];
      delete gitDiffByProject[id];
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
          ideOpenFilesByProject, ideActiveFileByProject, ideFileViewModeByProject, ideExpandedDirsByProject, gitDiffByProject,
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
        ideOpenFilesByProject, ideActiveFileByProject, ideFileViewModeByProject, ideExpandedDirsByProject,
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
      const runningTurnStartedAt = { ...s.runningTurnStartedAt };
      delete runningTurnStartedAt[id];
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
      const usageHistoryBySession = { ...s.usageHistoryBySession };
      delete usageHistoryBySession[id];
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
          runningTurnStartedAt,
          todosBySession,
          planBySession,
          subagentsBySession,
          pendingQuestionBySession,
          turnFilesBySession,
          contextSnapshotBySession,
          usageHistoryBySession,
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
        runningTurnStartedAt,
        todosBySession,
        planBySession,
        subagentsBySession,
        pendingQuestionBySession,
        turnFilesBySession,
        contextSnapshotBySession,
        usageHistoryBySession,
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

  renameSession: async (id, title) => {
    const { session } = await api.session.rename({ id, title });
    set((s) => {
      const projectId = session.projectId;
      // Update the row in whichever cache holds it (active page or archived
      // bin). Title is the only field that changes, but we replace the whole
      // row with the server-fresh copy to keep things consistent.
      const patchRow = (list: Session[] | undefined) =>
        list && list.some((x) => x.id === id)
          ? list.map((x) => (x.id === id ? session : x))
          : list;
      const sessionsByProject = { ...s.sessionsByProject };
      if (sessionsByProject[projectId]) {
        const next = patchRow(sessionsByProject[projectId]);
        if (next) sessionsByProject[projectId] = next;
      }
      const archivedSessionsByProject = { ...s.archivedSessionsByProject };
      if (archivedSessionsByProject[projectId]) {
        const next = patchRow(archivedSessionsByProject[projectId]);
        if (next) archivedSessionsByProject[projectId] = next;
      }
      // The `sessions` alias mirrors the active project's list; refresh it in
      // case the renamed session lives in the active project (title chip etc.).
      const sessions = s.activeProjectId === projectId
        ? (sessionsByProject[projectId] ?? s.sessions)
        : s.sessions;
      return { sessionsByProject, archivedSessionsByProject, sessions };
    });
  },

  sendPrompt: async (prompt, attachments, displayText) => {
    const sessionId = get().activeSessionId;
    if (!sessionId || !prompt.trim()) return;
    // Per-thread guard: only block this thread from sending if IT is running.
    // Another thread's running turn shouldn't lock the composer in this one.
    if (get().runningBySession[sessionId]) return;

    // 1. immediately show the user's message. Attachments (pasted content
    //    promoted to cards in the composer) render as attachment blocks
    //    ABOVE the typed text, mirroring the composer's chip-above-textarea
    //    layout. The text block shows only the typed text (displayText) —
    //    the full `prompt` (with attachments inlined via
    //    composePromptWithTags) is what the SDK receives, but showing it
    //    here too would duplicate the attachment content as plain text.
    const blocks: Block[] = [];
    if (attachments) {
      for (const a of attachments) {
        blocks.push({
          kind: "attachment",
          preview: a.preview,
          content: a.content,
          attachmentKind: a.attachmentKind,
          filePath: a.filePath,
        });
      }
    }
    blocks.push({ kind: "text", text: displayText ?? prompt });
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks,
      createdAt: Date.now(),
    };
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg],
      },
      runningBySession: { ...s.runningBySession, [sessionId]: true },
      // Stamp the turn's start time NOW (send moment), not when the first
      // assistant block arrives. This anchors the synthesized "开始 · 用时"
      // row that renders before any token lands, and the real turnMeta
      // (stamped at the first delta/tool/plan) falls back to this value so
      // the timing is continuous across the handoff.
      runningTurnStartedAt: { ...s.runningTurnStartedAt, [sessionId]: Date.now() },
    }));

	    // 2. fire the turn; events stream back via ingestEvent. Ship the
	    //    current model / customModelId / effort / permissionMode from the
	    //    store as per-turn overrides - the DB row may be stale because
	    //    `setModel` / `setCustomModel` persist via fire-and-forget
	    //    `updateSettings`, which races `sendTurn`. The main handler
	    //    applies these overrides to the in-memory session so
	    //    RuntimeManager always sees the latest UI state.
	    const { model, customModelId, effort, permissionMode } = get();
	    let updated;
	    try {
	      ({ session: updated } = await api.claude.sendTurn({
	        sessionId,
	        prompt,
	        model,
	        effort,
	        permissionMode,
	        customModelId,
	      }));
	    } catch (err) {
	      // The IPC itself rejected (not a streamed `error` event). Without
	      // this the running flag + synthesized stat row would stick forever
	      // - no turn.done/error event will arrive to clear them. Reset both
	      // so the composer unlocks and the pending row disappears.
	      console.error("sendTurn IPC failed:", err);
	      set((s) => {
	        const runningBySession = { ...s.runningBySession, [sessionId]: false };
	        const runningTurnStartedAt = { ...s.runningTurnStartedAt };
	        delete runningTurnStartedAt[sessionId];
	        return { runningBySession, runningTurnStartedAt };
	      });
	      return;
	    }
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
    set((s) => {
      const runningTurnStartedAt = { ...s.runningTurnStartedAt };
      delete runningTurnStartedAt[sessionId];
      return {
        runningBySession: { ...s.runningBySession, [sessionId]: false },
        runningTurnStartedAt,
      };
    });
  },

  ingestEvent: (e) => {
    const sid = e.sessionId;

    // Terminal events: flush any buffered deltas before processing the
    // turn-end event so no content is lost when the stream closes.
    if (e.type === "turn.done" || e.type === "error") {
      forceDeltaFlush();
    }

    // todo.update is an independent state slice — handle and skip the
    // message-accumulation logic below.
    if (e.type === "todo.update") {
      set((s) => ({ todosBySession: { ...s.todosBySession, [sid]: e.todos } }));
      return;
    }
    // plan.update: drives BOTH the activity capsule (planBySession) AND the
    // inline `kind: "plan"` block on the current turn's trailing assistant
    // message. The inline block is what the user actually reads in the
    // message stream — it stays put per-turn (different turns → different
    // plan blocks in history), unlike the old footer card which was a single
    // session-global slot that got overwritten each turn.
    //   phase "drafting" → live card with 草拟中 badge, content streams in.
    //   phase "ready"    → card freezes as 已就绪 after ExitPlanMode approval.
    //   phase "cleared"  → remove the live block (plan mode exited / denied).
    if (e.type === "plan.update") {
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        const hasApproval = !!s.pendingPlanApprovalBySession[sid];
        const next = upsertLivePlanBlock(list, e.plan, e.phase, hasApproval, s.runningTurnStartedAt[sid] ?? Date.now());
        return {
          planBySession: {
            ...s.planBySession,
            [sid]: { plan: e.plan, phase: e.phase },
          },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sid]: next },
        };
      });
      return;
    }
    // mode.change: the model (or host) flipped the session's effective
    // permission mode mid-turn (e.g. EnterPlanMode / ExitPlanMode after
    // approval). Sync the composer chip for the ACTIVE session so it
    // reflects runtime reality instead of the stale startup mode. Only the
    // active session's chip is updated — other tabs keep their own config.
    // Persist fire-and-forget so a resumed turn starts in the right mode.
    if (e.type === "mode.change") {
      if (sid === get().activeSessionId) {
        set({ permissionMode: e.mode });
        void api.session.updateSettings({ sessionId: sid, permissionMode: e.mode }).catch((err) => {
          console.error("updateSettings(mode.change) failed:", err);
        });
      }
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
      // Also refresh the inline plan block's hasApproval flag → true so its
      // badge flips to 待审阅, mirroring the composer approval sheet.
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        // The plan text on the approval request is the model's ExitPlanMode
        // payload — re-sync the inline block so it shows exactly what the
        // user is being asked to approve (phase stays "ready" per the prior
        // plan.update emitted by the adapter on ExitPlanMode).
        const next = upsertLivePlanBlock(list, e.plan, "ready", true, s.runningTurnStartedAt[sid] ?? Date.now());
        return {
          pendingPlanApprovalBySession: {
            ...s.pendingPlanApprovalBySession,
            [sid]: e,
          },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sid]: next },
        };
      });
      return;
    }
    if (e.type === "turn.files") {
      // Drives TWO things:
      //  1. turnFilesBySession[sid] — the in-memory mirror of the LATEST
      //     turn's files (used by rewindTurn's empty-check + the Write-diff
      //     beforeMap until the block freezes). Kept as a single slot since
      //     only the latest turn is rewindable.
      //  2. A `kind: "turn-files"` block on the current turn's trailing
      //     assistant message — the per-turn card the user actually sees in
      //     the stream. Frozen in place at turn.done, persisted via the
      //     blocks round-trip, so every turn keeps its own card in history.
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        const next = upsertLiveTurnFilesBlock(list, e.files);
        return {
          turnFilesBySession: { ...s.turnFilesBySession, [sid]: e.files },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sid]: next },
        };
      });
      return;
    }
    if (e.type === "turn.rewound") {
      // The user rewound the LATEST turn — clear its in-memory mirror AND
      // remove its live turn-files block from the stream (the card vanishes
      // with the rewind). Frozen historical cards on prior turns are
      // untouched. turnFilesBySession is also cleared so rewindTurn's
      // empty-check correctly reports "nothing to rewind" afterwards.
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        const next = removeLiveTurnFilesBlock(list);
        return {
          turnFilesBySession: { ...s.turnFilesBySession, [sid]: [] },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sid]: next },
        };
      });
      return;
    }

    set((s) => {
      const list = s.messagesBySession[sid] ?? [];
      let next: ChatMessage[] = list;

      switch (e.type) {
        case "text.delta": {
          // Buffer the delta — flushDeltas will apply accumulated text in a
          // single rAF-bound setState, collapsing many single-char deltas into
          // one React update per frame (~60 Hz instead of per-char).
          const key = `${sid}:${e.messageId}`;
          const existing = deltaBuf.get(key);
          if (existing) {
            existing.text += e.text;
          } else {
            deltaBuf.set(key, { sessionId: sid, messageId: e.messageId, text: e.text, thinking: "" });
          }
          scheduleDeltaFlush();
          // Don't add to `next` — flushDeltas mutates the store directly.
          break;
        }
        case "thinking": {
          const key = `${sid}:${e.messageId}`;
          const existing = deltaBuf.get(key);
          if (existing) {
            existing.thinking += e.text;
          } else {
            deltaBuf.set(key, { sessionId: sid, messageId: e.messageId, text: "", thinking: e.text });
          }
          scheduleDeltaFlush();
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
            // Prefer the send-time anchor (stamped in sendPrompt) so the real
            // turnMeta continues the synthesized pendingTurn row's timing
            // seamlessly - otherwise the duration would jump. Falls back to
            // now if the anchor is missing (resumed/legacy turn).
            const startedAt = (isNewTurn && s.runningTurnStartedAt[sid]) || Date.now();
            lastAssistant = {
              id: `a_${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              blocks: [],
              createdAt: Date.now(),
              ...(isNewTurn ? { turnMeta: { startedAt } } : {}),
            };
            next = [...next, lastAssistant];
            // A new turn opened (no prior assistant message at all) — demote
            // any previous latest turn-files card to read-only.
            if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
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
          set((s) => {
            const runningTurnStartedAt = { ...s.runningTurnStartedAt };
            delete runningTurnStartedAt[sid];
            return {
              runningBySession: { ...s.runningBySession, [sid]: false },
              runningTurnStartedAt,
              // Only drop approvals + files belonging to this session; the
              // head pendingApprovals is per-session already, but it's a
              // flat array - filter down to the affected one.
              pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid),
              turnFilesBySession: { ...s.turnFilesBySession, [sid]: [] },
            };
          });
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
          // Freeze or prune the inline plan block(s) on this just-closed turn.
          // An approved plan (phase "ready" + non-empty text) stays as a frozen
          // historical card in the stream; drafting / cleared / empty plans are
          // removed (they represent an in-progress or rejected draft). A plan-
          // only assistant message that prunes to empty is dropped entirely.
          // Keyed off endedAt so we touch only THIS turn's messages.
          next = freezeOrPrunePlanBlocks(next, endedAt);
          // Finalize the just-closed turn's turn-files block: mark it
          // isLatestTurn=true (it's now the latest rewindable turn) and demote
          // every earlier turn's card to read-only. turn-files blocks are
          // never pruned — each turn that touched files keeps its card in
          // history. Keyed off endedAt so only THIS turn's messages are
          // promoted; older turns get demoted by demotePreviousLatestTurnFiles.
          next = freezeLatestTurnFilesBlock(next, endedAt);
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
            // If any subagent is still `running` (typically a backgrounded task
            // whose lifecycle outlives this turn's stream), KEEP the roster so
            // the renderer can keep the composer locked + show the task as
            // in-progress. Only clear when nothing is running (the normal
            // case — foreground tasks were force-completed by the adapter).
            const curAgents = s.subagentsBySession[sid] ?? [];
            const hasRunning = curAgents.some((a) => a.status === "running");
            // Append a finalized usage record for this turn (for the activity
            // capsule's consumption history). Derive the turn's start from the
            // first assistant message still carrying this turn's turnMeta.
            const snap = s.contextSnapshotBySession[sid];
            const turnStart =
              next.find((m) => m.turnMeta && m.turnMeta.endedAt === endedAt)?.turnMeta?.startedAt ??
              endedAt;
            const prevHistory = s.usageHistoryBySession[sid] ?? [];
            const history =
              snap != null
                ? [
                    ...prevHistory,
                    {
                      endedAt,
                      durationMs: Math.max(0, endedAt - turnStart),
                      totalProcessedTokens: snap.totalProcessedTokens,
                      outputTokens: snap.outputTokens,
                      cacheReadTokens: snap.cacheReadTokens ?? 0,
                      cacheCreationTokens: snap.cacheCreationTokens ?? 0,
                      costUsd: snap.costUsd,
                      usedTokens: snap.usedTokens,
                      model: snap.model,
                    } satisfies TurnUsageRecord,
                  ]
                : prevHistory;
            return {
              runningBySession: { ...s.runningBySession, [sid]: false },
              // Turn closed - drop the send-time anchor so the synthesized
              // pendingTurn row stops rendering (it keys off isRunning, but
              // clearing this is belt-and-suspenders and keeps the slice tidy
              // for the next turn).
              runningTurnStartedAt: (() => {
                const m = { ...s.runningTurnStartedAt };
                delete m[sid];
                return m;
              })(),
              pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid),
              pendingPlanApprovalBySession: restPlanApprovals,
              // Keep the plan card visible when the plan was APPROVED (phase
              // "ready" with non-empty text) so it persists in the message
              // stream after the turn ends and across thread reopen. Clear
              // drafting / empty / cleared plans — those represent an
              // unapproved draft or the absence of a plan.
              planBySession: {
                ...s.planBySession,
                [sid]: (s.planBySession[sid]?.phase === "ready" && s.planBySession[sid]?.plan)
                  ? s.planBySession[sid]
                  : { plan: "", phase: "cleared" },
              },
              subagentsBySession: hasRunning
                ? s.subagentsBySession
                : { ...s.subagentsBySession, [sid]: [] },
              usageHistoryBySession: { ...s.usageHistoryBySession, [sid]: history },
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

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setLeftOpen: (open) => set({ leftOpen: open }),
  setRightOpen: (open) => set({ rightOpen: open }),
  setBottomTerminalOpen: (open) => set({ bottomTerminalOpen: open }),

  // ── Draggable pane sizes ──
  // adjust* apply an incremental delta (from the drag handle) to the current
  // value, clamp, and set synchronously (instant UI). The DB write is
  // debounced so a drag (many mousemove events) only hits the settings table
  // once after the user stops. reset* restore the defaults (double-click).
  adjustLeftWidth: (deltaPx) => {
    const next = clampLeftWidth(get().leftWidth + deltaPx);
    set({ leftWidth: next });
    schedulePaneWidthPersist(get);
  },
  adjustRightWidth: (deltaPx) => {
    const next = clampRightWidth(get().rightWidth - deltaPx);
    set({ rightWidth: next });
    schedulePaneWidthPersist(get);
  },
  adjustBottomTerminalHeight: (deltaPx) => {
    // Divider sits on TOP of the terminal. Dragging the handle DOWN (delta>0)
    // pushes it toward the terminal, so the terminal SHRINKS — same sign flip
    // as the right-bar divider. Drag UP (delta<0) to grow it.
    const next = clampBottomTerminalHeight(get().bottomTerminalHeight - deltaPx);
    set({ bottomTerminalHeight: next });
    schedulePaneWidthPersist(get);
  },
  adjustEditorWidthPct: (deltaPx) => {
    const next = clampEditorWidthPct(get().editorWidthPct + deltaPx);
    set({ editorWidthPct: next });
    schedulePaneWidthPersist(get);
  },
  resetLeftWidth: () => {
    set({ leftWidth: 280 });
    schedulePaneWidthPersist(get);
  },
  resetRightWidth: () => {
    set({ rightWidth: 360 });
    schedulePaneWidthPersist(get);
  },
  resetBottomTerminalHeight: () => {
    set({ bottomTerminalHeight: 280 });
    schedulePaneWidthPersist(get);
  },
  resetEditorWidthPct: () => {
    set({ editorWidthPct: 50 });
    schedulePaneWidthPersist(get);
  },

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

  setRightPanelFontSize: async (px) => {
    const clamped = clampRightPanelFontSize(px);
    set({ rightPanelFontSize: clamped });
    try {
      await api.setting.set({
        key: UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(rightPanelFontSize) failed:", err);
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
        // Drop the 待审阅 badge on the inline plan block now that the user
        // has decided. On approve the adapter will follow up with a
        // plan.update phase:"ready" (block stays, freezes at turn.done);
        // on reject it emits phase:"cleared" which removes the block. Either
        // way we flip hasApproval off immediately so the badge doesn't linger.
        const list = s.messagesBySession[sessionId] ?? EMPTY_MESSAGES;
        const next = upsertLivePlanBlock(list, pending.plan, "ready", false, s.runningTurnStartedAt[sessionId] ?? Date.now());
        return {
          pendingPlanApprovalBySession: rest,
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sessionId]: next },
        };
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

  /* ─────────────────── IDE right-panel actions ─────────────────── */

  setRightPanelTab: (tab) => {
    set({ rightPanelTab: tab });
    void api.setting.set({ key: UI_RIGHT_PANEL_TAB_SETTING_KEY, value: tab }).catch((err) => {
      console.error("setting.set(rightPanelTab) failed:", err);
    });
  },

  setCustomCommandsByProject: (projectId, commands) => {
    set((s) => ({
      customCommandsByProject: { ...s.customCommandsByProject, [projectId]: commands },
    }));
    void api.setting
      .set({ key: UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY, value: JSON.stringify(get().customCommandsByProject) })
      .catch((err) => console.error("setting.set(customCommandsByProject) failed:", err));
  },

  addCustomCommand: (projectId, cmd) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    const next: CustomCommand = { ...cmd, id: `cmd-${Date.now().toString(36)}` };
    get().setCustomCommandsByProject(projectId, [...prev, next]);
  },

  updateCustomCommand: (projectId, cmd) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    get().setCustomCommandsByProject(
      projectId,
      prev.map((c) => (c.id === cmd.id ? cmd : c)),
    );
  },

  removeCustomCommand: (projectId, id) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    get().setCustomCommandsByProject(
      projectId,
      prev.filter((c) => c.id !== id),
    );
  },

  openFileInIde: (filePath, opts) => {
    const pid = get().activeProjectId;
    if (!pid) return; // no active project - nothing to scope to
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    const mode = get().ideEditorMode;
    // In "replace" mode, opening a file discards everything else - at most
    // one file is open at a time. In "tabs" mode, files accumulate (dedup:
    // re-opening an already-open file just activates it).
    const open = mode === "replace" ? [filePath] : prev.includes(filePath) ? prev : [...prev, filePath];
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode };
    // A review/diff request is an explicit intent -> force diff mode (don't
    // leave a stale "edit" the user may have toggled for a different purpose).
    if (opts?.diff) viewMode[filePath] = "diff";
    // Markdown files default to "preview" on FIRST open (no prior view-mode for
    // this file). Re-opening respects the user's earlier choice (e.g. they
    // switched to "edit") since the entry already exists. A diff request above
    // takes precedence over this default.
    else if (!(filePath in prevViewMode) && isMarkdownPath(filePath)) {
      viewMode[filePath] = "preview";
    }
    // A before-snapshot passed by a turn-files card (works for HISTORICAL
    // turns whose snapshot is gone from turnFilesByProject). Stashed
    // per-file so FileEditor can use it as the diff's left pane.
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore =
      opts?.diff && opts.before != null
        ? { ...prevDiffBefore, [filePath]: opts.before }
        : prevDiffBefore;
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: filePath },
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
      ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
      // Bump the focus nonce so App opens the right panel if collapsed.
      ideFocusNonce: s.ideFocusNonce + 1,
    }));
    persistIdeBuckets(get());
  },

  closeFileInIde: (filePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    const idx = prev.indexOf(filePath);
    if (idx === -1) return; // not open — nothing to do
    const open = prev.filter((p) => p !== filePath);
    // Active shifts to the previous file (or next, or null).
    let active = get().ideActiveFileByProject[pid] ?? null;
    if (active === filePath) {
      active = open[idx - 1] ?? open[idx] ?? null;
    }
    // Clean up the per-file view mode for the closed file.
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode };
    delete viewMode[filePath];
    // Clean up the per-file before-snapshot override too.
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore = { ...prevDiffBefore };
    delete diffBefore[filePath];
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
      ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
    }));
    persistIdeBuckets(get());
  },

  setIdeActiveFile: (filePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => ({
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: filePath },
    }));
    persistIdeBuckets(get());
  },

  setIdeFileViewMode: (filePath, mode) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode, [filePath]: mode };
    set((s) => ({
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
    }));
    // Not persisted (view mode is ephemeral — see the field doc).
  },

  setIdeEditorMode: (mode) => {
    // When switching to "replace", collapse the ACTIVE project's open-file
    // list to just the active file (if any) so the invariant "≤1 file open"
    // holds immediately for the project the user is looking at.
    if (mode === "replace") {
      const pid = get().activeProjectId;
      if (pid) {
        const active = get().ideActiveFileByProject[pid] ?? null;
        const open = active ? [active] : [];
        set((s) => ({
          ideEditorMode: mode,
          ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        }));
        persistIdeBuckets(get());
      } else {
        set({ ideEditorMode: mode });
      }
    } else {
      set({ ideEditorMode: mode });
    }
    void api.setting
      .set({ key: UI_IDE_EDITOR_MODE_SETTING_KEY, value: mode })
      .catch((err) => console.error("setting.set(ideEditorMode) failed:", err));
  },

  setGitDiffOpenMode: (mode) => {
    set({ gitDiffOpenMode: mode });
    void api.setting
      .set({ key: UI_GIT_DIFF_OPEN_MODE_SETTING_KEY, value: mode })
      .catch((err) => console.error("setting.set(gitDiffOpenMode) failed:", err));
  },

  openGitDiffDialogTab: (tab) => {
    set((s) => {
      // Dedup by file path: re-clicking the same file refreshes its snapshot
      // and moves it to the end (most-recent) rather than opening a duplicate.
      const existing = s.gitDiffDialogTabs.find((t) => t.id === tab.id);
      const tabs = existing
        ? s.gitDiffDialogTabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
        : [...s.gitDiffDialogTabs, tab];
      return {
        gitDiffDialogTabs: tabs,
        gitDiffDialogActiveId: tab.id,
        // Opening a tab always surfaces the dialog.
        gitDiffDialogOpen: true,
      };
    });
  },

  closeGitDiffDialogTab: (id) => {
    set((s) => {
      const idx = s.gitDiffDialogTabs.findIndex((t) => t.id === id);
      if (idx === -1) return {};
      const tabs = s.gitDiffDialogTabs.filter((t) => t.id !== id);
      // If the closed tab was active, shift to an adjacent one (prefer the
      // previous; otherwise the next; otherwise none).
      let activeId = s.gitDiffDialogActiveId;
      let open = s.gitDiffDialogOpen;
      if (activeId === id) {
        activeId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? null;
        // No tabs left -> close the dialog too.
        open = tabs.length > 0;
      }
      return { gitDiffDialogTabs: tabs, gitDiffDialogActiveId: activeId, gitDiffDialogOpen: open };
    });
  },

  setGitDiffDialogActive: (id) => {
    set({ gitDiffDialogActiveId: id });
  },

  setGitDiffDialogOpen: (open) => {
    set({ gitDiffDialogOpen: open });
  },

  setGitDiffDialogViewMode: (mode) => {
    set({ gitDiffDialogViewMode: mode });
  },

  toggleDirExpanded: (dirPath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideExpandedDirsByProject[pid] ?? [];
    const open = prev.includes(dirPath) ? prev.filter((p) => p !== dirPath) : [...prev, dirPath];
    set((s) => ({
      ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: open },
    }));
    persistIdeBuckets(get());
  },

  setDirExpanded: (dirPath, open) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideExpandedDirsByProject[pid] ?? [];
    const has = prev.includes(dirPath);
    let next: string[];
    if (open && !has) next = [...prev, dirPath];
    else if (!open && has) next = prev.filter((p) => p !== dirPath);
    else return; // already in the desired state
    set((s) => ({
      ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: next },
    }));
    persistIdeBuckets(get());
  },

  saveFileContent: async (filePath, content) => {
    try {
      const { ok } = await api.file.writeFile({ filePath, content });
      return ok;
    } catch (err) {
      console.error("file.writeFile failed:", err);
      return false;
    }
  },

  setGitDiffBefore: (filePath, before) => {
    get().setGitDiffPair(filePath, { before });
  },

  setGitDiffPair: (filePath, pair) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => ({
      gitDiffByProject: {
        ...s.gitDiffByProject,
        [pid]: { ...(s.gitDiffByProject[pid] ?? {}), [filePath]: pair },
      },
    }));
  },

  clearGitDiffBefore: (filePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => {
      const projMap = s.gitDiffByProject[pid];
      if (!projMap || !(filePath in projMap)) return {};
      const next = { ...projMap };
      delete next[filePath];
      return { gitDiffByProject: { ...s.gitDiffByProject, [pid]: next } };
    });
  },

  setCommitGenModel: (modelId) => {
    set({ commitGenModel: modelId });
    void api.setting
      .set({ key: UI_COMMIT_GEN_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(commitGenModel) failed:", err));
  },

  setCommitGenPrompt: (prompt) => {
    set({ commitGenPrompt: prompt });
    void api.setting
      .set({ key: UI_COMMIT_GEN_PROMPT_SETTING_KEY, value: prompt })
      .catch((err) => console.error("setting.set(commitGenPrompt) failed:", err));
  },

  setConflictResolveModel: (modelId) => {
    set({ conflictResolveModel: modelId });
    void api.setting
      .set({ key: UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(conflictResolveModel) failed:", err));
  },

  toggleCollapsedGitRepo: (repoPath) => {
    set((s) => {
      const next = { ...s.collapsedGitRepos };
      if (next[repoPath]) {
        delete next[repoPath]; // remove key when expanding
      } else {
        next[repoPath] = true;
      }
      void api.setting
        .set({ key: UI_GIT_COLLAPSED_REPOS_SETTING_KEY, value: JSON.stringify(next) })
        .catch((err) => console.error("setting.set(gitCollapsedRepos) failed:", err));
      return { collapsedGitRepos: next };
    });
  },
}));

// Stable empty arrays (e.g. EMPTY_MESSAGES, EMPTY_TODOS) are exported
// directly at their declaration site (see the "Stable empty arrays" block
// above) so they can be imported individually without a re-export step.
