/**
 * Two-column panel for managing Claude skills (SKILL.md under
 * ~/.claude/skills + <project>/.claude/skills). Lives in the Settings page
 * under "Skills".
 *
 * ## Layout
 *
 *   ┌─ left (skill list) ────┬─ right (editor / empty) ──────────┐
 *   │ • pdf       [全局]      │  — editing existing —             │
 *   │ • docx      [全局]      │  full SKILL.md source textarea    │
 *   │ • my-skill  [项目]      │  — or creating new —              │
 *   │ + 新建 Skill            │  name / description / body        │
 *   └─────────────────────────┤  scope (全局/项目) · 保存/删除     │
 *                              └───────────────────────────────────┘
 *
 * Selecting a skill on the left loads its full SKILL.md into the editor on
 * the right (raw text — frontmatter + body together). "+ 新建 Skill" opens a
 * structured form (name / description / body) that is assembled into a
 * minimal frontmatter on save. After any mutation the store's `skills` cache
 * is reloaded so the composer `/` menu stays in sync.
 *
 * Mirrors CustomModelsPanel's two-column shape, selection state pattern, and
 * ConfirmDialog-based delete confirmation.
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { Button, ConfirmDialog } from "@renderer/components/ui/index.js";
import {
  IconPlus,
  IconTrash,
  IconSparkles,
  IconLoader2,
} from "@renderer/lib/icons.js";
import type { SkillInfo, SkillSource } from "@contracts/ipc";

/** Skill name charset — mirrored from the zod schema in the contract. The
 *  editor disables the name field for existing skills, so this only gates the
 *  "create new" form. */
const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Selection in the left list. `"new"` = the transient create entry;
 *  `null` = empty state. An existing skill is keyed by `${source}:${name}`
 *  (a name can appear under both global + project; the key disambiguates). */
type Selection =
  | { kind: "skill"; source: SkillSource; name: string }
  | { kind: "new" }
  | null;

interface NewForm {
  name: string;
  description: string;
  body: string;
  scope: SkillSource;
}

function emptyNewForm(): NewForm {
  return { name: "", description: "", body: "", scope: "global" };
}

/** Selection key for a SkillInfo — stable identity across reloads. */
function skillKey(s: { source: SkillSource; name: string }): string {
  return `${s.source}:${s.name}`;
}

export function SkillsPanel() {
  const skills = useSessionStore((s) => s.skills);
  const reloadSkills = useSessionStore((s) => s.reloadSkills);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  // The active project's path — needed for the skills IPC (identity check on
  // main). Null when no project is open: only global skills are manageable.
  const projectPath = activeProjectId
    ? projects.find((p) => p.id === activeProjectId)?.path ?? null
    : null;

  // Make sure the skill list is populated even if the user opened Settings
  // before ever sending a message (reloadSkills is also called on init/project
  // switch, but this covers the "fresh open → straight to settings" path).
  useEffect(() => {
    void reloadSkills();
  }, [reloadSkills]);

  const [selected, setSelected] = useState<Selection>(null);
  // Full SKILL.md source for the skill being edited (null = not loaded yet).
  const [editContent, setEditContent] = useState<string | null>(null);
  // Structured form for creating a new skill.
  const [newForm, setNewForm] = useState<NewForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillInfo | null>(null);

  const startEdit = async (skill: SkillInfo) => {
    if (!projectPath) return;
    setSelected({ kind: "skill", source: skill.source, name: skill.name });
    setNewForm(null);
    setError(null);
    setLoading(true);
    setEditContent(null);
    try {
      const { content } = await api.skills.read({
        projectPath,
        source: skill.source,
        name: skill.name,
      });
      setEditContent(content);
    } catch (err) {
      setError((err as Error).message);
      setEditContent("");
    } finally {
      setLoading(false);
    }
  };

  const startAdd = () => {
    setSelected({ kind: "new" });
    // Default scope: project when one is active (most user-created skills are
    // project-scoped), else global.
    setNewForm({ ...emptyNewForm(), scope: projectPath ? "project" : "global" });
    setEditContent(null);
    setError(null);
  };

  const cancel = () => {
    setSelected(null);
    setEditContent(null);
    setNewForm(null);
    setError(null);
  };

  const saveEdit = async () => {
    const sel = selected;
    if (!projectPath || !sel || sel.kind !== "skill" || editContent === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.skills.save({
        projectPath,
        source: sel.source,
        name: sel.name,
        content: editContent,
      });
      if (!res.ok) {
        setError(res.error ?? "保存失败");
        return;
      }
      await reloadSkills();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveNew = async () => {
    const sel = selected;
    if (!projectPath || !sel || sel.kind !== "new" || !newForm) return;
    const name = newForm.name.trim();
    if (!SKILL_NAME_RE.test(name)) {
      setError("名称只能包含字母、数字、下划线和连字符");
      return;
    }
    if (!newForm.description.trim()) {
      setError("请填写描述");
      return;
    }
    // Assemble a minimal, valid SKILL.md: frontmatter (name + description) +
    // body. Description may contain special chars, so quote it to be safe.
    const desc = newForm.description.trim().replace(/"/g, '\\"');
    const content = `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${newForm.body.trimEnd()}\n`;
    setSaving(true);
    setError(null);
    try {
      const res = await api.skills.save({
        projectPath,
        source: newForm.scope,
        name,
        content,
      });
      if (!res.ok) {
        setError(res.error ?? "保存失败");
        return;
      }
      await reloadSkills();
      // Land on the freshly created skill so the user sees it selected.
      setSelected({ kind: "skill", source: newForm.scope, name });
      setNewForm(null);
      setEditContent(content);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!projectPath || !target) return;
    try {
      const res = await api.skills.delete({
        projectPath,
        source: target.source,
        name: target.name,
      });
      if (!res.ok) {
        setError(res.error ?? "删除失败");
        return;
      }
      // Clear selection if the deleted skill was selected.
      if (
        selected?.kind === "skill" &&
        selected.source === target.source &&
        selected.name === target.name
      ) {
        cancel();
      }
      await reloadSkills();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3">
        <h2 className="font-semibold text-content">Skills</h2>
        <p className="mt-1 text-[0.7857em] leading-relaxed text-content-subtle">
          管理 Claude 技能(SKILL.md)。全局 skill 存放在 <code className="rounded bg-surface-muted px-0.5">~/.claude/skills</code>,
          所有项目可用;项目 skill 存放在当前项目的 <code className="rounded bg-surface-muted px-0.5">.claude/skills</code>,
          仅当前项目可用(同名时覆盖全局)。在输入框输入 <code className="rounded bg-surface-muted px-0.5">/</code> 即可调用。
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] gap-4">
        {/* ───────── Left: skill list ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>Skills</span>
            <span className="tabular-nums">{skills.length}</span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {selected?.kind === "new" && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                新建 Skill
              </div>
            )}
            {skills.map((s) => {
              const isActive =
                selected?.kind === "skill" &&
                selected.source === s.source &&
                selected.name === s.name;
              return (
                <button
                  key={skillKey(s)}
                  onClick={() => void startEdit(s)}
                  className={cn(
                    "relative block w-full rounded px-2.5 py-1.5 text-left transition-colors",
                    isActive ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                  )}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                  )}
                  <div className="flex items-center gap-1">
                    <IconSparkles size={11} className="shrink-0 text-content-subtle" />
                    <span className="truncate text-[0.7857em] font-medium text-content">
                      {s.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[0.7143em] text-content-subtle">
                      {s.description || "(无描述)"}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 text-[9px] leading-tight",
                        s.source === "project"
                          ? "bg-accent/12 text-accent"
                          : "bg-surface-hover text-content-subtle",
                      )}
                    >
                      {s.source === "project" ? "项目" : "全局"}
                    </span>
                  </div>
                </button>
              );
            })}
            {skills.length === 0 && selected?.kind !== "new" && (
              <div className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                未发现 skill。
                <br />
                在 ~/.claude/skills 安装,或点击下方新建。
              </div>
            )}
          </nav>
          <div className="border-t border-edge p-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={startAdd}
              disabled={selected?.kind === "new"}
              className="w-full justify-center gap-1"
            >
              <IconPlus size={12} />
              新建 Skill
            </Button>
          </div>
        </aside>

        {/* ───────── Right: editor / empty state ───────── */}
        <div className="min-h-0 overflow-y-auto pr-1">
          {selected == null ? (
            <EmptyDetail />
          ) : selected.kind === "new" && newForm ? (
            <NewSkillForm
              form={newForm}
              setForm={setNewForm}
              hasProject={!!projectPath}
              saving={saving}
              error={error}
              onSave={() => void saveNew()}
              onCancel={cancel}
            />
          ) : selected.kind === "skill" ? (
            <SkillSourceEditor
              skill={selected}
              content={editContent}
              loading={loading}
              saving={saving}
              error={error}
              onChange={setEditContent}
              onSave={() => void saveEdit()}
              onCancel={cancel}
              onDelete={() => {
                const target = skills.find(
                  (s) => s.source === selected.source && s.name === selected.name,
                );
                if (target) setPendingDelete(target);
              }}
            />
          ) : null}
        </div>
      </div>

      {/* ───────── Delete confirmation ───────── */}
      <ConfirmDialog
        open={pendingDelete != null}
        title="删除 Skill"
        danger
        description={
          <>
            确认删除「{pendingDelete?.name}」(
            {pendingDelete?.source === "project" ? "项目级" : "全局"})?此操作不可撤销,
            skill 目录及其下所有文件将被移除。
          </>
        }
        confirmText="删除"
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

/** Right-pane empty state — nothing selected. */
function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <IconSparkles size={28} className="mb-2 text-content-subtle" />
      <p className="max-w-[240px] text-[0.7857em] leading-relaxed text-content-subtle">
        从左侧选择一个 skill 查看或编辑,或点击「新建 Skill」创建新技能。
      </p>
    </div>
  );
}

/** Editor for an existing skill — raw SKILL.md source in a single textarea. */
function SkillSourceEditor({
  skill,
  content,
  loading,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  skill: { source: SkillSource; name: string };
  content: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <IconSparkles size={14} className="text-content-muted" />
          <span className="text-[0.8571em] font-medium text-content">/{skill.name}</span>
          <span
            className={cn(
              "rounded px-1 text-[9px]",
              skill.source === "project"
                ? "bg-accent/12 text-accent"
                : "bg-surface-hover text-content-subtle",
            )}
          >
            {skill.source === "project" ? "项目" : "全局"}
          </span>
        </div>
        <span className="text-[0.7143em] text-content-subtle">SKILL.md 原文</span>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={14} className="animate-spin" />
          加载中…
        </div>
      ) : (
        <textarea
          value={content ?? ""}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={cn(
            "min-h-[300px] flex-1 resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
          )}
          placeholder="# SKILL.md 源码"
        />
      )}
      {error && <div className="mt-2 text-[0.7857em] text-danger">{error}</div>}
      <div className="mt-2 flex items-center gap-2">
        <Button variant="danger" size="sm" onClick={onDelete} title="删除此 skill">
          <IconTrash size={12} />
          删除
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving || loading}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}

/** Structured form for creating a new skill (name / description / body). */
function NewSkillForm({
  form,
  setForm,
  hasProject,
  saving,
  error,
  onSave,
  onCancel,
}: {
  form: NewForm;
  setForm: React.Dispatch<React.SetStateAction<NewForm | null>>;
  hasProject: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  // Functional updater — guards against null (the form is guaranteed non-null
  // while this component is mounted, but the setter type carries | null).
  const update = <K extends keyof NewForm>(key: K, value: NewForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-2 flex items-center gap-1.5">
        <IconPlus size={14} className="text-accent" />
        <span className="text-[0.8571em] font-medium text-content">新建 Skill</span>
      </div>
      <p className="mb-2 text-[0.7143em] leading-relaxed text-content-subtle">
        填写名称、描述和正文,保存时会自动生成标准 frontmatter。
        之后可在编辑模式补充 <code className="rounded bg-surface-muted px-0.5">allowed-tools</code> 等高级字段。
      </p>

      <Field label="名称 (Skill Name)">
        <input
          type="text"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="my-skill"
          className={inputCls}
          spellCheck={false}
          autoFocus
        />
        <p className="mt-0.5 text-[10px] text-content-subtle">
          仅字母、数字、下划线、连字符;将作为 <code className="rounded bg-surface-muted px-0.5">/name</code> 命令名
        </p>
      </Field>

      <Field label="描述 (Description)">
        <input
          type="text"
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
          placeholder="一句话说明这个 skill 做什么、何时使用"
          className={inputCls}
          spellCheck={false}
        />
      </Field>

      {/* Scope selector: project only available when a project is open. */}
      <Field label="存放范围">
        <div className="flex gap-1.5">
          <ScopeRadio
            label="全局 (~/.claude/skills)"
            active={form.scope === "global"}
            onClick={() => update("scope", "global")}
          />
          <ScopeRadio
            label="当前项目 (.claude/skills)"
            active={form.scope === "project"}
            disabled={!hasProject}
            title={!hasProject ? "未打开项目" : undefined}
            onClick={() => hasProject && update("scope", "project")}
          />
        </div>
      </Field>

      <Field label="正文 (Markdown)">
        <textarea
          value={form.body}
          onChange={(e) => update("body", e.target.value)}
          spellCheck={false}
          className={cn(
            "min-h-[200px] flex-1 resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
          )}
          placeholder={"# Skill 标题\n\n说明这个 skill 的使用方式、步骤、注意事项…"}
        />
      </Field>

      {error && <div className="mt-2 text-[0.7857em] text-danger">{error}</div>}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
          {saving ? "保存中…" : "创建"}
        </Button>
      </div>
    </div>
  );
}

function ScopeRadio({
  label,
  active,
  disabled,
  title,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex-1 rounded border px-2 py-1 text-[0.7143em] transition-colors",
        active
          ? "border-accent bg-accent/8 text-accent"
          : "border-edge text-content-muted hover:bg-surface-hover",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {label}
    </button>
  );
}

const inputCls =
  "min-w-0 flex-1 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">{label}</span>
      {children}
    </label>
  );
}
