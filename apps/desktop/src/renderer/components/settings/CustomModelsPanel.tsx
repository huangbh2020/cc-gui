import { useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import {
  CUSTOM_MODEL_ROLES,
  CUSTOM_MODEL_ROLE_LABELS,
} from "@contracts/customModel";
import type {
  CustomModelPublic,
  AuthMode,
  RoleBindings,
  RoleBinding,
  CustomModelRoleKey,
} from "@contracts/customModel";

/**
 * Self-contained panel for managing user-defined custom-model configs
 * (Anthropic-compatible endpoints: DeepSeek `/anthropic`, one-api, new-api,
 * self-hosted proxies, …). Lives inside the Settings modal.
 *
 * ## Model: role bindings (5 tiers)
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
 * Flow: list existing configs → "Add" opens an inline form → fill fields →
 * "Test connection" probes the endpoint with the (not-yet-saved) values →
 * "Save" encrypts the token on the main side and refreshes the list.
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

  const [form, setForm] = useState<FormState | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startAdd = () => {
    setForm(emptyForm());
    setAdvancedOpen(false);
    setTest({ status: "idle" });
    setError(null);
  };

  const startEdit = (m: CustomModelPublic) => {
    setForm(formFromConfig(m));
    // Auto-open advanced if any advanced field is set, so the user sees them.
    setAdvancedOpen(Boolean(m.timeoutMs));
    setTest({ status: "idle" });
    setError(null);
  };

  const cancel = () => {
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
        // Omit authToken on edit when blank → main keeps the stored token.
        authToken: form.authToken.trim() || undefined,
        roles,
        disableNonEssentialTraffic: form.disableNonEssentialTraffic,
        timeoutMs,
      });
      useSessionStore.setState({ customModels: saved });
      setForm(null);
      setTest({ status: "idle" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
      void reloadCustomModels();
    }
  };

  const remove = async (id: string) => {
    if (!confirm("删除这个自定义模型配置?")) return;
    try {
      const { models } = await api.customModel.delete({ id });
      useSessionStore.setState({ customModels: models });
      if (form?.id === id) setForm(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-content-muted">自定义模型</span>
        {form == null && (
          <button
            onClick={startAdd}
            className="rounded bg-surface-muted px-2 py-0.5 text-[11px] text-content-muted hover:bg-surface-hover"
          >
            + 添加
          </button>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-content-subtle">
        添加 Anthropic 兼容端点(DeepSeek / one-api / new-api / 自建网关)。Token 用系统钥匙串加密存储,明文不落盘。
        每行把一个角色(Haiku/Sonnet/Opus/Fable/Subagent)绑定到网关真实模型;会话里选哪个角色,就用该行的模型发起请求。
      </p>

      {/* Existing list */}
      {customModels.length > 0 && (
        <ul className="space-y-1">
          {customModels.map((m) => {
            const boundCount = CUSTOM_MODEL_ROLES.filter((r) =>
              m.roles[r]?.requestModel?.trim(),
            ).length;
            return (
              <li
                key={m.id}
                className="flex items-center justify-between rounded border border-edge bg-surface px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-medium text-content">{m.name}</div>
                  <div className="truncate text-[10px] text-content-subtle">
                    {boundCount > 0
                      ? `${boundCount} 个角色 · ${m.authMode === "api_key" ? "x-api-key" : "Bearer"} · ${m.authTokenMasked}`
                      : "未绑定角色"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => startEdit(m)}
                    className="rounded px-1.5 py-0.5 text-[10px] text-content-muted hover:bg-surface-muted hover:text-content"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void remove(m.id)}
                    className="rounded px-1.5 py-0.5 text-[10px] text-content-subtle hover:bg-danger/20 hover:text-danger"
                  >
                    删除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Inline add/edit form */}
      {form && (
        <div className="space-y-2 rounded border border-edge bg-surface p-2.5">
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
          <Field label="Base URL">
            <input
              type="text"
              value={form.baseUrl}
              onChange={(e) => update("baseUrl", e.target.value)}
              placeholder="https://api.deepseek.com/anthropic"
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
                placeholder={form.id ? "留空 = 保持现有 token 不变" : "sk-..."}
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
            <p className="text-[10px] leading-relaxed text-content-subtle">
              提示:DeepSeek / one-api / new-api 等网关官方文档推荐 <code className="rounded bg-surface-muted px-0.5">Bearer (AUTH_TOKEN)</code>。若选 x-api-key 后网关返回 404「model may not exist」(而非 401),多半是网关用 404 隐藏端点存在 —— 改回 Bearer 重试。
            </p>
          )}

          {/* Role-binding table — the core of the redesign. */}
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[11px] font-medium text-content-muted">角色绑定</span>
              <span className="text-[10px] text-content-subtle">
                点左侧圆点选择「测试连接」用哪个角色
              </span>
            </div>
            <p className="mb-1.5 text-[10px] leading-relaxed text-content-subtle">
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
                      className={`flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] ${
                        isTestTarget
                          ? "bg-accent text-surface"
                          : "bg-surface-hover text-content-subtle hover:bg-surface-muted"
                      }`}
                    >
                      ●
                    </button>
                    <span className="text-[11px] font-medium text-content">
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
                      className={`${inputCls} font-mono`}
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
            className="flex items-center gap-1 pt-1 text-[11px] text-content-subtle hover:text-content-muted"
          >
            <span className={`inline-block transition-transform ${advancedOpen ? "rotate-90" : ""}`}>▶</span>
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
                <label className="flex items-end gap-1.5 pb-1 text-[11px] text-content-muted">
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

          {error && <div className="text-[11px] text-danger">{error}</div>}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void runTest()}
              disabled={test.status === "testing"}
              className="rounded bg-surface-muted px-3 py-1 text-[11px] text-content-muted hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              title="测试当前选中的角色(左侧绿点的那个)"
            >
              {test.status === "testing" ? "测试中…" : "测试连接"}
            </button>
            <span className="truncate text-[10px] text-content-subtle">
              测:{CUSTOM_MODEL_ROLE_LABELS[form.testRole]} · {form.roles[form.testRole]?.requestModel?.trim() || "(空)"}
            </span>
            {test.status === "ok" && (
              <span className="text-[11px] text-accent">✓ {test.detail}</span>
            )}
            {test.status === "fail" && (
              <span className="text-[11px] text-danger">✗ {test.error}</span>
            )}

            <div className="flex-1" />
            <button
              onClick={cancel}
              className="rounded px-3 py-1 text-[11px] text-content-muted hover:bg-surface-muted hover:text-content"
            >
              取消
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="rounded bg-accent px-3 py-1 text-[11px] font-medium text-surface hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "保存中…" : form.id ? "更新" : "保存"}
            </button>
          </div>
        </div>
      )}
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
  "min-w-0 flex-1 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[11px] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-content-muted">{label}</span>
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
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-surface-hover"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-surface shadow transition-transform ${
          checked ? "left-3.5" : "left-0.5"
        }`}
      />
    </button>
  );
}
