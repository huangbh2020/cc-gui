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
 * Setting key under which the user's color-scheme preference is persisted.
 * Value is one of {@link ThemeName}: "dark" | "light" | "system". Shared
 * between main (theme module + IPC handler) and renderer (settings panel +
 * inline FOUC script) so the string never drifts.
 */
export const THEME_SETTING_KEY = "theme";

/** zod schema for the theme preference (used by SetThemeSchema). */
export const ThemeNameSchema = z.enum(["dark", "light", "system"]);

/**
 * Setting key under which the auto-update flow state is persisted, so reopening
 * the About panel (or restarting the app mid-download) restores the progress /
 * "ready to install" banner instead of dropping the user back to idle.
 *
 * Value is a JSON-encoded {@link PersistedUpdateState} string. The main process
 * writes it from the autoUpdater event callbacks; the renderer reads it on mount
 * via the generic `setting.get` IPC and clears it after install.
 */
export const UPDATE_STATE_SETTING_KEY = "update.state";

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
 * Setting key under which the custom-model id used for AI git-conflict
 * resolution is persisted. Same shape as UI_COMMIT_GEN_MODEL_SETTING_KEY
 * (`"configId:roleKey"`); null/empty = use the built-in model. Shared
 * between main (the resolve handler resolves the config) and renderer
 * (the settings panel reads/writes).
 */
export const UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY = "ui.conflictResolveModel";

/**
 * Setting key for per-repo collapsed state in the Git panel. Value is a
 * JSON-encoded `Record<string, boolean>` mapping repo paths to collapsed
 * state. Persisted so the collapsed/expanded state survives restarts.
 */
export const UI_GIT_COLLAPSED_REPOS_SETTING_KEY = "ui.gitCollapsedRepos";

/**
 * Setting key under which the user's saved terminal quick-commands are
 * persisted. Value is a JSON-encoded `CustomCommand[]` (name + command + id).
 *
 * @deprecated Replaced by {@link UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY}.
 * Commands are now scoped per-project. This key is no longer read or written
 * by the app; any persisted value is ignored. Kept only to avoid breaking
 * imports - to be removed in a future cleanup.
 */
export const UI_CUSTOM_COMMANDS_SETTING_KEY = "ui.customCommands";

/**
 * Setting key under which per-project terminal quick-commands are persisted.
 * Value is a JSON-encoded `Record<string, CustomCommand[]>` keyed by
 * `projectId`. Mirrors the per-project IDE-state persistence pattern
 * (ui.ideOpenFiles etc.): one setting row holds all projects' command lists,
 * and the renderer re-hydrates the whole map at boot.
 */
export const UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY = "ui.customCommandsByProject";

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

/**
 * Setting key under which the user's preferred way of opening a file diff from
 * the Git panel is persisted.
 *  - "center" (default): the diff opens in the center-area Monaco editor (the
 *               existing behavior - replaces/accumulates as editor tabs).
 *  - "dialog": the diff opens in a floating modal dialog that supports multiple
 *               diff tabs at once. Closing the dialog keeps the tabs; a button
 *               in the Git panel toolbar re-opens it.
 * Persisted as one of the two literals; restored at boot.
 */
export const UI_GIT_DIFF_OPEN_MODE_SETTING_KEY = "ui.gitDiffOpenMode";

/** zod schema + TS union for the git-diff open-mode preference. */
export const GitDiffOpenModeSchema = z.enum(["center", "dialog"]);
export type GitDiffOpenMode = z.infer<typeof GitDiffOpenModeSchema>;

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

/* Rename a session (user-edited title). Title is clamped to a sane length;
 * empty/whitespace-only is rejected by the min(1) on the trimmed value (the
 * store trims before sending). */
export const RenameSessionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
});
export type RenameSessionInput = z.infer<typeof RenameSessionSchema>;

/* Open a path in the OS file manager. The main handler refuses any path that
 * isn't an exact match for a known project root, so the renderer can't ask it
 * to open arbitrary locations. */
export const OpenPathSchema = z.object({ path: z.string() });
export type OpenPathInput = z.infer<typeof OpenPathSchema>;

/* Reveal a file or directory in the OS file manager (Finder / Explorer),
 * selecting it. Unlike `shell.openPath`, this accepts any path that resolves
 * inside a known project root (not just the root itself) - the main handler
 * enforces the same project-root containment check as the file handlers. Used
 * by the file-tree context menu's "Reveal in Explorer" action. */
export const ShowItemInFolderSchema = z.object({ path: z.string() });
export type ShowItemInFolderInput = z.infer<typeof ShowItemInFolderSchema>;

/** Open a file with the OS's default associated application (e.g. .docx in
 *  Word, .pdf in Preview). Accepts any path that resolves inside a known,
 *  non-archived project root - the same containment rule as
 *  `shell.showItemInFolder`. Used by the editor's "unsupported file" pane to
 *  let the user open binary files the editor can't preview. */
export const OpenFileSchema = z.object({ path: z.string() });
export type OpenFileInput = z.infer<typeof OpenFileSchema>;

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

/* ── Settings ── */
export const GetSettingSchema = z.object({ key: z.string() });
export type GetSettingInput = z.infer<typeof GetSettingSchema>;

export const SetSettingSchema = z.object({ key: z.string(), value: z.string() });
export type SetSettingInput = z.infer<typeof SetSettingSchema>;

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

const ProtocolSchema = z.enum(["anthropic", "openai"]);

/** Save (create or update) a custom-model config. On update, an omitted
 *  `authToken` keeps the existing stored token; on create, `authToken` is
 *  required. At least one role must have a `requestModel` (enforced in the
 *  UI/handler — zod can't easily express "≥1 non-empty nested field"). */
export const SaveCustomModelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
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
  protocol: ProtocolSchema.optional(),
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

/* ── App / runtime info (About panel) ── */

/** Runtime info surfaced to the About panel. `appVersion` comes from
 *  Electron's `app.getVersion()` (reads the root package.json in dev, the
 *  built app's version in production); the rest come from `process.versions`
 *  and `process.platform` on the main side. No input - it's a parameterless
 *  RPC. */
export interface AppInfoResult {
  /** App version string (e.g. "0.0.0" in dev, the release version in prod). */
  appVersion: string;
  /** Electron version. */
  electron: string;
  /** Bundled Node.js version. */
  node: string;
  /** Bundled Chromium version. */
  chromium: string;
  /** OS platform: "win32" | "darwin" | "linux". */
  platform: string;
  /** CPU architecture (e.g. "x64", "arm64"). */
  arch: string;
}

/* ── Auto-update (electron-updater, GitHub Releases channel) ── */

/** Result of a manual/auto update check. */
export type CheckForUpdatesResult =
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string }
  | { status: "error"; error: string };

/** Pushed when the updater finds a newer version on the release channel.
 *  Sent right after `update-available` fires in main; the renderer shows a
 *  download prompt. autoDownload is off, so the user opts in. */
export interface UpdateAvailableMessage {
  channel: "update:available";
  /** Version string of the pending update (e.g. "0.2.0"). */
  version: string;
  /** Release notes (markdown or plain) from the release, if any. */
  releaseNotes?: string;
  /** ISO date string of the release, if available. */
  releaseDate?: string;
}

/** Pushed when a downloaded update is ready to install. The renderer offers a
 *  "restart & install" button that calls `app.quitAndInstall`. */
export interface UpdateDownloadedMessage {
  channel: "update:downloaded";
  /** Version string of the downloaded update. */
  version: string;
  /** Release notes (markdown or plain) from the release, if any. */
  releaseNotes?: string;
}

/** Pushed repeatedly while an update downloads, carrying live progress so the
 *  About panel can render a percentage + byte counter instead of a static
 *  spinner. `percent` is 0-100. */
export interface UpdateDownloadProgressMessage {
  channel: "update:downloadProgress";
  /** Version string of the update being downloaded. */
  version: string;
  /** Download progress, 0-100. */
  percent: number;
  /** Bytes transferred so far. */
  transferred: number;
  /** Total bytes to download (0 if unknown). */
  total: number;
  /** Current download speed in bytes/second. */
  bytesPerSecond: number;
}

/** Persisted snapshot of the update flow, stored under
 *  {@link UPDATE_STATE_SETTING_KEY} so the About panel can restore the banner
 *  after being unmounted/remounted or after an app restart. Only the states
 *  worth restoring are persisted - transient checks/errors stay in memory. */
export interface PersistedUpdateState {
  /** "downloading" = an update is mid-download (autoUpdater resumes on boot);
   *  "downloaded" = an update is ready to install on next restart. */
  status: "downloading" | "downloaded";
  /** Version string of the update. */
  version: string;
  /** Last seen download percent (0-100). Only meaningful for "downloading". */
  percent: number;
  /** Bytes transferred so far. Only meaningful for "downloading". */
  transferred: number;
  /** Total bytes (0 if unknown). Only meaningful for "downloading". */
  total: number;
  /** ISO timestamp of when this snapshot was written. */
  updatedAt: string;
}

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

/** Read a file as base64-encoded binary, returned as a `data:` URL ready for an
 *  `<img src=...>`. Used by the editor's image preview pane. Same
 *  project-root path-traversal guard as `file:readFile`. The `mimeType` is
 *  derived from the extension on the main side so the renderer doesn't have to.
 *  On refusal / failure returns `{ dataUrl: "" }` so the renderer can show a
 *  friendly error instead of throwing. */
export const FileReadBinarySchema = z.object({
  /** Absolute path. Must resolve inside a known project root. */
  filePath: z.string(),
});
export type FileReadBinaryInput = z.infer<typeof FileReadBinarySchema>;

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

/**
 * One file hit from `file.search`. Paths are absolute and already validated
 * to sit inside the project root. `relativePath` uses forward slashes for
 * stable display across platforms.
 */
export interface FileSearchEntry {
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Path relative to the project root (forward-slash separated). */
  relativePath: string;
}

/**
 * Recursive file search under a project root for composer @-mention and
 * "add context" pickers. Main walks the tree (skipping the same ignored
 * dirs as listDir), optionally filters by case-insensitive substring on
 * name/relativePath, and returns at most `limit` files. Directories are
 * never returned — only files. Empty query returns a truncated breadth-
 * first sample so the picker has something to show immediately.
 */
export const FileSearchSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Optional case-insensitive filter over file name / relative path. */
  query: z.string().optional(),
  /** Max files to return. Defaults to 80 on the main side. */
  limit: z.number().int().positive().max(2000).optional(),
});
export type FileSearchInput = z.infer<typeof FileSearchSchema>;

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

/** Native multi-file picker (project-external files allowed). Used by the
 *  composer "添加上下文" button to attach files that live outside the active
 *  project root — unlike the project-scoped `file.search`, this surfaces any
 *  file on the user's machine via the OS open dialog. */
export const DialogPickFilesSchema = z.object({
  /** Optional dialog title; defaults to a localized "选择文件" on the main side. */
  title: z.string().optional(),
});
export type DialogPickFilesInput = z.infer<typeof DialogPickFilesSchema>;

/**
 * One line-level match from `file.grep`. `lineNumber` is 1-based. `lineText`
 * is the raw matched line (untrimmed, so column offsets are meaningful).
 * `matches` are 0-based [start,end) column ranges for each occurrence of the
 * query on that line, for frontend highlighting.
 */
export interface FileGrepEntry {
  /** Absolute filesystem path. */
  path: string;
  /** Path relative to the project root (forward-slash separated). */
  relativePath: string;
  /** 1-based line number within the file. */
  lineNumber: number;
  /** Raw text of the matched line. */
  lineText: string;
  /** Column ranges of each query occurrence on this line (0-based [start,end)). */
  matches: Array<{ start: number; end: number }>;
}

/**
 * Grep file contents under a project root. Main walks the same ignored-dir-
 * filtered tree as `file.search`, skips binary files (null-byte sniff on the
 * first ~8KB + a binary-extension skip-list), and scans each text file's
 * lines for the query. Case-insensitive by default. Returns line-level
 * matches, capped at `limit` total and `maxResultsPerFile` per file.
 */
export const FileGrepSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Substring to search for inside file contents. */
  query: z.string(),
  /** Max total matches to return. Defaults to 200 on the main side. */
  limit: z.number().int().positive().max(500).optional(),
  /** Max matches per single file. Defaults to 10 on the main side. */
  maxResultsPerFile: z.number().int().positive().max(50).optional(),
  /** Case-sensitive match. Defaults to false. */
  caseSensitive: z.boolean().optional(),
});
export type FileGrepInput = z.infer<typeof FileGrepSchema>;

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
  /** Set by `git:pull` when the pull produced a merge conflict. The repo is
   *  now in a conflicted (unmerged) state; `conflictedFiles` lists the paths
   *  that need resolution before the merge can be committed. */
  conflict?: boolean;
  conflictedFiles?: string[];
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

/** Input for git.resolveConflicts: resolve all unmerged files in a repo via
 *  an AI one-shot call. `repoPath` scopes the operation; `customModelId` +
 *  `customModelRole` select the specific model (a config + its role binding,
 *  same shape as git.generateCommitMessage); null = use the built-in model.
 *  The handler reads each conflicted file's conflict markers, asks the model
 *  for a resolved version, writes it back, and runs `git add`. It does NOT
 *  commit — the user completes the merge commit after reviewing. */
export const GitResolveConflictsSchema = z.object({
  repoPath: z.string(),
  /** Custom-model config id (from CustomModelStore). null = use built-in. */
  customModelId: z.string().nullable(),
  /** Which role binding within the config to use (e.g. "sonnet"). Ignored
   *  when customModelId is null. */
  customModelRole: z.string().nullable(),
});
export type GitResolveConflictsInput = z.infer<typeof GitResolveConflictsSchema>;

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

/* ── Git branch switching (list / checkout) ── */

/** Ref kind for `git.listBranches` entries. */
export type GitBranchType = "local" | "remote" | "tag";

/** One branch / tag entry in a `git.listBranches` result. */
export interface GitBranchInfo {
  /** Display name: short name for local (main), `origin/main` for remote,
   *  tag name for tags (v1.0.0). */
  name: string;
  /** True when this is the currently checked-out ref. */
  current: boolean;
  /** Short commit hash at this ref. */
  commit: string;
  /** Commit subject (first line of the message) at this ref. */
  label: string;
  /** Ref kind discriminator. */
  type: GitBranchType;
}

/** Grouped ref list returned by `git.listBranches`. */
export interface GitBranchListResult {
  /** Current branch name (empty string in detached HEAD). */
  current: string;
  /** True when the repo is in a detached HEAD state. */
  detached: boolean;
  /** Local branches (refs/heads). */
  local: GitBranchInfo[];
  /** Remote branches (refs/remotes), excluding the HEAD symref of each remote. */
  remote: GitBranchInfo[];
  /** Tags (refs/tags), annotated + lightweight. */
  tags: GitBranchInfo[];
}

/** Switch the working tree to another branch / tag / ref.
 *
 *  - `branch` is the target ref (local branch, remote branch, tag, or `HEAD`).
 *    Restricted to safe ref characters to avoid CLI injection (same charset as
 *    `GitLogSchema.ref`).
 *  - `newBranch`, when set, creates a new local branch from `branch` and checks
 *    it out (i.e. `git checkout -b <newBranch> <branch>`). Used both for
 *    creating a fresh branch from HEAD (`branch: "HEAD"`) and for tracking a
 *    remote branch (`branch: "origin/foo"`, `newBranch: "foo"`). */
export const GitCheckoutSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref"),
  /** When provided, create this new local branch from `branch` and check it out. */
  newBranch: z
    .string()
    .regex(/^[A-Za-z0-9._/\-]+$/, "invalid branch name")
    .optional(),
});
export type GitCheckoutInput = z.infer<typeof GitCheckoutSchema>;

/* ── Skill discovery (composer slash-command menu) ──
 *  The composer's `/` menu lists skills discovered by scanning the local
 *  filesystem (`~/.claude/skills/` global + `<project>/.claude/skills/`
 *  project-scoped). Each skill's SKILL.md frontmatter supplies the name +
 *  description; we don't depend on a running SDK session for the listing, so
 *  the menu is instant. Selecting a skill inserts `/name` into the textarea
 *  and the user sends it as a normal turn (SDK is started with
 *  `skills: "all"`, so the agent recognizes and runs the skill). */

export type SkillSource = "global" | "project";

/** One discoverable skill surfaced in the composer `/` menu. Mirrors the
 *  fields the SDK's own `SlashCommand` exposes (name / description /
 *  argumentHint) plus a `source` discriminator so the UI can show whether a
 *  skill came from the user's global dir or the active project. */
export interface SkillInfo {
  /** Skill name without the leading slash (e.g. "pdf"). Used as the slash
   *  command the user sends, and as the dedupe key (project overrides global). */
  name: string;
  /** Short description from SKILL.md frontmatter (may be empty when absent). */
  description: string;
  /** Hint for skill arguments (e.g. "<file>"), when present in frontmatter. */
  argumentHint?: string;
  /** Where the skill was discovered: user-global vs the active project. */
  source: SkillSource;
}

/** List skills for a project root. `projectPath` must match a persisted
 *  Project.path (main cross-checks, same containment guard as file ops). */
export const SkillsListSchema = z.object({
  projectPath: z.string(),
});
export type SkillsListInput = z.infer<typeof SkillsListSchema>;

/** Skill name charset — kebab-case-ish identifiers only. Restricting here
 *  (and again in main with pathWithin) prevents path-traversal via `../` or
 *  absolute paths. Matches what the SDK / Claude Code itself accepts. */
const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Read one skill's full SKILL.md source. Returns the complete file text (no
 *  truncation — skills can be large). A missing file resolves to empty
 *  content so the editor opens cleanly for a not-yet-written skill. */
export const SkillsReadSchema = z.object({
  /** Project root (must match a persisted Project.path). Only used to verify
   *  the caller's identity; the skill itself is resolved by `source` + `name`. */
  projectPath: z.string(),
  /** Which skills root to read from: user-global or the active project. */
  source: z.enum(["global", "project"]),
  /** Skill name (= directory name under <root>/.claude/skills/). */
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});
export type SkillsReadInput = z.infer<typeof SkillsReadSchema>;

/** Write (create or overwrite) a skill's SKILL.md. Creates the skill directory
 *  if absent; always writes the full file content (complete overwrite).
 *  `newName` is reserved for future rename support (when set and differs from
 *  `name`, the skill directory is moved first); v1 UI leaves it unset. */
export const SkillsSaveSchema = z.object({
  projectPath: z.string(),
  source: z.enum(["global", "project"]),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
  /** Full SKILL.md text (frontmatter + body). Written verbatim. */
  content: z.string(),
  newName: z.string().regex(SKILL_NAME_RE).optional(),
});
export type SkillsSaveInput = z.infer<typeof SkillsSaveSchema>;

/** Delete a skill directory. For a symlinked skill only the link is removed
 *  (the target — e.g. a gstack checkout — is left intact); for a real
 *  directory the whole skill folder is removed recursively. */
export const SkillsDeleteSchema = z.object({
  projectPath: z.string(),
  source: z.enum(["global", "project"]),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});
export type SkillsDeleteInput = z.infer<typeof SkillsDeleteSchema>;

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
  | ThemeChangedMessage
  | UpdateAvailableMessage
  | UpdateDownloadProgressMessage
  | UpdateDownloadedMessage;

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
  /** Rename a session (persist a user-edited title). Returns the updated row. */
  "session.rename": (input: RenameSessionInput) => Promise<{ session: Session }>;
  // Providers
  "provider.list": () => Promise<{
    providers: Array<{ id: string; displayName: string; capabilities: ProviderCapabilities }>;
  }>;
  // Settings
  "setting.get": (input: GetSettingInput) => Promise<{ value: string | null }>;
  "setting.set": (input: SetSettingInput) => Promise<void>;
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
  /** Read a binary file as a base64 data URL (image preview). Same path guard. */
  "file.readBinary": (input: FileReadBinaryInput) => Promise<{ dataUrl: string }>;
  /** List one level of a directory (non-recursive), scoped to a project root. */
  "file.listDir": (input: FileListDirInput) => Promise<{ entries: FileTreeEntry[] }>;
  /** Recursive file search under a project root (composer @ / add-context). */
  "file.search": (input: FileSearchInput) => Promise<{ files: FileSearchEntry[] }>;
  /** Write content to a file (creates parents), scoped to a project root. */
  "file.writeFile": (input: FileWriteInput) => Promise<{ ok: boolean }>;
  /** Grep file contents under a project root (line-level matches). */
  "file.grep": (input: FileGrepInput) => Promise<{ matches: FileGrepEntry[] }>;
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
  /** Resolve all merge conflicts in a repo via an AI one-shot call. Reads each
   *  conflicted file, asks the model for a resolved version, writes it back and
   *  runs `git add`. Does NOT commit. Returns the resolved file paths. */
  "git.resolveConflicts": (input: GitResolveConflictsInput) => Promise<{ ok: boolean; resolvedFiles?: string[]; error?: string }>;
  /** Paginated commit log for a repo (newest first). */
  "git.log": (input: GitLogInput) => Promise<{ commits: GitCommitInfo[]; hasMore: boolean }>;
  /** Meta + changed files for one commit. */
  "git.showCommit": (input: GitShowCommitInput) => Promise<GitCommitDetail | null>;
  /** Parent-vs-commit file contents for a single path (Monaco diff). */
  "git.showFile": (
    input: GitShowFileInput,
  ) => Promise<{ before: string; after: string }>;
  /** List local branches, remote branches and tags for a repo (grouped). */
  "git.listBranches": (input: GitRepoPathInput) => Promise<{ branches: GitBranchListResult }>;
  /** Check out a branch / tag / ref. With `newBranch`, creates a new local
   *  branch from the target and checks it out (tracking branch or new branch). */
  "git.checkout": (input: GitCheckoutInput) => Promise<GitOpResult>;
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
  /** App version + runtime info for the About panel. */
  "app.info": () => Promise<AppInfoResult>;
  /** Check for updates on the GitHub Releases channel. Returns the current
   *  version when up-to-date, the new version when available, or an error.
   *  In dev this short-circuits to "up-to-date" (updater only runs in prod). */
  "app.checkForUpdates": () => Promise<CheckForUpdatesResult>;
  /** Start downloading the pending update (autoDownload is off, so the user
   *  opts in via this call). Resolves once the download begins; the
   *  `update:downloaded` push event fires when it's ready to install. */
  "app.downloadUpdate": () => Promise<void>;
  /** Quit the app and install the downloaded update (called after
   *  `update:downloaded`). */
  "app.quitAndInstall": () => Promise<void>;
  /** Open a path in the OS file manager. Main refuses any path that isn't a
   *  known project root, so this can't be used to open arbitrary locations. */
  "shell.openPath": (input: OpenPathInput) => Promise<void>;
  /** Reveal a file or directory in the OS file manager, selecting it. Accepts
   *  any path that resolves inside a known project root (not just the root). */
  "shell.showItemInFolder": (input: ShowItemInFolderInput) => Promise<void>;
  /** Open a file with the OS's default associated application. Accepts any
   *  path that resolves inside a known project root (not just the root). */
  "shell.openFile": (input: OpenFileInput) => Promise<void>;
  /** Native multi-file picker (project-external files allowed). Returns the
   *  selected absolute paths; empty array when the user cancels. */
  "dialog.pickFiles": (input: DialogPickFilesInput) => Promise<{ paths: string[] }>;
  /** Discover skills for the composer `/` menu. Scans the user-global
   *  `~/.claude/skills/` plus the active project's `.claude/skills/` and
   *  parses each SKILL.md's frontmatter. Always resolves (degrades to an
   *  empty list on any IO error). */
  "skills.list": (input: SkillsListInput) => Promise<{ skills: SkillInfo[] }>;
  /** Read one skill's full SKILL.md source (no truncation). Missing file →
   *  empty content. */
  "skills.read": (input: SkillsReadInput) => Promise<{ content: string }>;
  /** Create or overwrite a skill's SKILL.md (full content write; creates the
   *  skill directory if absent). Returns ok:false + error on any IO failure. */
  "skills.save": (input: SkillsSaveInput) => Promise<{ ok: boolean; error?: string }>;
  /** Delete a skill directory (symlink → unlink link only; real dir → recursive
   *  remove). Returns ok:false + error on any IO failure. */
  "skills.delete": (input: SkillsDeleteInput) => Promise<{ ok: boolean; error?: string }>;
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
  SESSION_RENAME: "session:rename",
  SESSION_MESSAGES: "session:messages",
  SESSION_SAVE_MESSAGES: "session:saveMessages",
  SESSION_UPDATE_SETTINGS: "session:updateSettings",
  PROVIDER_LIST: "provider:list",
  // Settings
  SETTING_GET: "setting:get",
  SETTING_SET: "setting:set",
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
  // File read as base64 data URL (image preview)
  FILE_READ_BINARY: "file:readBinary",
  // File tree listing + writing (P4 IDE right panel)
  FILE_LIST_DIR: "file:listDir",
  FILE_SEARCH: "file:search",
  FILE_WRITE: "file:writeFile",
  FILE_GREP: "file:grep",
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
  GIT_RESOLVE_CONFLICTS: "git:resolveConflicts",
  GIT_LOG: "git:log",
  GIT_SHOW_COMMIT: "git:showCommit",
  GIT_SHOW_FILE: "git:showFile",
  GIT_LIST_BRANCHES: "git:listBranches",
  GIT_CHECKOUT: "git:checkout",
  // Integrated terminal (P4 IDE right panel)
  TERMINAL_CREATE: "terminal:create",
  TERMINAL_WRITE: "terminal:write",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_KILL: "terminal:kill",
  TERMINAL_LIST: "terminal:list",
  // App / runtime info (About panel)
  APP_INFO: "app:info",
  // Auto-update (electron-updater)
  APP_CHECK_FOR_UPDATES: "app:checkForUpdates",
  APP_DOWNLOAD_UPDATE: "app:downloadUpdate",
  APP_QUIT_AND_INSTALL: "app:quitAndInstall",
  // Open a project root in the OS file manager (main refuses non-project paths)
  SHELL_OPEN_PATH: "shell:openPath",
  // Reveal a file/dir inside a project root in the OS file manager (selects it)
  SHELL_SHOW_ITEM_IN_FOLDER: "shell:showItemInFolder",
  // Open a file inside a project root with the OS default application
  SHELL_OPEN_FILE: "shell:openFile",
  // Native multi-file picker (project-external files allowed) for the composer
  DIALOG_PICK_FILES: "dialog:pickFiles",
  // Skill discovery for the composer `/` menu (scans ~/.claude/skills + project)
  SKILLS_LIST: "skills:list",
  // Skill management (settings panel): read / save / delete a single skill
  SKILLS_READ: "skills:read",
  SKILLS_SAVE: "skills:save",
  SKILLS_DELETE: "skills:delete",
  // send/on (push events)
  CLAUDE_EVENT: "claude:event",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_EXIT: "terminal:exit",
  THEME_CHANGED: "theme:changed",
  UPDATE_AVAILABLE: "update:available",
  UPDATE_DOWNLOAD_PROGRESS: "update:downloadProgress",
  UPDATE_DOWNLOADED: "update:downloaded",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
