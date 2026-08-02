/**
 * Two-column panel for managing Claude skills (SKILL.md under
 * ~/.claude/skills + <project>/.claude/skills). Lives in the Settings page
 * under "Skills".
 *
 * ## Layout
 *
 *   ┌─ project selector (dropdown) ──────────────────────────────┐
 *   ├─ left (skill list) ────┬─ right (editor / empty) ──────────┤
 *   │ • pdf       [全局]      │  — editing existing —             │
 *   │ • docx      [全局]      │  full SKILL.md source textarea    │
 *   │ • my-skill  [项目]      │  — or creating new —              │
 *   │ + 新建 Skill            │  name / description / body        │
 *   └─────────────────────────┤  scope (全局/项目) · 保存/删除     │
 *                              └───────────────────────────────────┘
 *
 * ## Which project's skills are shown?
 *
 * The panel keeps its OWN "managed project" selection (independent of the
 * workspace's activeProjectId) so switching it here never disturbs the
 * workspace. It defaults to the workspace's active project on first open.
 * The project dropdown at the top makes this explicit: project-scoped skills
 * always belong to whichever project is shown there, removing the prior
 * ambiguity where the binding was invisible.
 *
 * The skill list is fetched locally (panelSkills state) keyed on the managed
 * project, NOT read from the session store's `skills` cache — that cache is
 * bound to activeProjectId for the composer `/` menu and must not be coupled
 * to this panel's selection. After a mutation, if the managed project happens
 * to be the active one, we also reload the store cache so the `/` menu stays
 * in sync.
 *
 * Mirrors CustomModelsPanel's two-column shape and ConfirmDialog-based delete.
 */
import { useCallback, useEffect, useState } from "react";
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

/** Stable empty array so the panel's skill list has a stable reference when
 *  empty (avoiding needless re-renders — same convention as sessionStore's
 *  EMPTY_SKILLS). */
const EMPTY_PANEL_SKILLS: SkillInfo[] = [];

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
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const reloadSkills = useSessionStore((s) => s.reloadSkills);

  // Projects available to manage (non-archived). The dropdown lists these.
  const managedProjects = projects.filter((p) => !p.archived);

  // The panel's OWN project selection — independent of the workspace's
  // activeProjectId so switching here never disturbs the workspace. Defaults
  // to the active project; falls back to the first available project.
  const [managedProjectId, setManagedProjectId] = useState<string | null>(
    () => activeProjectId ?? managedProjects[0]?.id ?? null,
  );
  const managedProject = managedProjects.find((p) => p.id === managedProjectId);
  const projectPath = managedProject?.path ?? null;

  // Panel-local skill list, keyed on the managed project. NOT the store
  // cache (that one follows activeProjectId for the composer `/` menu).
  const [panelSkills, setPanelSkills] = useState<SkillInfo[]>(EMPTY_PANEL_SKILLS);
  const [listLoading, setListLoading] = useState(false);

  const loadPanelSkills = useCallback(async () => {
    if (!projectPath) {
      setPanelSkills(EMPTY_PANEL_SKILLS);
      return;
    }
    setListLoading(true);
    try {
      const { skills } = await api.skills.list({ projectPath });
      setPanelSkills(skills.length ? skills : EMPTY_PANEL_SKILLS);
    } catch (err) {
      console.error("SkillsPanel load failed:", err);
      setPanelSkills(EMPTY_PANEL_SKILLS);
    } finally {
      setListLoading(false);
    }
  }, [projectPath]);

  // (Re)load whenever the managed project changes, and once on mount.
  useEffect(() => {
    void loadPanelSkills();
  }, [loadPanelSkills]);

  // Switching the managed project also clears any in-flight edit/create, so a
  // stale editor for project A doesn't linger while the list shows project B.
  const switchProject = (id: string) => {
    setManagedProjectId(id);
    setSelected(null);
    setEditContent(null);
    setNewForm(null);
    setError(null);
  };

  const [selected, setSelected] = useState<Selection>(null);
  // Full SKILL.md source for the skill being edited (null = not loaded yet).
  const [editContent, setEditContent] = useState<string | null>(null);
  // Structured form for creating a new skill.
  const [newForm, setNewForm] = useState<NewForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillInfo | null>(null);

  // After any mutation: refresh this panel's list, and (if the managed project
  // is also the workspace's active one) refresh the store cache so the
  // composer `/` menu sees the change too.
  const refreshAfterMutation = useCallback(async () => {
    await loadPanelSkills();
    if (managedProjectId && managedProjectId === activeProjectId) {
      void reloadSkills();
    }
  }, [loadPanelSkills, managedProjectId, activeProjectId, reloadSkills]);

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
    // Default scope: project when one is being managed (most user-created
    // skills are project-scoped), else global.
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
      await refreshAfterMutation();
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
      await refreshAfterMutation();
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
      await refreshAfterMutation();
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
          所有项目可用;项目 skill 存放在所选项目的 <code className="rounded bg-surface-muted px-0.5">.claude/skills</code>,
          仅该项目可用(同名时覆盖全局)。在输入框输入 <code className="rounded bg-surface-muted px-0.5">/</code> 即可调用。
        </p>
      </div>

      {/* ───────── Project selector ───────── */}
      {/* Makes the project binding explicit: project-scoped skills always
          belong to the project shown here. Switching it reloads the list and
          does NOT touch the workspace's active project. */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[0.7857em] font-medium text-content-muted">项目:</span>
        {managedProjects.length > 0 ? (
          <select
            value={managedProjectId ?? ""}
            onChange={(e) => switchProject(e.target.value)}
            className={cn(
              "min-w-0 flex-1 rounded border border-edge bg-surface px-2 py-1 text-[0.7857em] text-content focus:border-accent focus:outline-none",
            )}
          >
            {managedProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === activeProjectId ? " (当前工作区)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[0.7857em] text-content-subtle">
            暂无项目 — 仅可管理全局 skill
          </span>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] gap-4">
        {/* ───────── Left: skill list ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>Skills</span>
            <span className="tabular-nums">
              {listLoading ? "…" : panelSkills.length}
            </span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {selected?.kind === "new" && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                新建 Skill
              </div>
            )}
            {panelSkills.map((s) => {
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
            {panelSkills.length === 0 && !listLoading && selected?.kind !== "new" && (
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
              disabled={selected?.kind === "new" || !projectPath}
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
                const target = panelSkills.find(
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
            {pendingDelete?.source === "project"
              ? `项目级 · ${managedProject?.name ?? ""}`
              : "全局"}
            )?此操作不可撤销,skill 目录及其下所有文件将被移除。
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

      {/* Scope selector: project only available when a project is selected. */}
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
            title={!hasProject ? "未选择项目" : undefined}
            onClick={() => hasProject && update("scope", "project")}
          />
        </div>
      </Field>

      <Field label="正文 (Markdown)">
        <textarea
          value={form.body}
          onChange={(e) => update("body", e.target.value)}
          spellCheck={false}
          // w-full (not flex-1): Field wraps this in a block <label>, not a flex
          // container, so flex-1 was a no-op and the textarea fell back to its
          // default cols=20 width. w-full makes it fill the row like the other
          // inputs (which use inputCls with w-full).
          className={cn(
            "min-h-[200px] w-full resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
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
  "min-w-0 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block w-full">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">{label}</span>
      {children}
    </label>
  );
}
