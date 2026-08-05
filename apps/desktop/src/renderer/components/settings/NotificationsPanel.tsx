/**
 * Notifications settings panel.
 *
 * Controls the user's notification preferences (NotificationPrefs), persisted
 * via the `notification:setPrefs` IPC. The main-process NotificationManager
 * reads these to decide whether to fire OS notifications; the renderer's
 * in-app toast layer (sessionStore.pushToast) also respects the same prefs
 * indirectly (toasts only fire when the window is focused, at which point OS
 * notifications are suppressed - so the prefs gate the toast content too).
 *
 * Five toggles:
 *  - OS 通知总开关   (osEnabled) - master switch for system notifications
 *  - 阻塞类事件      (blocking)  - approval / question / plan approval
 *  - 回合完成        (turnComplete)
 *  - 错误            (errors)
 *  - 后台任务        (backgroundTasks)
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import type { NotificationPrefs } from "@contracts/ipc";
import { DEFAULT_NOTIFICATION_PREFS } from "@contracts/ipc";
import { cn } from "@renderer/lib/cn.js";
import { SettingRow } from "./SettingRow.js";

export function NotificationsPanel() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [loaded, setLoaded] = useState(false);

  // Load prefs on mount.
  useEffect(() => {
    void api.notification.getPrefs().then((res) => {
      setPrefs(res.prefs);
      setLoaded(true);
    });
  }, []);

  // Persist a single pref change.
  const update = (patch: Partial<NotificationPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    void api.notification.setPrefs(next);
  };

  return (
    <div className="divide-y divide-edge">
      <div className="pb-3">
        <h2 className="font-semibold text-content">消息通知</h2>
        <p className="mt-0.5 text-[0.7857em] text-content-subtle">
          配置后台会话活动何时通知你。应用失焦时使用系统通知,聚焦时使用应用内 Toast。未读事件始终在左侧会话列表和标签栏显示角标。
        </p>
      </div>

      {/* Master OS notification switch */}
      <SettingRow
        title="系统通知"
        desc="开启后,应用失焦或最小化时通过操作系统通知中心推送通知。关闭后仅保留应用内 Toast 和角标。"
        htmlFor="setting-notif-os"
      >
        <Toggle
          id="setting-notif-os"
          checked={prefs.osEnabled}
          disabled={!loaded}
          onChange={(v) => update({ osEnabled: v })}
          label={prefs.osEnabled ? "已开启" : "已关闭"}
        />
      </SettingRow>

      {/* Blocking events */}
      <SettingRow
        title="阻塞类事件"
        desc="Agent 请求审批工具调用、向你提问、或提交计划待批准时通知。这是最高优先级通知——不响应 Agent 会一直等待。"
      >
        <Toggle
          checked={prefs.blocking}
          disabled={!loaded}
          onChange={(v) => update({ blocking: v })}
          label={prefs.blocking ? "已开启" : "已关闭"}
        />
      </SettingRow>

      {/* Turn completion */}
      <SettingRow
        title="回合完成"
        desc="Agent 完成一轮任务时通知。适用于你切走后想知道任务是否做完的场景。"
      >
        <Toggle
          checked={prefs.turnComplete}
          disabled={!loaded}
          onChange={(v) => update({ turnComplete: v })}
          label={prefs.turnComplete ? "已开启" : "已关闭"}
        />
      </SettingRow>

      {/* Errors */}
      <SettingRow
        title="错误"
        desc="Agent 运行出错时通知。适用于你切走后 Agent 意外中断需要处理的场景。"
      >
        <Toggle
          checked={prefs.errors}
          disabled={!loaded}
          onChange={(v) => update({ errors: v })}
          label={prefs.errors ? "已开启" : "已关闭"}
        />
      </SettingRow>

      {/* Background tasks */}
      <SettingRow
        title="后台任务"
        desc="后台运行的子代理任务完成时通知。适用于你启动了后台任务后切走,想知道它何时结束的场景。"
      >
        <Toggle
          checked={prefs.backgroundTasks}
          disabled={!loaded}
          onChange={(v) => update({ backgroundTasks: v })}
          label={prefs.backgroundTasks ? "已开启" : "已关闭"}
        />
      </SettingRow>
    </div>
  );
}

/** Compact inline toggle switch. Styled to match the existing accent token.
 *  Mirrors the Toggle in TitleGenPanel / CustomModelsPanel. */
function Toggle({
  id,
  checked,
  disabled,
  onChange,
  label,
}: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full transition-colors",
        checked ? "bg-accent" : "bg-surface-hover",
        disabled && "cursor-not-allowed opacity-50",
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
