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

/* ── File read (on-demand, for diff rendering) ── */

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

export type MainToRendererMessage =
  | ClaudeEventMessage
  | TerminalDataMessage
  | ThemeChangedMessage;

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
  // send/on (push events)
  CLAUDE_EVENT: "claude:event",
  TERMINAL_DATA: "terminal:data",
  THEME_CHANGED: "theme:changed",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
