import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import { IconPlus, IconTrash, IconAlertTriangle } from "@renderer/lib/icons.js";
import {
  CUSTOM_MODEL_ROLES,
  CUSTOM_MODEL_ROLE_LABELS,
} from "@contracts/customModel";
import type {
  CustomModelPublic,
  AuthMode,
  Protocol,
  RoleBindings,
  RoleBinding,
  CustomModelRoleKey,
} from "@contracts/customModel";
import type { EndpointPresetPublic } from "@contracts/endpointPreset";

/**
 * Two-column panel for managing custom-model provider configs (Anthropic-
 * compatible endpoints: DeepSeek `/anthropic`, one-api, new-api, self-hosted
 * proxies, …). Lives inside the Settings modal under "模型配置".
 *
 * ## Layout
 *
 *   ┌─ left (provider list) ──┬─ right (config form / empty) ──┐
 *   │ • DeepSeek 中转          │  name / baseUrl / token / auth   │
 *   │ • OneAPI                 │  role-binding table              │
 *   │ + 新增供应商              │  advanced · test · save / delete │
 *   └──────────────────────────┴──────────────────────────────────┘
 *
 * Selecting a provider on the left loads its (desensitized) values into the
 * form on the right. "+ 新增供应商" inserts a transient "new" entry that is
 * promoted to a real entry on save, or discarded on cancel.
 *
 * ## Model: role bindings (5 tiers) — unchanged
 *
 * A config is one endpoint (name + baseUrl + token + authMode) plus a binding
 * for each of the five Claude Code tiers. Each row of the table maps a tier
 * (Haiku / Sonnet / Opus / Fable / Subagent) to:
 *   - 显示名称 (dropdown label, e.g. "pro")
 *   - 实际请求模型 (gateway model id, e.g. "deepseek-v4-pro")
 *   - 声明支持 1M (whether selecting this tier sends betas=['context-1m-…'])
 * A tier with no 实际请求模型 is simply unbound — it won't appear in the
 * dropdown. At least one tier must be bound to save.
 *
 * Flow: pick a provider on the left → edit on the right → "Test connection"
 * probes the endpoint with the (not-yet-saved) values → "Save" / "Update"
 * encrypts the token on the main side and refreshes the list.
 */

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; detail: string }
  | { status: "fail"; error: string };

interface FormState {
  id?: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  /** Wire protocol of the endpoint. `anthropic` (default) talks to the
   *  endpoint directly; `openai` activates the in-process protocol bridge. */
  protocol: Protocol;
  authToken: string;
  /** Per-tier bindings. Always all five keys present in the form (some may be
   *  empty/undefined) so the table renders every row. */
  roles: RoleBindings;
  /** Which role's binding is the current "Test connection" target. */
  testRole: CustomModelRoleKey;
  disableNonEssentialTraffic: boolean;
  timeoutMs: string; // string in the input; parsed on save
}

/** Build a fresh empty form with all five roles present. */
function emptyForm(): FormState {
  const roles: RoleBindings = {};
  return {
    name: "",
    baseUrl: "",
    authMode: "auth_token",
    protocol: "anthropic",
    authToken: "",
    roles,
    testRole: "sonnet",
    disableNonEssentialTraffic: true,
    timeoutMs: "",
  };
}

/** Build a form from an existing (desensitized) config for editing. */
function formFromConfig(m: CustomModelPublic): FormState {
  return {
    id: m.id,
    name: m.name,
    baseUrl: m.baseUrl,
    authMode: m.authMode,
    protocol: m.protocol,
    authToken: "", // blank on edit — omit on save means "keep existing"
    roles: { ...m.roles },
    testRole:
      (CUSTOM_MODEL_ROLES.find((r) => m.roles[r]?.requestModel?.trim()) as
        | CustomModelRoleKey
        | undefined) ?? "sonnet",
    disableNonEssentialTraffic: m.disableNonEssentialTraffic ?? true,
    timeoutMs: m.timeoutMs ? String(m.timeoutMs) : "",
  };
}

export function CustomModelsPanel() {
  const customModels = useSessionStore((s) => s.customModels);
  const reloadCustomModels = useSessionStore((s) => s.reloadCustomModels);

  /** Right-pane selection. `"new"` = the transient add entry; `null` = the
   *  empty state (nothing chosen). */
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Pending deletion (drives the confirm Dialog). */
  const [pendingDelete, setPendingDelete] = useState<CustomModelPublic | null>(null);
  /** Endpoint presets for the "从预设导入" dropdown. */
  const [presets, setPresets] = useState<EndpointPresetPublic[]>([]);
  /** Whether the inline "add preset" form is open (left column footer). */
  const [showPresetForm, setShowPresetForm] = useState(false);
  /** Draft values for the inline add-preset form. */
  const [presetDraft, setPresetDraft] = useState({ name: "", baseUrl: "", authMode: "auth_token" as AuthMode });

  // Load endpoint presets once on mount.
  useEffect(() => {
    void api.endpointPreset
      .list()
      .then(({ presets }) => setPresets(presets))
      .catch((err) => console.error("endpointPreset.list failed:", err));
  }, []);

  /** Save a new endpoint preset (credential-free; token stays per-provider). */
  const savePreset = async () => {
    if (!presetDraft.name.trim() || !presetDraft.baseUrl.trim()) return;
    try {
      const { presets: next } = await api.endpointPreset.save({
        name: presetDraft.name,
        baseUrl: presetDraft.baseUrl,
        authMode: presetDraft.authMode,
      });
      setPresets(next);
      setPresetDraft({ name: "", baseUrl: "", authMode: "auth_token" });
      setShowPresetForm(false);
    } catch (err) {
      console.error("endpointPreset.save failed:", err);
    }
  };

  /** Delete an endpoint preset. */
  const deletePreset = async (id: string) => {
    try {
      const { presets: next } = await api.endpointPreset.delete({ id });
      setPresets(next);
    } catch (err) {
      console.error("endpointPreset.delete failed:", err);
    }
  };

  /** Fill the current form's baseUrl/authMode from a preset. Token is left
   *  for the user to enter — presets are credential-free by design. */
  const applyPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setForm((prev) => (prev ? { ...prev, baseUrl: preset.baseUrl, authMode: preset.authMode } : prev));
    setTest({ status: "idle" });
  };

  const startAdd = () => {
    setSelectedId("new");
    setForm(emptyForm());
    setAdvancedOpen(false);
    setTest({ status: "idle" });
    setError(null);
  };

  const startEdit = (m: CustomModelPublic) => {
    setSelectedId(m.id);
    setForm(formFromConfig(m));
    // Auto-open advanced if any advanced field is set, so the user sees them.
    setAdvancedOpen(Boolean(m.timeoutMs));
    setTest({ status: "idle" });
    setError(null);
  };

  const cancel = () => {
    setSelectedId(null);
    setForm(null);
    setTest({ status: "idle" });
    setError(null);
  };

  /** Functional field updater — avoids the closure-staleness bug where
   *  browser autofill / fast typing could drop fields. */
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  /** Patch a single field on a role binding. Creates the binding object if
   *  absent. Passing undefined for a field clears it. */
  const updateRole = (
    role: CustomModelRoleKey,
    patch: Partial<RoleBinding>,
  ) =>
    setForm((prev) => {
      if (!prev) return prev;
      const current = prev.roles[role] ?? {};
      const merged: RoleBinding = { ...current, ...patch };
      // Drop undefined keys so the persisted shape stays clean.
      const cleaned: RoleBinding = {};
      if (merged.displayName) cleaned.displayName = merged.displayName;
      if (merged.requestModel) cleaned.requestModel = merged.requestModel;
      if (merged.supports1m) cleaned.supports1m = merged.supports1m;
      return {
        ...prev,
        roles: {
          ...prev.roles,
          [role]: Object.keys(cleaned).length > 0 ? cleaned : undefined,
        },
      };
    });

  /** Build the probe payload from the current form. The probe tests ONE
   *  role's binding — the one at `testRole`. */
  const buildProbeInput = () => {
    if (!form) return null;
    const timeoutMs = form.timeoutMs.trim() ? Number(form.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError("超时必须是正整数(毫秒)");
      return null;
    }
    const binding = form.roles[form.testRole];
    const model = binding?.requestModel?.trim() ?? "";
    setError(null);
    return {
      baseUrl: form.baseUrl.trim(),
      authToken: form.authToken.trim(),
      authMode: form.authMode,
      protocol: form.protocol,
      model,
      supports1m: binding?.supports1m ?? false,
      disableNonEssentialTraffic: form.disableNonEssentialTraffic,
      timeoutMs,
    };
  };

  const runTest = async () => {
    const input = buildProbeInput();
    if (!input) return;
    if (!input.baseUrl || !input.model) {
      setTest({
        status: "fail",
        error: `请填写 Base URL 和「${CUSTOM_MODEL_ROLE_LABELS[form!.testRole]}」角色的「实际请求模型」`,
      });
      return;
    }
    // Test always needs a token: on edit with a blank field, we can't test
    // against the stored one (it never reaches the renderer). Tell the user.
    if (!input.authToken) {
      setTest({
        status: "fail",
        error: form?.id
          ? "编辑模式下测试需重新填入 Token(明文不回传,无法复用已存的)"
          : "请填写 Token",
      });
      return;
    }
    setTest({ status: "testing" });
    try {
      const result = await api.customModel.test(input);
      if (result.ok) {
        setTest({ status: "ok", detail: result.detail ?? "连接成功" });
      } else {
        setTest({ status: "fail", error: result.error ?? "未知错误" });
      }
    } catch (err) {
      setTest({ status: "fail", error: (err as Error).message });
    }
  };

  const save = async () => {
    if (!form) return;
    // Trim all bindings; drop fully-empty roles. Keep displayName only when a
    // requestModel is also set (a display name with no backing model is
    // meaningless in the dropdown).
    const roles: RoleBindings = {};
    let anyBound = false;
    for (const role of CUSTOM_MODEL_ROLES) {
      const b = form.roles[role];
      const requestModel = b?.requestModel?.trim();
      if (!requestModel) continue;
      anyBound = true;
      const cleaned: RoleBinding = { requestModel };
      const displayName = b?.displayName?.trim();
      if (displayName) cleaned.displayName = displayName;
      if (b?.supports1m) cleaned.supports1m = true;
      roles[role] = cleaned;
    }
    if (!form.name.trim() || !form.baseUrl.trim()) {
      setError("名称、Base URL 不能为空");
      return;
    }
    if (!anyBound) {
      setError("至少要为一个角色填写「实际请求模型」");
      return;
    }
    if (!form.id && !form.authToken.trim()) {
      setError("新建时必须填写 Token");
      return;
    }
    const timeoutMs = form.timeoutMs.trim() ? Number(form.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError("超时必须是正整数(毫秒)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { models: saved } = await api.customModel.save({
        id: form.id,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        authMode: form.authMode,
        protocol: form.protocol,
        // Omit authToken on edit when blank → main keeps the stored token.
        authToken: form.authToken.trim() || undefined,
        roles,
        disableNonEssentialTraffic: form.disableNonEssentialTraffic,
        timeoutMs,
      });
      useSessionStore.setState({ customModels: saved });
      // After a successful save, land on the saved entry (its id for an update,
      // or the freshly-created one — last in the returned list by createdAt).
      const landedId = form.id ?? saved[saved.length - 1]?.id ?? null;
      setSelectedId(landedId);
      setForm(null);
      setTest({ status: "idle" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
      void reloadCustomModels();
    }
  };

  const confirmRemove = async () => {
    const target = pendingDelete;
    if (!target) return;
    try {
      const { models } = await api.customModel.delete({ id: target.id });
      useSessionStore.setState({ customModels: models });
      if (selectedId === target.id) {
        setSelectedId(null);
        setForm(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3">
        <h2 className="font-semibold text-content">模型配置</h2>
        <p className="mt-1 text-[0.7857em] leading-relaxed text-content-subtle">
          添加 Anthropic 兼容端点(DeepSeek / one-api / new-api / 自建网关)。Token 用系统钥匙串加密存储,明文不落盘。
          每行把一个角色(Haiku/Sonnet/Opus/Fable/Subagent)绑定到网关真实模型。
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] gap-4">
        {/* ───────── Left: provider list ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>供应商</span>
            <span className="tabular-nums">{customModels.length}</span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {/* Transient "new" entry — shown while the add form is open. */}
            {selectedId === "new" && (
              <div
                className={cn(
                  "relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent",
                )}
              >
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                新建供应商
              </div>
            )}
            {customModels.map((m) => {
              const isActive = selectedId === m.id;
              const boundCount = CUSTOM_MODEL_ROLES.filter((r) =>
                m.roles[r]?.requestModel?.trim(),
              ).length;
              return (
                <button
                  key={m.id}
                  onClick={() => startEdit(m)}
                  className={cn(
                    "relative block w-full rounded px-2.5 py-1.5 text-left transition-colors",
                    isActive
                      ? "bg-surface-hover"
                      : "hover:bg-surface-hover/60",
                  )}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                  )}
                  <div className="truncate text-[0.7857em] font-medium text-content">
                    {m.name}
                  </div>
                  <div className="truncate text-[0.7143em] text-content-subtle">
                    {boundCount > 0
                      ? `${boundCount} 角色 · ${m.authMode === "api_key" ? "x-api-key" : "Bearer"}`
                      : "未绑定角色"}
                  </div>
                </button>
              );
            })}
            {customModels.length === 0 && selectedId !== "new" && (
              <div className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                还没有供应商配置。
              </div>
            )}
          </nav>
          <div className="border-t border-edge p-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={startAdd}
              disabled={selectedId === "new"}
              className="w-full justify-center gap-1"
            >
              <IconPlus size={12} />
              新增供应商
            </Button>
          </div>

          {/* ───── Endpoint presets (credential-free endpoint templates) ───── */}
          <div className="border-t border-edge/60 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
                端点预设
              </span>
              <button
                type="button"
                onClick={() => setShowPresetForm((v) => !v)}
                className="text-[0.7143em] text-accent hover:text-accent/80"
              >
                {showPresetForm ? "收起" : "+ 添加"}
              </button>
            </div>
            {showPresetForm && (
              <div className="mb-1.5 space-y-1">
                <input
                  type="text"
                  value={presetDraft.name}
                  onChange={(e) => setPresetDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="名称,如 DeepSeek 官方"
                  className={inputCls}
                />
                <input
                  type="text"
                  value={presetDraft.baseUrl}
                  onChange={(e) => setPresetDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  placeholder="https://api.deepseek.com"
                  className={inputCls}
                />
                <div className="flex gap-1">
                  <select
                    value={presetDraft.authMode}
                    onChange={(e) =>
                      setPresetDraft((d) => ({ ...d, authMode: e.target.value as AuthMode }))
                    }
                    className={cn(inputCls, "flex-1")}
                  >
                    <option value="auth_token">Bearer</option>
                    <option value="api_key">x-api-key</option>
                  </select>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={savePreset}
                    disabled={!presetDraft.name.trim() || !presetDraft.baseUrl.trim()}
                  >
                    保存
                  </Button>
                </div>
              </div>
            )}
            <ul className="space-y-0.5">
              {presets.map((p) => (
                <li key={p.id} className="group flex items-center gap-1 rounded px-1 py-0.5 text-[0.7143em] text-content-muted">
                  <span className="min-w-0 flex-1 truncate" title={`${p.baseUrl} (${p.authMode})`}>
                    {p.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => void deletePreset(p.id)}
                    className="shrink-0 text-content-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    title="删除预设"
                  >
                    <IconTrash size={11} />
                  </button>
                </li>
              ))}
              {presets.length === 0 && !showPresetForm && (
                <li className="text-[0.7143em] text-content-subtle">暂无预设</li>
              )}
            </ul>
            <p className="mt-1 text-[0.6428em] leading-relaxed text-content-subtle">
              预设仅保存端点地址与认证方式(不含密钥),可在各供应商表单中一键导入。
            </p>
          </div>
        </aside>

        {/* ───────── Right: config form / empty state ───────── */}
        <div className="min-h-0 overflow-y-auto pr-1">
          {form == null ? (
            <EmptyDetail />
          ) : (
            <ProviderForm
              form={form}
              test={test}
              saving={saving}
              error={error}
              advancedOpen={advancedOpen}
              update={update}
              updateRole={updateRole}
              setAdvancedOpen={setAdvancedOpen}
              runTest={runTest}
              save={save}
              cancel={cancel}
              presets={presets}
              applyPreset={applyPreset}
              onDelete={
                form.id
                  ? () => {
                      const target = customModels.find((m) => m.id === form.id);
                      if (target) setPendingDelete(target);
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>

      {/* ───────── Delete confirmation Dialog ───────── */}
      <Dialog.Root
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <IconAlertTriangle size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title>删除供应商</Dialog.Title>
                <Dialog.Description className="mt-1">
                  确认删除「{pendingDelete?.name}」?此操作不可撤销,关联的 Token 也会一并清除。
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingDelete(null)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void confirmRemove()}
              >
                <IconTrash size={12} />
                删除
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** Right-pane empty state — nothing selected. */
function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-2 text-2xl text-content-subtle">⚙️</div>
      <p className="max-w-[220px] text-[0.7857em] leading-relaxed text-content-subtle">
        从左侧选择一个供应商查看或修改配置,或点击「新增供应商」添加新的 Anthropic 兼容端点。
      </p>
    </div>
  );
}

/** Right-pane config form. All the actual editing logic lives here; the parent
 *  owns the state and passes setters down. */
function ProviderForm({
  form,
  test,
  saving,
  error,
  advancedOpen,
  update,
  updateRole,
  setAdvancedOpen,
  runTest,
  save,
  cancel,
  presets,
  applyPreset,
  onDelete,
}: {
  form: FormState;
  test: TestState;
  saving: boolean;
  error: string | null;
  advancedOpen: boolean;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  updateRole: (role: CustomModelRoleKey, patch: Partial<RoleBinding>) => void;
  setAdvancedOpen: (updater: (v: boolean) => boolean) => void;
  runTest: () => void;
  save: () => void;
  cancel: () => void;
  /** Endpoint presets for the import dropdown. */
  presets: EndpointPresetPublic[];
  /** Fill baseUrl/authMode from a preset. */
  applyPreset: (presetId: string) => void;
  onDelete?: () => void;
}) {
  const isEdit = !!form.id;
  const isOpenAi = form.protocol === "openai";
  return (
    <div className="space-y-2.5">
      <Field label="API 格式">
        <select
          value={form.protocol}
          onChange={(e) => update("protocol", e.target.value as Protocol)}
          className={inputCls}
        >
          <option value="anthropic">Anthropic(原生 /v1/messages)</option>
          <option value="openai">OpenAI(/v1/chat/completions,经本地协议翻译)</option>
        </select>
      </Field>
      {isOpenAi && (
        <p className="text-[10px] leading-relaxed text-content-subtle">
          OpenAI 格式端点(OpenAI 官方 / Azure / vLLM / Ollama / one-api 等)会启用内置协议翻译层:Claude 仍按 Anthropic 协议运行,应用在本地把请求/响应实时翻译成 OpenAI 格式转发。建议把所有角色填成同一个模型,后台请求(Haiku/Subagent 等)也会用到。
        </p>
      )}
      <Field label="名称">
        <input
          type="text"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="DeepSeek 中转"
          className={inputCls}
          spellCheck={false}
        />
      </Field>
      {presets.length > 0 && (
        <Field label="从预设导入">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) applyPreset(e.target.value);
            }}
            className={inputCls}
          >
            <option value="" disabled>
              选择端点预设(base URL / 认证方式自动填充)
            </option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.baseUrl} ({p.authMode === "api_key" ? "x-api-key" : "Bearer"})
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Base URL">
        <input
          type="text"
          value={form.baseUrl}
          onChange={(e) => update("baseUrl", e.target.value)}
          placeholder={isOpenAi ? "https://api.openai.com/v1" : "https://api.deepseek.com/anthropic"}
          className={inputCls}
          spellCheck={false}
        />
      </Field>
      <div className="grid grid-cols-[1fr_120px] gap-2">
        <Field label="Token / API Key">
          <input
            type="password"
            value={form.authToken}
            onChange={(e) => update("authToken", e.target.value)}
            placeholder={isEdit ? "留空 = 保持现有 token 不变" : "sk-..."}
            className={inputCls}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Field label="认证方式">
          <select
            value={form.authMode}
            onChange={(e) => update("authMode", e.target.value as AuthMode)}
            className={inputCls}
          >
            <option value="auth_token">Bearer (AUTH_TOKEN)</option>
            <option value="api_key">x-api-key (API_KEY)</option>
          </select>
        </Field>
      </div>
      {form.authMode === "api_key" && (
        <p className="text-[0.7143em] leading-relaxed text-content-subtle">
          提示:DeepSeek / one-api / new-api 等网关官方文档推荐 <code className="rounded bg-surface-muted px-0.5">Bearer (AUTH_TOKEN)</code>。若选 x-api-key 后网关返回 404「model may not exist」(而非 401),多半是网关用 404 隐藏端点存在 —— 改回 Bearer 重试。
        </p>
      )}

      {/* Role-binding table — the core of the config. */}
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[11px] font-medium text-content-muted">角色绑定</span>
          <span className="flex items-center gap-2">
            {isOpenAi && (
              <button
                type="button"
                onClick={() => {
                  // Copy the test-role's model to every role — OpenAI endpoints
                  // usually expose a single model, so binding all five tiers
                  // to it keeps background requests (Haiku/Subagent) routed too.
                  const src = form.roles[form.testRole]?.requestModel?.trim();
                  if (!src) return;
                  const filled: RoleBindings = {};
                  for (const r of CUSTOM_MODEL_ROLES) filled[r] = { requestModel: src };
                  update("roles", filled);
                }}
                className="text-[10px] text-accent hover:text-accent/80"
                title="把「测试角色」的模型填到所有角色(OpenAI 通常只有一个模型)"
              >
                一键填充主模型
              </button>
            )}
            <span className="text-[10px] text-content-subtle">
              点左侧圆点选择「测试连接」用哪个角色
            </span>
          </span>
        </div>
        <p className="mb-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
          Claude Code 按 5 个角色路由请求:Haiku/Sonnet/Opus/Fable 是模型别名;Subagent 是内置 Task 工具调用的模型。
          填了「实际请求模型」的角色才会在下拉框出现。勾选 1M 后,选中该角色时会在模型名后追加 <code className="rounded bg-surface-muted px-0.5">[1m]</code> 后缀(DeepSeek 等网关的 1M 上下文声明方式)。
        </p>
        <div className="overflow-hidden rounded border border-edge">
          {/* Header row */}
          <div className="grid grid-cols-[20px_56px_1fr_1fr_44px] items-center gap-1.5 border-b border-edge bg-surface-muted px-1.5 py-1 text-[9px] font-medium uppercase tracking-wide text-content-subtle">
            <span />
            <span>角色</span>
            <span>显示名称</span>
            <span>实际请求模型</span>
            <span className="text-center">1M</span>
          </div>
          {/* One row per role. */}
          {CUSTOM_MODEL_ROLES.map((role) => {
            const binding = form.roles[role] ?? {};
            const isTestTarget = form.testRole === role;
            return (
              <div
                key={role}
                className="grid grid-cols-[20px_56px_1fr_1fr_44px] items-center gap-1.5 border-b border-edge px-1.5 py-1 last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => update("testRole", role)}
                  title={`用「${CUSTOM_MODEL_ROLE_LABELS[role]}」角色测试连接`}
                  className={cn(
                    "flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px]",
                    isTestTarget
                      ? "bg-accent text-surface"
                      : "bg-surface-hover text-content-subtle hover:bg-surface-muted",
                  )}
                >
                  ●
                </button>
                <span className="text-[0.7857em] font-medium text-content">
                  {CUSTOM_MODEL_ROLE_LABELS[role]}
                </span>
                <input
                  type="text"
                  value={binding.displayName ?? ""}
                  onChange={(e) =>
                    updateRole(role, { displayName: e.target.value || undefined })
                  }
                  placeholder="可选"
                  className={inputCls}
                  spellCheck={false}
                />
                <input
                  type="text"
                  value={binding.requestModel ?? ""}
                  onChange={(e) =>
                    updateRole(role, { requestModel: e.target.value || undefined })
                  }
                  placeholder={roleHint(role)}
                  className={cn(inputCls, "font-mono")}
                  spellCheck={false}
                />
                <div className="flex justify-center">
                  <Toggle
                    checked={Boolean(binding.supports1m)}
                    onChange={(v) => updateRole(role, { supports1m: v || undefined })}
                    label="选中此角色时在模型名后追加 [1m] 后缀(DeepSeek 等网关的 1M 上下文声明方式)"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Collapsible advanced section */}
      <button
        onClick={() => setAdvancedOpen((v) => !v)}
        className="flex items-center gap-1 pt-1 text-[0.7857em] text-content-subtle hover:text-content-muted"
      >
        <span className={cn("inline-block transition-transform", advancedOpen && "rotate-90")}>▶</span>
        高级选项(超时 / 禁用遥测)
      </button>
      {advancedOpen && (
        <div className="space-y-2 rounded border border-edge bg-surface/50 p-2">
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Field label="超时 (ms, 可选)">
              <input
                type="text"
                value={form.timeoutMs}
                onChange={(e) => update("timeoutMs", e.target.value)}
                placeholder="3000000"
                className={inputCls}
                spellCheck={false}
              />
            </Field>
            <label className="flex items-end gap-1.5 pb-1 text-[0.7857em] text-content-muted">
              <input
                type="checkbox"
                checked={form.disableNonEssentialTraffic}
                onChange={(e) => update("disableNonEssentialTraffic", e.target.checked)}
                className="accent-accent"
              />
              禁用遥测
            </label>
          </div>
        </div>
      )}

      {error && <div className="text-[0.7857em] text-danger">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          variant="secondary"
          size="sm"
          onClick={runTest}
          disabled={test.status === "testing"}
          title="测试当前选中的角色(左侧绿点的那个)"
        >
          {test.status === "testing" ? "测试中…" : "测试连接"}
        </Button>
        <span className="truncate text-[0.7143em] text-content-subtle">
          测:{CUSTOM_MODEL_ROLE_LABELS[form.testRole]} · {form.roles[form.testRole]?.requestModel?.trim() || "(空)"}
        </span>
        {test.status === "ok" && (
          <span className="text-[0.7857em] text-accent">✓ {test.detail}</span>
        )}
        {test.status === "fail" && (
          <span className="text-[0.7857em] text-danger">✗ {test.error}</span>
        )}

        <div className="flex-1" />
        {isEdit && onDelete && (
          <Button variant="danger" size="sm" onClick={onDelete} title="删除此供应商">
            <IconTrash size={12} />
            删除
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={cancel}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={saving}
        >
          {saving ? "保存中…" : isEdit ? "更新" : "保存"}
        </Button>
      </div>
    </div>
  );
}

/** Placeholder hint for the request-model input, per role. Just a UX nudge —
 *  the user can type anything. The sonnet hint shows the [1M] suffix form to
 *  remind the user that 1M is declared via suffix (just type the base name;
 *  the suffix is added automatically when 1M is toggled on). */
function roleHint(role: CustomModelRoleKey): string {
  switch (role) {
    case "haiku":
      return "deepseek-v4-flash";
    case "sonnet":
      return "deepseek-v4-pro";
    case "opus":
      return "deepseek-v4-pro-max";
    case "fable":
      return "claude-fable-5";
    case "subagent":
      return "(Task 工具用,可留空)";
  }
}

const inputCls =
  "min-w-0 flex-1 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">{label}</span>
      {children}
    </label>
  );
}

/** Compact inline toggle switch. Styled to match the existing accent token. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full transition-colors",
        checked ? "bg-accent" : "bg-surface-hover",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-3 w-3 rounded-full bg-surface shadow transition-transform",
          checked ? "left-3.5" : "left-0.5",
        )}
      />
    </button>
  );
}
