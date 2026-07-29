/**
 * IPC contract — validated messages crossing the Electron main↔renderer boundary.
 * Every channel is whitelisted in the preload and validated with zod before
 * the main process acts on it. This is the security boundary.
 */
import { z } from "zod";
import type { RuntimeEvent } from "./runtime.js";
import type { Project, Session, MessageRecord, TurnInput, ApprovalDecision } from "./session.js";
import type { ProviderCapabilities, UserInputAnswers } from "./provider.js";
import type { CustomModelPublic, CustomModelInput, TestCustomModelResult } from "./customModel.js";
import type { ThemeName, EffectiveTheme, ThemeChangedMessage } from "./theme.js";

/**
 * Default provider id — used when no provider is explicitly specified for a
 * new session. Currently "claude-sdk" (Claude Agent SDK).
 */
export const DEFAULT_PROVIDER_ID = "claude-sdk";

/**
 * Setting key under which the user's configured claude CLI path is persisted
 * (in the `settings` table). Shared between main (resolver/handler) and
 * renderer (settings modal) so the string never drifts.
 *
 * @deprecated With the Agent SDK, the SDK bundles its own binary — this
 * setting is only relevant for the legacy CLI spawn path.
 */
export const CLAUDE_PATH_SETTING_KEY = "claudePath";

/**
 * Setting key under which the user's color-scheme preference is persisted.
 * Value is one of {@link ThemeName}: "dark" | "light" | "system". Shared
 * between main (theme module + IPC handler) and renderer (settings panel +
 * inline FOUC script) so the string never drifts.
 */
export const THEME_SETTING_KEY = "theme";

/** zod schema for the theme preference (used by SetThemeSchema). */
export const ThemeNameSchema = z.enum(["dark", "light", "system"]);

/**
 * Display mode for the center pane:
 *  - "single" (default): clicking a thread in the left bar replaces the
 *    center pane content (legacy behavior).
 *  - "tabs": threads accumulate as tabs along the top of the center pane.
 *    Closing a tab leaves any in-flight turn running in the background;
 *    re-opening the thread restores the live state.
 *
 * Persisted in the `settings` table under this key; the renderer reads it
 * at boot via the generic `setting.get` IPC and applies it to the
 * sessionStore's `displayMode` field.
 */
export const DISPLAY_MODE_SETTING_KEY = "ui.displayMode";

/** zod schema + TS union for the display-mode preference. */
export const DisplayModeSchema = z.enum(["single", "tabs"]);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

/**
 * Setting key under which the user's preferred chat content font size (px)
 * is persisted. Value is a numeric string like "14". Validated/clamped in
 * the renderer store action (12–20 px). Mirrors the displayMode pipeline.
 */
export const UI_CHAT_FONT_SIZE_SETTING_KEY = "ui.chatFontSize";

/**
 * Setting key under which the user's preferred right-panel (files / git /
 * terminal) font size (px) is persisted. Value is a numeric string like
 * "14". Validated/clamped in the renderer store action (10–22 px). Drives
 * the `--right-panel-font-size` CSS var (and its `--rp-fs-*` derived
 * variants) plus the xterm terminal fontSize. Mirrors the chatFontSize
 * pipeline.
 */
export const UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY = "ui.rightPanelFontSize";

/**
 * Setting key under which the draggable panel widths are persisted as a JSON
 * object: `{ left, right, bottomTerminal, editor }`.
 *  - `left` / `right`: side-bar widths in px (clamped 180–500 / 240–640).
 *  - `bottomTerminal`: bottom terminal bar height in px (clamped 80–600).
 *  - `editor`: editor-column share of the center pane as a percentage 0–100
 *    (clamped 20–80); the chat column gets the remainder.
 * Hydrated + clamped in sessionStore.init(); written (debounced) on drag end.
 */
export const UI_PANE_WIDTHS_SETTING_KEY = "ui.paneWidths";

/**
 * Setting key under which the user's custom user-message background color
 * is persisted. Value is a space-separated "R G B" triplet (e.g.
 * "124 58 237") so it composes with Tailwind's <alpha-value> placeholder.
 * An empty string / null means "use the theme default" (the --user-bubble
 * CSS var defined in styles.css per :root/.dark).
 */
export const UI_USER_MSG_COLOR_SETTING_KEY = "ui.userMessageColor";

/**
 * Setting key under which the user's custom brand/accent color is persisted.
 * Value is a space-separated "R G B" triplet (e.g. "5 150 105") so it
 * composes with Tailwind's <alpha-value> placeholder via the `accent` color
 * token. An empty string / null means "use the theme default" (the --accent
 * CSS var defined in styles.css per :root/.dark — emerald-600 in light,
 * emerald-500 in dark). Unlike --user-bubble (chat-only), --accent is the
 * global emphasis color: buttons, links, selected states, focus rings, and
 * the accent highlights in the three prompt cards all follow it.
 */
export const UI_ACCENT_COLOR_SETTING_KEY = "ui.accentColor";

/**
 * Setting key under which the active right-panel tab is persisted.
 * Value is one of "files" | "git". The right panel reads it at boot and
 * restores the last-used tab. (Terminal used to live here as a tab but moved
 * to the bottom bar, and Browser was a P5 placeholder that has since been
 * removed — a persisted value of "terminal" or "browser" is rejected by the
 * schema on hydrate and falls back to "files".)
 */
export const UI_RIGHT_PANEL_TAB_SETTING_KEY = "ui.rightPanelTab";

/** zod schema + TS union for the right-panel tab preference. */
export const RightPanelTabSchema = z.enum(["files", "git"]);
export type RightPanelTab = z.infer<typeof RightPanelTabSchema>;

/**
 * Setting key under which the IDE file editor's open-file list is persisted.
 * Value is a JSON-encoded `string[]` of absolute file paths (the tabs open in
 * the Monaco editor area). Empty/unset = no files open. Restored at boot so
 * the editor state survives restarts. Paths that no longer exist on disk are
 * dropped silently on first open.
 */
export const UI_IDE_OPEN_FILES_SETTING_KEY = "ui.ideOpenFiles";

/**
 * Setting key under which the IDE file editor's active file is persisted.
 * Value is an absolute file path, or empty/null for "none". Must be a member
 * of the open-files list to take effect.
 */
export const UI_IDE_ACTIVE_FILE_SETTING_KEY = "ui.ideActiveFile";

/**
 * Setting key under which the IDE file-tree's expanded directories are
 * persisted. Value is a JSON-encoded `string[]` of absolute directory paths.
 * Restored at boot so the tree re-opens to where the user left it.
 */
export const UI_IDE_EXPANDED_DIRS_SETTING_KEY = "ui.ideExpandedDirs";

/**
 * Setting key under which the IDE editor's open-mode preference is persisted.
 *  - "tabs"    (default): each opened file accumulates as a tab in the editor
 *               area; the user can have several files open and switch between
 *               them.
 *  - "replace": opening a file replaces whatever was previously open, so at
 *               most one file is ever shown (simpler, lower-clutter).
 * Persisted as one of the two literals; restored at boot.
 */
export const UI_IDE_EDITOR_MODE_SETTING_KEY = "ui.ideEditorMode";

/**
 * Setting key under which the custom-model id used for git-commit-message
 * generation is persisted. Value is a config id from CustomModelStore, or
 * empty/null for "use built-in model". Shared between main (the generator
 * handler resolves the config) and renderer (the settings panel reads/writes).
 */
export const UI_COMMIT_GEN_MODEL_SETTING_KEY = "ui.commitGenModel";

/**
 * Setting key under which the prompt template for commit-message generation
 * is persisted. Value is a string; the staged diff is appended after it.
 * Empty/unset → use a built-in default prompt.
 */
export const UI_COMMIT_GEN_PROMPT_SETTING_KEY = "ui.commitGenPrompt";

/**
 * Setting key for per-repo collapsed state in the Git panel. Value is a
 * JSON-encoded `Record<string, boolean>` mapping repo paths to collapsed
 * state. Persisted so the collapsed/expanded state survives restarts.
 */
export const UI_GIT_COLLAPSED_REPOS_SETTING_KEY = "ui.gitCollapsedRepos";

/**
 * Setting key under which the user's saved terminal quick-commands are
 * persisted. Value is a JSON-encoded `CustomCommand[]` (name + command + id).
 * The terminal toolbar's commands menu reads/writes it so saved commands
 * survive restarts and stay in sync across terminal instances.
 */
export const UI_CUSTOM_COMMANDS_SETTING_KEY = "ui.customCommands";

/** One user-saved terminal quick-command. `id` is a stable client-side id
 *  (used as the React key and for edit/delete targeting); `name` is the menu
 *  label; `command` is the shell text written to the PTY (run verbatim). */
export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

/** zod schema + TS union for the IDE editor open-mode preference. */
export const IdeEditorModeSchema = z.enum(["tabs", "replace"]);
export type IdeEditorMode = z.infer<typeof IdeEditorModeSchema>;

/** Per-file view mode for the center file editor.
 *  - "edit": editable Monaco instance
 *  - "diff": read-only Monaco DiffEditor (vs a before-snapshot)
 *  - "preview": rendered Markdown preview (read-only)
 *  Markdown files default to "preview" on first open; the user can toggle back
 *  to "edit". Pure renderer state - not validated over IPC. */
export type FileViewMode = "edit" | "diff" | "preview";

/**
 * Permission mode literals accepted by the Claude Agent SDK's
 * `permissionMode` option (and the CLI's --permission-mode flag). Kept in
 * lock-step with the `PermissionMode` union in `./runtime.ts`; the renderer's
 * composer only shows 4 of these, but the contract round-trips all 6 so
 * values that arrive via --resume or settings sync aren't dropped.
 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;
export const PermissionModeSchema = z.enum(PERMISSION_MODES);

/* ──────────────────────────  Renderer → Main (RPC)  ────────────────────────── */

export const StartSessionSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  /** Provider id — which AI backend to use. Defaults to "claude-sdk". */
  providerId: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).default("default"),
  permissionMode: PermissionModeSchema.default("default"),
  /** Id of a custom-model config to bind to this session (omit/null = built-in). */
  customModelId: z.string().nullable().optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionSchema>;

export const SendTurnSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  attachments: z.array(z.string()).optional(),
  /** Override session-scoped settings for this turn (reflects current UI state). */
  model: z.string().optional(),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).optional(),
  permissionMode: PermissionModeSchema.optional(),
  /** Override the session's bound custom model for this turn. null = clear
   *  (use built-in credential discovery); a string = bind to that config. */
  customModelId: z.string().nullable().optional(),
});
export type SendTurnInput = z.infer<typeof SendTurnSchema>;

export const InterruptSchema = z.object({ sessionId: z.string() });
export type InterruptInput = z.infer<typeof InterruptSchema>;

export const ApproveSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  granted: z.boolean(),
  always: z.boolean().optional(),
});
export type ApproveInput = z.infer<typeof ApproveSchema>;

/* Answer to an AskUserQuestion. `requestId` matches the question.ask event.
 * Each value is one question's answer: option label (string), labels
 * (string[] for multi-select), or null (skipped). See UserInputAnswers. */
export const RespondQuestionSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
});
export type RespondQuestionInput = {
  sessionId: string;
  requestId: string;
  answers: UserInputAnswers;
};

/* User's decision on a pending ExitPlanMode plan-approval request. `requestId`
 * matches the plan.approval_request event. The decision fields (approved /
 * editedPlan / reason) mirror PlanApprovalDecision in provider.ts; we spell
 * them out here so zod's inferred type matches without a circular import. */
export const RespondPlanApprovalSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  approved: z.boolean(),
  editedPlan: z.string().optional(),
  reason: z.string().optional(),
});
export type RespondPlanApprovalInput = z.infer<typeof RespondPlanApprovalSchema>;

/* Rewind the most recent turn: restore all files Edit/Write touched to
 * their pre-turn state. Main process resolves paths against the
 * session's cwd and refuses any path that escapes it (path-traversal
 * guard). */
export const RewindTurnSchema = z.object({
  sessionId: z.string(),
});
export type RewindTurnInput = z.infer<typeof RewindTurnSchema>;

/* Per-session settings update (model / effort / permissionMode / customModelId).
 * Only the fields present in the payload are persisted; omitted fields are
 * left as-is. */
export const UpdateSessionSettingsSchema = z.object({
  sessionId: z.string(),
  model: z.string().optional(),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).optional(),
  permissionMode: PermissionModeSchema.optional(),
  customModelId: z.string().nullable().optional(),
});
export type UpdateSessionSettingsInput = z.infer<typeof UpdateSessionSettingsSchema>;

export const CreateProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

/* Project / session lifecycle: archive (soft-delete, restorable) and delete
 * (hard, cascading — projects take their sessions+messages with them via the
 * DB's ON DELETE CASCADE). */
export const DeleteProjectSchema = z.object({ id: z.string() });
export const ArchiveProjectSchema = z.object({ id: z.string(), archived: z.boolean() });
export const DeleteSessionSchema = z.object({ id: z.string() });
export const ArchiveSessionSchema = z.object({ id: z.string(), archived: z.boolean() });

/** List a project's sessions with optional pagination + archived filter.
 *  The left-bar tree loads the first `limit` (default 5) non-archived threads
 *  and appends the next page on "load more"; the archived bin requests
 *  `archived: true` (unpaginated). `hasMore` / `total` let the UI decide
 *  whether to render the "load more" affordance. */
export const ProjectSessionsSchema = z.object({
  projectId: z.string(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
});
export type ProjectSessionsInput = z.infer<typeof ProjectSessionsSchema>;

/* A persisted message: content is opaque JSON (text/thinking/tool_use blocks).
 * P2's renderer serializes its ChatMessage.blocks array here.
 * We use z.custom<unknown>() for content: zod treats z.unknown()/z.any() as
 * optional in its inferred type, which would mismatch MessageRecord.content
 * (required `unknown`). z.custom() preserves the exact type we give it. */
export const MessageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.custom<unknown>((v) => v !== undefined, "content is required"),
  createdAt: z.number(),
});

export const SessionMessagesSchema = z.object({ sessionId: z.string() });
export type SessionMessagesInput = z.infer<typeof SessionMessagesSchema>;

export const SaveMessagesSchema = z.object({
  sessionId: z.string(),
  /** Full message snapshot for the session — replaces whatever is stored. */
  messages: z.array(MessageRecordSchema),
});
/**
 * We type `messages` against the domain MessageRecord rather than z.infer,
 * because zod renders z.unknown()/z.any() content as optional, which would
 * mismatch MessageRecord.content (required). The schema still validates shape
 * at runtime; the type is asserted to match the domain model.
 */
export type SaveMessagesInput = { sessionId: string; messages: MessageRecord[] };

/* ── Settings & claude path config ── */
export const GetSettingSchema = z.object({ key: z.string() });
export type GetSettingInput = z.infer<typeof GetSettingSchema>;

export const SetSettingSchema = z.object({ key: z.string(), value: z.string() });
export type SetSettingInput = z.infer<typeof SetSettingSchema>;

export const TestClaudePathSchema = z.object({ path: z.string() });
export type TestClaudePathInput = z.infer<typeof TestClaudePathSchema>;

/** Result of probing a configured claude path by running `claude --version`. */
export interface TestClaudePathResult {
  ok: boolean;
  /** claude's version string on success. */
  version?: string;
  /** Error message on failure (not found / non-zero exit / timeout). */
  error?: string;
}

/* ── Custom model configs (user-defined Anthropic-compatible endpoints) ── */

/** Single tier binding within a custom-model config. Every field is optional;
 *  a role with no `requestModel` is simply treated as unbound. */
const RoleBindingSchema = z.object({
  displayName: z.string().optional(),
  requestModel: z.string().optional(),
  supports1m: z.boolean().optional(),
});

/** Per-config role bindings for the five Claude Code tiers. Any subset of
 *  keys may be present. */
const RoleBindingsSchema = z.object({
  haiku: RoleBindingSchema.optional(),
  sonnet: RoleBindingSchema.optional(),
  opus: RoleBindingSchema.optional(),
  fable: RoleBindingSchema.optional(),
  subagent: RoleBindingSchema.optional(),
});

const AuthModeSchema = z.enum(["auth_token", "api_key"]);

/** Save (create or update) a custom-model config. On update, an omitted
 *  `authToken` keeps the existing stored token; on create, `authToken` is
 *  required. At least one role must have a `requestModel` (enforced in the
 *  UI/handler — zod can't easily express "≥1 non-empty nested field"). */
export const SaveCustomModelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  authToken: z.string().optional(),
  roles: RoleBindingsSchema,
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
});
export type SaveCustomModelInput = CustomModelInput;

export const DeleteCustomModelSchema = z.object({ id: z.string() });

/** Probe a custom endpoint using the supplied (not-yet-saved) values, so the
 *  user can verify auth/baseUrl/a-specific-model before committing. The probe
 *  tests ONE model at a time (the user picks which role/model in the UI). */
export const TestCustomModelSchema = z.object({
  baseUrl: z.string().min(1),
  authToken: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  /** The single requestModel to probe in this request. */
  model: z.string().min(1),
  /** Whether to declare 1M context (sets betas) — mirrors the role's toggle. */
  supports1m: z.boolean().optional(),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
});
export type TestCustomModelInput = z.infer<typeof TestCustomModelSchema>;

/* ── Theme / color scheme ── */

export const SetThemeSchema = z.object({ theme: ThemeNameSchema });
export type SetThemeInput = z.infer<typeof SetThemeSchema>;
export type GetThemeResult = { theme: ThemeName; effective: EffectiveTheme };

/* ── File operations (read / list dir / write) ── */

/** Read a single file's current content as utf-8 text. The main handler
 *  resolves the path against the session's project cwd and refuses anything
 *  that escapes it (path-traversal guard) — the renderer (contextIsolation)
 *  has no filesystem access of its own. Used by the turn-files diff card to
 *  fetch the post-turn content to diff against the snapshotted `before`. */
export const FileReadSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
});
export type FileReadInput = z.infer<typeof FileReadSchema>;

/** One entry returned by `file.listDir`. `path` is the absolute filesystem
 *  path (already validated to sit inside a project root); `name` is the base
 *  name for display. `size` is only populated for files (bytes). */
export interface FileTreeEntry {
  name: string;
  /** Absolute path (cwd-resolved + validated by main). */
  path: string;
  isDir: boolean;
  /** File size in bytes (omitted for directories). */
  size?: number;
}

/** List a single level of a directory (non-recursive). `dirPath` is relative
 *  to `projectPath` (empty string = the project root itself). Main resolves
 *  it, refuses escapes, filters out ignored entries (node_modules, .git, …),
 *  and returns entries sorted directories-first then alphabetical. On any
 *  read failure the handler returns `{ entries: [] }` so the tree degrades
 *  gracefully rather than throwing into the renderer. */
export const FileListDirSchema = z.object({
  /** Absolute path of the project root the listing is scoped to. Must match a
   *  persisted Project.path — main cross-checks this against ProjectRepo. */
  projectPath: z.string(),
  /** Directory to list, relative to projectPath. "" or "." = root. */
  dirPath: z.string(),
});
export type FileListDirInput = z.infer<typeof FileListDirSchema>;

/** Write utf-8 content to a file, creating it (and parent dirs) if absent.
 *  Path must resolve inside a known project root (path-traversal guard,
 *  same as readFile). Returns `{ ok }`; on refusal or failure `ok` is false
 *  and the handler logs — the renderer surfaces a non-blocking error. */
export const FileWriteSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
  content: z.string(),
});
export type FileWriteInput = z.infer<typeof FileWriteSchema>;

/* ── Git operations (status / stage / commit / push / pull / diff) ──
 *  All git operations are scoped to a `repoPath` that must resolve inside a
 *  known project root. A single project folder may host MULTIPLE git repos
 *  (monorepo, submodules, nested projects) — `git.discoverRepos` finds them. */

/** A git repository discovered under a project folder. `path` is the absolute
 *  repo root (the directory containing `.git`). `name` is the relative path
 *  from the project root (or the basename for the root itself). */
export interface GitRepo {
  /** Absolute path to the repo root (contains `.git`). */
  path: string;
  /** Display name: path relative to the project root, or the folder name. */
  name: string;
  /** Always true — discriminator for future result unions. */
  isRepo: true;
}

/** Git status code for a single file, mirroring porcelain output. `index` is
 *  the staged (cached) status; `workingTree` is the unstaged status. Both use
 *  the same union of git status codes. */
export type GitStatusCode =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "ignored"
  | "untracked";

/** One file's status in a repo. `path` is relative to the repo root. */
export interface GitFileStatus {
  path: string;
  /** Staged status (what's in the index vs HEAD). */
  index: GitStatusCode;
  /** Working-tree status (what's on disk vs the index). */
  workingTree: GitStatusCode;
}

/** Full status of a single repo. */
export interface GitStatusResult {
  /** Current branch name (empty in detached HEAD). */
  branch: string;
  /** Commits ahead of upstream (0 if no upstream). */
  ahead: number;
  /** Commits behind upstream (0 if no upstream). */
  behind: number;
  /** All changed files (staged + unstaged + untracked). */
  files: GitFileStatus[];
}

/** Result of a git operation that may fail (push/pull/commit). `ok` is false
 *  on any error; `error` carries a human-readable message (e.g. auth failure,
 *  no upstream, merge conflict). */
export interface GitOpResult {
  ok: boolean;
  /** Error message when ok is false. */
  error?: string;
}

/** Discover all git repos under a project root (recursive, max depth 3). */
export const GitDiscoverReposSchema = z.object({
  projectPath: z.string(),
});
export type GitDiscoverReposInput = z.infer<typeof GitDiscoverReposSchema>;

/** Input for operations targeting a single repo. */
export const GitRepoPathSchema = z.object({
  repoPath: z.string(),
});
export type GitRepoPathInput = z.infer<typeof GitRepoPathSchema>;

/** Stage (git add) specific files. `filePaths` are relative to the repo root. */
export const GitStageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitStageInput = z.infer<typeof GitStageSchema>;

/** Unstage (git reset) specific files. `filePaths` are relative to the repo root. */
export const GitUnstageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitUnstageInput = z.infer<typeof GitUnstageSchema>;

/** Commit staged changes with a message. */
export const GitCommitSchema = z.object({
  repoPath: z.string(),
  message: z.string().min(1),
});
export type GitCommitInput = z.infer<typeof GitCommitSchema>;

/** Diff of a single file. `filePath` is relative to repo. When `staged` is
 *  true, diffs the index against HEAD (what will be committed); otherwise
 *  diffs the working tree against the index (unstaged changes). */
export const GitDiffSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  /** If true, show staged (cached) diff — index vs HEAD. */
  staged: z.boolean().optional(),
});
export type GitDiffInput = z.infer<typeof GitDiffSchema>;

/** Discard (revert) local changes to specific files. For tracked files this
 *  runs `git checkout -- <files>` (restores to index/HEAD); for untracked files
 *  it runs `git clean -f -- <files>` (removes them). The handler decides per
 *  file based on its status. */
export const GitDiscardSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitDiscardInput = z.infer<typeof GitDiscardSchema>;

/** Generate a commit message from the staged diff using an LLM.
 *  `repoPath` scopes the diff; `customModelId` + `customModelRole` select the
 *  specific model (a config + its role binding); `prompt` is the user's
 *  configured prompt template. The handler collects the staged diff, feeds
 *  it to the model via a one-shot SDK query, and returns the generated text. */
export const GitGenerateCommitSchema = z.object({
  repoPath: z.string(),
  /** Custom-model config id (from CustomModelStore). null = use built-in. */
  customModelId: z.string().nullable(),
  /** Which role binding within the config to use (e.g. "sonnet"). Ignored
   *  when customModelId is null. */
  customModelRole: z.string().nullable(),
  /** The user's prompt template. The diff is appended after this. */
  prompt: z.string(),
});
export type GitGenerateCommitInput = z.infer<typeof GitGenerateCommitSchema>;

/* ── Git history (log / show commit / show file at revision) ── */

/** One commit in a `git.log` / `git.showCommit` result. */
export interface GitCommitInfo {
  /** Full commit hash. */
  hash: string;
  /** Abbreviated hash (typically 7 chars). */
  shortHash: string;
  /** First line of the commit message. */
  subject: string;
  /** Remaining body after the subject (may be empty). */
  body?: string;
  /** Author display name. */
  author: string;
  /** Author date as ISO-8601 string. */
  authoredAt: string;
  /** Parent commit hashes (empty for root commits). Present on showCommit. */
  parents?: string[];
}

/** File change status inside a single commit (relative to its parent). */
export type GitCommitFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied";

/** One file changed by a commit. */
export interface GitCommitFile {
  /** Path relative to the repo root (new path for renames). */
  path: string;
  status: GitCommitFileStatus;
  /** Previous path when status is renamed/copied. */
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

/** Full detail for one commit: meta + changed files. */
export interface GitCommitDetail {
  commit: GitCommitInfo;
  files: GitCommitFile[];
}

/** Paginated commit log. `limit` defaults to 50; `skip` defaults to 0. */
export const GitLogSchema = z.object({
  repoPath: z.string(),
  /** Max commits to return (default 50, max 200). */
  limit: z.number().int().min(1).max(200).optional(),
  /** Number of commits to skip (for pagination). */
  skip: z.number().int().min(0).optional(),
  /** Optional ref to start from (branch/tag/hash). Defaults to HEAD.
   *  Restricted to safe ref characters to avoid CLI injection. */
  ref: z
    .string()
    .regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref")
    .optional(),
});
export type GitLogInput = z.infer<typeof GitLogSchema>;

/** Commit hashes are restricted to hex so callers cannot inject CLI args. */
const GitCommitHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{4,40}$/, "invalid commit hash");

/** Load meta + changed-file list for one commit. */
export const GitShowCommitSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
});
export type GitShowCommitInput = z.infer<typeof GitShowCommitSchema>;

/** Load parent-vs-commit file contents for Monaco diff. */
export const GitShowFileSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
  /** Path relative to the repo root (new path for renames). */
  filePath: z.string().min(1),
  /** Previous path when the file was renamed/copied in this commit. */
  oldPath: z.string().optional(),
});
export type GitShowFileInput = z.infer<typeof GitShowFileSchema>;

/* ──────────────────────────  Main → Renderer (events)  ─────────────────────── */

export interface ClaudeEventMessage {
  channel: "claude:event";
  sessionId: string;
  event: RuntimeEvent;
}

export interface TerminalDataMessage {
  channel: "terminal:data";
  terminalId: string;
  data: string;
}

/** Fired when a PTY process exits (user typed `exit`, shell crashed, or kill). */
export interface TerminalExitMessage {
  channel: "terminal:exit";
  terminalId: string;
  /** Process exit code, or null if killed by signal / unknown. */
  exitCode: number | null;
}

export type MainToRendererMessage =
  | ClaudeEventMessage
  | TerminalDataMessage
  | TerminalExitMessage
  | ThemeChangedMessage;

/* ── Integrated terminal (xterm.js + node-pty) ──
 *  PTY processes live in main. Renderer only sees opaque terminalIds and
 *  streams data over push channels. Every create is scoped to a known
 *  project root (cwd must resolve inside that root). */

/** Setting key for the user-preferred shell executable (absolute path or
 *  bare command name). Empty/absent → platform smart default. */
export const TERMINAL_SHELL_SETTING_KEY = "terminal.shell";

/** Snapshot of a live (or just-exited) terminal session. */
export interface TerminalInfo {
  terminalId: string;
  /** Absolute cwd the PTY was spawned with. */
  cwd: string;
  /** Resolved shell executable path/name. */
  shell: string;
  /** OS process id while alive; 0 after exit. */
  pid: number;
  /** Project root this terminal is bound to. */
  projectPath: string;
}

/** Create a new PTY bound to a project. `cwd` defaults to `projectPath`. */
export const TerminalCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional working directory; must resolve inside projectPath. */
  cwd: z.string().min(1).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  /** Optional shell override for this session only. */
  shell: z.string().min(1).optional(),
});
export type TerminalCreateInput = z.infer<typeof TerminalCreateSchema>;

export const TerminalWriteSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});
export type TerminalWriteInput = z.infer<typeof TerminalWriteSchema>;

export const TerminalResizeSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeSchema>;

export const TerminalKillSchema = z.object({
  terminalId: z.string().min(1),
});
export type TerminalKillInput = z.infer<typeof TerminalKillSchema>;

export const TerminalListSchema = z.object({
  /** When set, only terminals bound to this project root are returned. */
  projectPath: z.string().min(1).optional(),
});
export type TerminalListInput = z.infer<typeof TerminalListSchema>;

/** Structured result for create — either success fields or ok:false + error. */
export type TerminalCreateResult =
  | {
      ok: true;
      terminalId: string;
      pid: number;
      cwd: string;
      shell: string;
    }
  | { ok: false; error: string };

export interface TerminalOpResult {
  ok: boolean;
  error?: string;
}

/* ──────────────────────────  RPC method map  ───────────────────────────────── */

/** A typed map of all renderer→main RPC invocations. The preload exposes a
 * typed `window.api` matching this shape; the renderer imports it for safety. */
export interface RpcMap {
  // Claude
  "claude.startSession": (input: StartSessionInput) => Promise<{ session: Session }>;
  /** Returns the (possibly retitled) session so the renderer can refresh. */
  "claude.sendTurn": (input: SendTurnInput) => Promise<{ session: Session }>;
  "claude.interrupt": (input: InterruptInput) => Promise<void>;
  "claude.approve": (input: ApproveInput) => Promise<void>;
  /** Submit the user's answers to a pending AskUserQuestion. */
  "claude.respondQuestion": (input: RespondQuestionInput) => Promise<void>;
  /** Submit the user's approve/reject decision on a pending ExitPlanMode plan. */
  "claude.respondPlanApproval": (input: RespondPlanApprovalInput) => Promise<void>;
  /** Rewind the most recent turn: restore all files that Edit/Write
   *  touched in that turn to their pre-turn state. Returns the list of
   *  paths that were actually restored (failed paths are silently
   *  logged in main). */
  "claude.rewindTurn": (input: RewindTurnInput) => Promise<{ restored: string[] }>;
  /** Update the active session's model / effort / permissionMode / customModelId in-place. */
  "session.updateSettings": (input: UpdateSessionSettingsInput) => Promise<void>;
  // Projects
  "project.create": (input: CreateProjectInput) => Promise<{ project: Project }>;
  "project.list": () => Promise<{ projects: Project[] }>;
  "project.sessions": (input: ProjectSessionsInput) => Promise<{ sessions: Session[]; hasMore: boolean; total: number }>;
  /** Hard-delete a project; its sessions + messages cascade-delete (DB FK). */
  "project.delete": (input: { id: string }) => Promise<void>;
  /** Set a project's archived flag (soft-delete; restorable). */
  "project.archive": (input: { id: string; archived: boolean }) => Promise<{ project: Project }>;
  // Sessions (P2 persistence)
  "session.messages": (input: SessionMessagesInput) => Promise<{ messages: MessageRecord[] }>;
  "session.saveMessages": (input: SaveMessagesInput) => Promise<void>;
  /** Hard-delete a session; its messages cascade-delete (DB FK). */
  "session.delete": (input: { id: string }) => Promise<void>;
  /** Set a session's archived flag (soft-delete; restorable). */
  "session.archive": (input: { id: string; archived: boolean }) => Promise<{ session: Session }>;
  // Providers
  "provider.list": () => Promise<{
    providers: Array<{ id: string; displayName: string; capabilities: ProviderCapabilities }>;
  }>;
  // Settings & claude path
  "setting.get": (input: GetSettingInput) => Promise<{ value: string | null }>;
  "setting.set": (input: SetSettingInput) => Promise<void>;
  "claude.testPath": (input: TestClaudePathInput) => Promise<TestClaudePathResult>;
  "dialog.pickFile": () => Promise<{ path: string | null }>;
  // Custom models (user-defined Anthropic-compatible endpoints)
  "customModel.list": () => Promise<{ models: CustomModelPublic[] }>;
  "customModel.save": (input: SaveCustomModelInput) => Promise<{ models: CustomModelPublic[] }>;
  "customModel.delete": (input: { id: string }) => Promise<{ models: CustomModelPublic[] }>;
  "customModel.test": (input: TestCustomModelInput) => Promise<TestCustomModelResult>;
  // Theme / color scheme
  "theme.get": () => Promise<GetThemeResult>;
  "theme.set": (input: SetThemeInput) => Promise<GetThemeResult>;
  // File read (on-demand diff rendering)
  "file.readFile": (input: FileReadInput) => Promise<{ content: string }>;
  /** List one level of a directory (non-recursive), scoped to a project root. */
  "file.listDir": (input: FileListDirInput) => Promise<{ entries: FileTreeEntry[] }>;
  /** Write content to a file (creates parents), scoped to a project root. */
  "file.writeFile": (input: FileWriteInput) => Promise<{ ok: boolean }>;
  // Git operations (P4 Git panel)
  /** Discover all git repos under a project root (recursive, max depth 3). */
  "git.discoverRepos": (input: GitDiscoverReposInput) => Promise<{ repos: GitRepo[] }>;
  /** Get the status of a single repo (branch / ahead / behind / files). */
  "git.status": (input: GitRepoPathInput) => Promise<{ status: GitStatusResult }>;
  /** Stage (git add) specific files. */
  "git.stage": (input: GitStageInput) => Promise<GitOpResult>;
  /** Unstage (git reset) specific files. */
  "git.unstage": (input: GitUnstageInput) => Promise<GitOpResult>;
  /** Commit staged changes with a message. */
  "git.commit": (input: GitCommitInput) => Promise<GitOpResult>;
  /** Push local commits to the upstream remote. */
  "git.push": (input: GitRepoPathInput) => Promise<GitOpResult>;
  /** Pull remote changes into the current branch. */
  "git.pull": (input: GitRepoPathInput) => Promise<GitOpResult>;
  /** Get the unstaged diff patch for a single file. */
  "git.diff": (input: GitDiffInput) => Promise<{ patch: string }>;
  /** Discard local changes to specific files (checkout tracked / clean untracked). */
  "git.discard": (input: GitDiscardInput) => Promise<GitOpResult>;
  /** Generate a commit message from the staged diff via an LLM one-shot call. */
  "git.generateCommitMessage": (input: GitGenerateCommitInput) => Promise<{ ok: boolean; message?: string; error?: string }>;
  /** Paginated commit log for a repo (newest first). */
  "git.log": (input: GitLogInput) => Promise<{ commits: GitCommitInfo[]; hasMore: boolean }>;
  /** Meta + changed files for one commit. */
  "git.showCommit": (input: GitShowCommitInput) => Promise<GitCommitDetail | null>;
  /** Parent-vs-commit file contents for a single path (Monaco diff). */
  "git.showFile": (
    input: GitShowFileInput,
  ) => Promise<{ before: string; after: string }>;
  // Integrated terminal (P4 IDE right panel)
  /** Spawn a PTY in the project cwd (or a subdir). */
  "terminal.create": (input: TerminalCreateInput) => Promise<TerminalCreateResult>;
  /** Write raw input bytes/text to a live PTY. */
  "terminal.write": (input: TerminalWriteInput) => Promise<TerminalOpResult>;
  /** Notify the PTY of a cols/rows change (after xterm fit). */
  "terminal.resize": (input: TerminalResizeInput) => Promise<TerminalOpResult>;
  /** Kill a PTY process and drop it from the manager. */
  "terminal.kill": (input: TerminalKillInput) => Promise<TerminalOpResult>;
  /** List live terminals, optionally filtered by project. */
  "terminal.list": (input: TerminalListInput) => Promise<{ terminals: TerminalInfo[] }>;
}

/** The channel names used in invoke/handle and send/on. Keep these centralized
 * so the preload allowlist and the main handlers never drift. */
export const IPC = {
  // invoke/handle (RPC)
  CLAUDE_START_SESSION: "claude:startSession",
  CLAUDE_SEND_TURN: "claude:sendTurn",
  CLAUDE_INTERRUPT: "claude:interrupt",
  CLAUDE_APPROVE: "claude:approve",
  CLAUDE_RESPOND_QUESTION: "claude:respondQuestion",
  CLAUDE_RESPOND_PLAN_APPROVAL: "claude:respondPlanApproval",
  CLAUDE_REWIND_TURN: "claude:rewindTurn",
  PROJECT_CREATE: "project:create",
  PROJECT_LIST: "project:list",
  PROJECT_SESSIONS: "project:sessions",
  PROJECT_DELETE: "project:delete",
  PROJECT_ARCHIVE: "project:archive",
  SESSION_DELETE: "session:delete",
  SESSION_ARCHIVE: "session:archive",
  SESSION_MESSAGES: "session:messages",
  SESSION_SAVE_MESSAGES: "session:saveMessages",
  SESSION_UPDATE_SETTINGS: "session:updateSettings",
  PROVIDER_LIST: "provider:list",
  // Settings & claude path config
  SETTING_GET: "setting:get",
  SETTING_SET: "setting:set",
  CLAUDE_TEST_PATH: "claude:testPath",
  DIALOG_PICK_FILE: "dialog:pickFile",
  // Custom models (user-defined Anthropic-compatible endpoints)
  CUSTOM_MODEL_LIST: "customModel:list",
  CUSTOM_MODEL_SAVE: "customModel:save",
  CUSTOM_MODEL_DELETE: "customModel:delete",
  CUSTOM_MODEL_TEST: "customModel:test",
  // Theme / color scheme
  THEME_GET: "theme:get",
  THEME_SET: "theme:set",
  // File read (on-demand diff rendering)
  FILE_READ: "file:readFile",
  // File tree listing + writing (P4 IDE right panel)
  FILE_LIST_DIR: "file:listDir",
  FILE_WRITE: "file:writeFile",
  // Git operations (P4 Git panel)
  GIT_DISCOVER_REPOS: "git:discoverRepos",
  GIT_STATUS: "git:status",
  GIT_STAGE: "git:stage",
  GIT_UNSTAGE: "git:unstage",
  GIT_COMMIT: "git:commit",
  GIT_PUSH: "git:push",
  GIT_PULL: "git:pull",
  GIT_DIFF: "git:diff",
  GIT_DISCARD: "git:discard",
  GIT_GENERATE_COMMIT: "git:generateCommitMessage",
  GIT_LOG: "git:log",
  GIT_SHOW_COMMIT: "git:showCommit",
  GIT_SHOW_FILE: "git:showFile",
  // Integrated terminal (P4 IDE right panel)
  TERMINAL_CREATE: "terminal:create",
  TERMINAL_WRITE: "terminal:write",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_KILL: "terminal:kill",
  TERMINAL_LIST: "terminal:list",
  // send/on (push events)
  CLAUDE_EVENT: "claude:event",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_EXIT: "terminal:exit",
  THEME_CHANGED: "theme:changed",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
