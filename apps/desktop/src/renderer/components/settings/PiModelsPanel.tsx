import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import {
  IconPlus,
  IconTrash,
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import {
  PI_KNOWN_APIS,
  PI_THINKING_KEYS,
  type PiProviderConfig,
  type PiModelDefinition,
  type PiThinkingKey,
} from "@contracts/piModel";
import type { EndpointPresetPublic } from "@contracts/endpointPreset";

/**
 * Pi models config panel — visual editor for `~/.pi/agent/models.json`.
 *
 * Two-column layout mirroring CustomModelsPanel:
 *   left  → custom provider list + endpoint presets
 *   right → provider form (baseUrl / api / apiKey / authHeader / models[]),
 *           each model row editable (id / name / contextWindow / maxTokens /
 *           reasoning / thinkingLevelMap).
 *
 * Key invariants (see main/lib/piModelsStore.ts):
 *   - Save MERGES into the file: only the edited provider is replaced, unknown
 *     fields (headers / compat / modelOverrides) are preserved.
 *   - apiKey is stored separately (safeStorage-encrypted in the settings
 *     table, never in models.json) and injected at turn time via
 *     ModelRuntime.setRuntimeApiKey — the UI accepts a plaintext key.
 *
 * Models are written back to ~/.pi/agent/models.json; the Pi SDK re-reads the
 * file on every startTurn, so changes apply without restarting.
 */

type TestState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "ok"; detail: string }
  | { status: "fail"; error: string };

interface ModelFormState {
  id: string;
  name: string;
  contextWindow: string; // string in form; parsed on save
  maxTokens: string;
  reasoning: boolean;
  thinking: Record<PiThinkingKey, "default" | "null" | "value">;
  thinkingValue: Record<PiThinkingKey, string>;
}

interface FormState {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  authHeader: boolean;
  models: ModelFormState[];
}

function emptyForm(): FormState {
  return {
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    authHeader: false,
    models: [],
  };
}

function emptyModel(): ModelFormState {
  return {
    id: "",
    name: "",
    contextWindow: "",
    maxTokens: "",
    reasoning: false,
    thinking: {
      off: "default",
      minimal: "default",
      low: "default",
      medium: "default",
      high: "default",
      xhigh: "default",
    },
    thinkingValue: {
      off: "",
      minimal: "",
      low: "",
      medium: "",
      high: "",
      xhigh: "",
    },
  };
}

/** Convert a PiModelDefinition to the form state. */
function modelFromDef(def: PiModelDefinition): ModelFormState {
  const m = emptyModel();
  m.id = def.id ?? "";
  m.name = def.name ?? "";
  m.contextWindow = def.contextWindow ? String(def.contextWindow) : "";
  m.maxTokens = def.maxTokens ? String(def.maxTokens) : "";
  m.reasoning = def.reasoning ?? false;
  const tlm = def.thinkingLevelMap ?? {};
  for (const k of PI_THINKING_KEYS) {
    const v = tlm[k];
    if (v === null) {
      m.thinking[k] = "null";
    } else if (typeof v === "string") {
      m.thinking[k] = "value";
      m.thinkingValue[k] = v;
    } else {
      m.thinking[k] = "default";
    }
  }
  return m;
}

/** Convert a PiProviderConfig to the form state. */
function formFromConfig(name: string, cfg: PiProviderConfig): FormState {
  return {
    name: cfg.name ?? name,
    baseUrl: cfg.baseUrl ?? "",
    api: cfg.api ?? "openai-completions",
    apiKey: cfg.apiKey ?? "",
    authHeader: cfg.authHeader ?? false,
    models: (cfg.models ?? []).map(modelFromDef),
  };
}

/** Build the PiProviderConfig from the form. The apiKey is NOT included
 *  here — it's passed as a separate top-level field on save (encrypted in
 *  the settings table, never in models.json). Unknown fields dropped; the
 *  store preserves the file's other providers/fields on merge. */
function configFromForm(form: FormState): PiProviderConfig {
  const models: PiModelDefinition[] = form.models
    .filter((m) => m.id.trim())
    .map((m) => {
      const def: PiModelDefinition = { id: m.id.trim() };
      if (m.name.trim()) def.name = m.name.trim();
      const cw = Number(m.contextWindow);
      if (m.contextWindow.trim() && Number.isFinite(cw) && cw > 0) def.contextWindow = cw;
      const mt = Number(m.maxTokens);
      if (m.maxTokens.trim() && Number.isFinite(mt) && mt > 0) def.maxTokens = mt;
      if (m.reasoning) def.reasoning = true;
      const tlm: NonNullable<PiModelDefinition["thinkingLevelMap"]> = {};
      let hasMap = false;
      for (const k of PI_THINKING_KEYS) {
        const mode = m.thinking[k];
        if (mode === "null") {
          tlm[k] = null;
          hasMap = true;
        } else if (mode === "value") {
          const v = m.thinkingValue[k].trim();
          if (v) {
            tlm[k] = v;
            hasMap = true;
          }
        }
      }
      if (hasMap) def.thinkingLevelMap = tlm;
      return def;
    });

  const cfg: PiProviderConfig = {};
  if (form.name.trim()) cfg.name = form.name.trim();
  if (form.baseUrl.trim()) cfg.baseUrl = form.baseUrl.trim();
  if (form.api) cfg.api = form.api;
  if (form.authHeader) cfg.authHeader = true;
  cfg.models = models;
  return cfg;
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

/** Compact inline toggle switch. */
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

function EmptyDetail() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-[300px] text-center">
        <p className="text-[0.9286em] font-medium text-content-muted">Pi 模型配置</p>
        <p className="mt-1 text-[0.7857em] leading-relaxed text-content-subtle">
          左侧选择一个自定义 Provider,或点击「新增 Provider」创建。
          保存后写入 <code className="rounded bg-surface-muted px-1">~/.pi/agent/models.json</code>,
          Pi SDK 下次会话自动加载。
        </p>
      </div>
    </div>
  );
}

export function PiModelsPanel() {
  const [providers, setProviders] = useState<Record<string, PiProviderConfig>>({});
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [expandedModel, setExpandedModel] = useState<number | null>(null);

  // Endpoint presets for the "从预设导入" dropdown.
  const [presets, setPresets] = useState<EndpointPresetPublic[]>([]);

  const providerNames = Object.keys(providers);

  const reload = async () => {
    try {
      const { providers } = await api.piModels.list();
      setProviders(providers);
    } catch (err) {
      console.error("piModels.list failed:", err);
    }
  };

  useEffect(() => {
    void reload();
    void api.endpointPreset
      .list()
      .then(({ presets }) => setPresets(presets))
      .catch((err) => console.error("endpointPreset.list failed:", err));
  }, []);

  const startAdd = () => {
    setSelectedId("new");
    setForm(emptyForm());
    setError(null);
  };

  const startEdit = (name: string) => {
    const cfg = providers[name];
    if (!cfg) return;
    setSelectedId(name);
    setForm(formFromConfig(name, cfg));
    setError(null);
    setExpandedModel(null);
  };

  const cancel = () => {
    setSelectedId(null);
    setForm(null);
    setError(null);
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const updateModel = (idx: number, patch: Partial<ModelFormState>) =>
    setForm((prev) => {
      if (!prev) return prev;
      const models = prev.models.slice();
      models[idx] = { ...models[idx], ...patch };
      return { ...prev, models };
    });

  const addModel = () =>
    setForm((prev) => (prev ? { ...prev, models: [...prev.models, emptyModel()] } : prev));

  const removeModel = (idx: number) =>
    setForm((prev) => {
      if (!prev) return prev;
      const models = prev.models.filter((_, i) => i !== idx);
      return { ...prev, models };
    });

  /** Fill baseUrl/authMode from an endpoint preset. */
  const applyPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setForm((prev) => (prev ? { ...prev, baseUrl: preset.baseUrl } : prev));
  };

  const save = async () => {
    if (!form) return;
    // Client-side validation (mirrors the store's checks).
    if (!form.name.trim()) {
      setError("Provider 名称不能为空");
      return;
    }
    if (!form.baseUrl.trim()) {
      setError("Base URL 不能为空");
      return;
    }
    if (!form.api) {
      setError("API 类型不能为空");
      return;
    }
    // apiKey is required on create; on edit, empty = keep existing.
    if (selectedId === "new" && !form.apiKey.trim()) {
      setError("请填写 API Key");
      return;
    }
    const validModels = form.models.filter((m) => m.id.trim());
    if (validModels.length === 0) {
      setError("至少需要配置一个模型");
      return;
    }
    for (const m of validModels) {
      if (m.contextWindow.trim()) {
        const cw = Number(m.contextWindow);
        if (!Number.isFinite(cw) || cw <= 0) {
          setError(`模型 ${m.id}:contextWindow 必须大于 0`);
          return;
        }
      }
      if (m.maxTokens.trim()) {
        const mt = Number(m.maxTokens);
        if (!Number.isFinite(mt) || mt <= 0) {
          setError(`模型 ${m.id}:maxTokens 必须大于 0`);
          return;
        }
      }
    }

    setSaving(true);
    setError(null);
    try {
      const cfg = configFromForm(form);
      // apiKey is passed as a top-level field (not inside cfg) — the store
      // encrypts it via safeStorage and stores separately from models.json.
      // On edit, an empty apiKey is preserved (server treats "" as "keep").
      const { providers: next } = await api.piModels.save({
        name: form.name.trim(),
        config: cfg,
        apiKey: form.apiKey,
      });
      setProviders(next);
      setSelectedId(form.name.trim());
      setError(null);
      // Refresh the composer's model picker so newly-added/removed pi models
      // appear immediately (without requiring an app restart).
      void useSessionStore.getState().reloadPiAvailableModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (!pendingDelete) return;
    try {
      const { providers: next } = await api.piModels.delete({ name: pendingDelete });
      setProviders(next);
      if (selectedId === pendingDelete) cancel();
      // Refresh the composer's model picker so removed models disappear.
      void useSessionStore.getState().reloadPiAvailableModels();
    } catch (err) {
      setError((err as Error).message);
    }
    setPendingDelete(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] gap-4">
        {/* ───────── Left: provider list ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>Pi Providers</span>
            <span className="tabular-nums">{providerNames.length}</span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {selectedId === "new" && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                新建 Provider
              </div>
            )}
            {providerNames.map((name) => {
              const isActive = selectedId === name;
              const cfg = providers[name];
              const modelCount = cfg?.models?.length ?? 0;
              return (
                <button
                  key={name}
                  onClick={() => startEdit(name)}
                  className={cn(
                    "relative block w-full rounded px-2.5 py-1.5 text-left transition-colors",
                    isActive ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                  )}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                  )}
                  <div className="truncate text-[0.7857em] font-medium text-content">{name}</div>
                  <div className="truncate text-[0.7143em] text-content-subtle">
                    {[
                      modelCount > 0 ? `${modelCount} 模型` : "无模型",
                      cfg?.api,
                      cfg?.hasApiKey ? "已配置 Key" : "未配置 Key",
                    ].filter(Boolean).join(" · ")}
                  </div>
                </button>
              );
            })}
            {providerNames.length === 0 && selectedId !== "new" && (
              <div className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                还没有自定义 Provider。
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
              新增 Provider
            </Button>
          </div>

          {/* ───── Endpoint presets (shared with claude customModel) ───── */}
          <div className="border-t border-edge/60 p-2">
            <span className="mb-1 block text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
              端点预设
            </span>
            {presets.length > 0 && form != null && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) applyPreset(e.target.value);
                }}
                className={cn(inputCls, "mb-1 text-[0.7857em]")}
              >
                <option value="" disabled>
                  导入端点预设(填 Base URL)
                </option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.baseUrl}
                  </option>
                ))}
              </select>
            )}
            <p className="text-[0.6428em] leading-relaxed text-content-subtle">
              预设不含密钥,可在「模型配置」页管理。
            </p>
          </div>
        </aside>

        {/* ───────── Right: provider form / empty state ───────── */}
        <div className="min-h-0 overflow-y-auto pr-1">
          {form == null ? (
            <EmptyDetail />
          ) : (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Provider 名称">
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder="deepseek"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
                <Field label="API 类型">
                  <select
                    value={form.api}
                    onChange={(e) => update("api", e.target.value)}
                    className={inputCls}
                  >
                    {PI_KNOWN_APIS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Base URL">
                <input
                  type="text"
                  value={form.baseUrl}
                  onChange={(e) => update("baseUrl", e.target.value)}
                  placeholder="https://api.deepseek.com"
                  className={inputCls}
                  spellCheck={false}
                />
              </Field>

              <Field label={`API Key${selectedId !== "new" ? "(留空保持现有)" : ""}`}>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => update("apiKey", e.target.value)}
                  placeholder="sk-..."
                  className={inputCls}
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="mt-0.5 text-[0.6428em] leading-relaxed text-content-subtle">
                  密钥经 safeStorage 加密后存于设置表,不会写入 models.json,turn 开始时由 Mcode 注入到 Pi。
                </p>
              </Field>

              <div className="flex items-center gap-2">
                <Toggle
                  checked={form.authHeader}
                  onChange={(v) => update("authHeader", v)}
                  label="自动添加 Authorization: Bearer 请求头"
                />
                <span className="text-[0.7857em] text-content-muted">自动添加 Bearer 请求头</span>
              </div>

              {/* ───── Models sub-table ───── */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[0.7857em] font-medium text-content-muted">
                    模型列表({form.models.filter((m) => m.id.trim()).length})
                  </span>
                  <button
                    type="button"
                    onClick={addModel}
                    className="flex items-center gap-1 text-[0.7857em] text-accent hover:text-accent/80"
                  >
                    <IconPlus size={11} />
                    添加模型
                  </button>
                </div>
                {form.models.length === 0 && (
                  <p className="rounded border border-dashed border-edge px-2 py-3 text-center text-[0.7143em] text-content-subtle">
                    尚未添加模型,至少需要一个模型才能保存。
                  </p>
                )}
                <div className="space-y-1.5">
                  {form.models.map((m, idx) => (
                    <div key={idx} className="rounded border border-edge bg-surface/40 p-2">
                      <div className="grid grid-cols-[1fr_80px_80px_auto_auto] items-center gap-1.5">
                        <input
                          type="text"
                          value={m.id}
                          onChange={(e) => updateModel(idx, { id: e.target.value })}
                          placeholder="模型 id,如 deepseek-v4-pro"
                          className={inputCls}
                          spellCheck={false}
                        />
                        <input
                          type="text"
                          value={m.contextWindow}
                          onChange={(e) => updateModel(idx, { contextWindow: e.target.value })}
                          placeholder="上下文"
                          className={inputCls}
                          title="上下文窗口(token)"
                        />
                        <input
                          type="text"
                          value={m.maxTokens}
                          onChange={(e) => updateModel(idx, { maxTokens: e.target.value })}
                          placeholder="最大输出"
                          className={inputCls}
                          title="最大输出 token"
                        />
                        <span className="flex items-center gap-1">
                          <Toggle
                            checked={m.reasoning}
                            onChange={(v) => updateModel(idx, { reasoning: v })}
                            label="支持推理"
                          />
                          <span className="text-[0.6428em] text-content-subtle">推理</span>
                        </span>
                        <span className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => setExpandedModel(expandedModel === idx ? null : idx)}
                            className="rounded p-0.5 text-content-muted hover:bg-surface-hover"
                            title={expandedModel === idx ? "收起思考级别" : "展开思考级别"}
                          >
                            {expandedModel === idx ? (
                              <IconChevronDown size={13} />
                            ) : (
                              <IconChevronRight size={13} />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeModel(idx)}
                            className="rounded p-0.5 text-content-muted hover:text-danger"
                            title="删除模型"
                          >
                            <IconTrash size={12} />
                          </button>
                        </span>
                      </div>
                      {m.name.trim() !== "" && (
                        <div className="mt-1 text-[0.7143em] text-content-subtle">
                          显示名: {m.name}
                        </div>
                      )}
                      {expandedModel === idx && (
                        <div className="mt-2 border-t border-edge/60 pt-1.5">
                          <div className="mb-1 flex items-center gap-2">
                            <input
                              type="text"
                              value={m.name}
                              onChange={(e) => updateModel(idx, { name: e.target.value })}
                              placeholder="显示名(可选)"
                              className={inputCls}
                              spellCheck={false}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            {PI_THINKING_KEYS.map((k) => (
                              <label key={k} className="flex items-center gap-1.5">
                                <span className="w-14 shrink-0 text-[0.7143em] text-content-muted">
                                  {k}
                                </span>
                                <select
                                  value={m.thinking[k]}
                                  onChange={(e) =>
                                    updateModel(idx, {
                                      thinking: { ...m.thinking, [k]: e.target.value as ModelFormState["thinking"][PiThinkingKey] },
                                    })
                                  }
                                  className={cn(inputCls, "text-[0.7143em]")}
                                >
                                  <option value="default">默认</option>
                                  <option value="null">不支持</option>
                                  <option value="value">映射值</option>
                                </select>
                                {m.thinking[k] === "value" && (
                                  <input
                                    type="text"
                                    value={m.thinkingValue[k]}
                                    onChange={(e) =>
                                      updateModel(idx, {
                                        thinkingValue: { ...m.thinkingValue, [k]: e.target.value },
                                      })
                                    }
                                    placeholder="如 max / high"
                                    className={cn(inputCls, "text-[0.7143em]")}
                                    spellCheck={false}
                                  />
                                )}
                              </label>
                            ))}
                          </div>
                          <p className="mt-1 text-[0.6428em] text-content-subtle">
                            思考级别映射:默认=用模型默认;不支持=UI 隐藏该档;映射值=发送给 provider 的具体字符串。
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {error && <div className="rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-[0.7857em] text-danger">{error}</div>}

              <div className="flex items-center justify-end gap-2">
                {selectedId !== "new" && (
                  <Button variant="ghost" size="sm" onClick={() => setPendingDelete(selectedId as string)}>
                    删除
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={cancel}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={save} disabled={saving}>
                  {saving ? "保存中…" : "保存到 models.json"}
                </Button>
              </div>
            </div>
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
                <Dialog.Title>删除 Provider</Dialog.Title>
                <Dialog.Description className="mt-1">
                  确定删除 <code className="rounded bg-surface-muted px-1">{pendingDelete}</code> 吗?
                  将从 models.json 中移除该 Provider 及其模型。
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
                取消
              </Button>
              <Button variant="danger" size="sm" onClick={confirmRemove}>
                删除
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
