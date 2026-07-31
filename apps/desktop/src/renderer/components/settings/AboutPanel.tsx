import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { Button } from "@renderer/components/ui/index.js";
import {
  IconCopy,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconDownload,
  IconRefresh,
  IconAlertTriangle,
  IconRocket,
  SiGithub,
} from "@renderer/lib/icons.js";
import type { AppInfoResult, CheckForUpdatesResult } from "@contracts/ipc";

/**
 * About panel - app identity, runtime info, license, repo links, and update
 * checking.
 *
 * Pulls version + runtime info from the main process via the parameterless
 * `app.info` RPC (electron's `app.getVersion()` + `process.versions`). The
 * "检查更新" button triggers `app.checkForUpdates`; if a newer version exists
 * on the GitHub Releases channel, an `update:available` push event arrives and
 * the panel offers a download button. Once downloaded (`update:downloaded`),
 * a "重启安装" button calls `app.quitAndInstall`.
 *
 * The updater only runs in packaged builds; in dev every check short-circuits
 * to "up-to-date" so the button still works without erroring.
 */

/** App display name (matches the root package.json "name"). */
const APP_NAME = "Mcode";
/** One-line description shown under the app name. */
const APP_DESC = "基于 Claude Agent SDK 构建的桌面端 GUI(Electron 三栏 IDE)";
/** GitHub repo URL. */
const REPO_URL = "https://github.com/huangbh2020/mcode";
/** SPDX license identifier. */
const LICENSE = "MIT";

/** Update flow state shown by the panel. */
type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; version: string }
  | { kind: "downloading" }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

/** Human-readable OS label from the platform string. */
function platformLabel(platform: string): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

export function AboutPanel() {
  const [info, setInfo] = useState<AppInfoResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });

  // Fetch runtime info once on mount. Failures (e.g. main not ready) leave the
  // version rows showing "-" rather than crashing the panel.
  useEffect(() => {
    let cancelled = false;
    void api.app.info().then((result) => {
      if (!cancelled) setInfo(result);
    }).catch(() => {
      // leave info null -> rows render "-"
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to updater push events. update-available fires when the main
  // process finds a newer version (either from the boot check or a manual
  // check); update-downloaded fires once the download finishes.
  useEffect(() => {
    const offAvailable = api.on.updateAvailable((msg) => {
      setUpdateState({ kind: "available", version: msg.version });
    });
    const offDownloaded = api.on.updateDownloaded((msg) => {
      setUpdateState({ kind: "downloaded", version: msg.version });
    });
    return () => {
      offAvailable();
      offDownloaded();
    };
  }, []);

  const versionText = info
    ? `${APP_NAME} v${info.appVersion} / Electron ${info.electron} / Node ${info.node} / Chromium ${info.chromium} / ${platformLabel(info.platform)} ${info.arch}`
    : `${APP_NAME}`;

  const onCopyVersion = async () => {
    try {
      await navigator.clipboard.writeText(versionText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable (sandbox); silently no-op.
    }
  };

  const openExternal = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onCheckForUpdates = async () => {
    setUpdateState({ kind: "checking" });
    try {
      const result: CheckForUpdatesResult = await api.app.checkForUpdates();
      if (result.status === "up-to-date") {
        setUpdateState({ kind: "up-to-date", version: result.version });
      } else if (result.status === "available") {
        setUpdateState({ kind: "available", version: result.version });
      } else {
        setUpdateState({ kind: "error", message: result.error });
      }
    } catch (err) {
      setUpdateState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onDownloadUpdate = async () => {
    setUpdateState({ kind: "downloading" });
    try {
      await api.app.downloadUpdate();
      // update-downloaded push event will move us to "downloaded".
    } catch (err) {
      setUpdateState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onQuitAndInstall = async () => {
    try {
      await api.app.quitAndInstall();
    } catch {
      // If install fails, the app is still running; leave the state as-is.
    }
  };

  const rows: { label: string; value: string }[] = [
    { label: "版本", value: info ? `v${info.appVersion}` : "-" },
    { label: "许可证", value: LICENSE },
    { label: "Electron", value: info?.electron ?? "-" },
    { label: "Node.js", value: info?.node ?? "-" },
    { label: "Chromium", value: info?.chromium ?? "-" },
    { label: "系统", value: info ? `${platformLabel(info.platform)} · ${info.arch}` : "-" },
  ];

  return (
    <section className="flex min-h-full flex-col items-center px-6 py-10">
      {/* App identity */}
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <div
          className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 text-accent"
          aria-hidden
        >
          <SiGithub size={32} />
        </div>
        <h2 className="text-lg font-semibold text-content">{APP_NAME}</h2>
        <p className="mt-1.5 text-[0.8571em] leading-relaxed text-content-subtle">
          {APP_DESC}
        </p>
        {info && (
          <p className="mt-1 text-[0.7857em] tabular-nums text-content-muted">
            v{info.appVersion}
          </p>
        )}
      </div>

      {/* Runtime info rows */}
      <div className="mt-8 w-full max-w-md divide-y divide-edge rounded-lg border border-edge">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 px-4 py-2.5"
          >
            <span className="text-[0.8571em] text-content-muted">{row.label}</span>
            <span className="text-[0.8571em] tabular-nums text-content">
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {/* Update status banner */}
      <UpdateBanner
        state={updateState}
        onDownload={onDownloadUpdate}
        onInstall={onQuitAndInstall}
      />

      {/* Action buttons */}
      <div className="mt-6 flex w-full max-w-md flex-wrap items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopyVersion}
          title="复制版本信息"
          className="gap-1.5"
        >
          {copied ? (
            <IconCheck size={14} className="text-accent" />
          ) : (
            <IconCopy size={14} />
          )}
          {copied ? "已复制" : "复制版本信息"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openExternal(REPO_URL)}
          title="在浏览器中打开 GitHub 仓库"
          className="gap-1.5"
        >
          <SiGithub size={14} />
          GitHub 仓库
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCheckForUpdates}
          disabled={updateState.kind === "checking" || updateState.kind === "downloading"}
          title="检查是否有新版本"
          className="gap-1.5"
        >
          {updateState.kind === "checking" ? (
            <IconRefresh size={14} className="animate-spin" />
          ) : (
            <IconExternalLink size={14} />
          )}
          {updateState.kind === "checking" ? "检查中…" : "检查更新"}
        </Button>
      </div>

      {/* Footer note */}
      <p className="mt-8 flex w-full max-w-md items-center justify-center gap-1.5 text-center text-[0.7143em] leading-relaxed text-content-subtle">
        <IconInfoCircle size={12} className="shrink-0" />
        <span>
          本应用为开源软件(MIT 许可证),仅作 Claude Code 的交互界面,不内嵌
          claude 二进制。Claude 是 Anthropic 的商标。
        </span>
      </p>
    </section>
  );
}

/** Compact banner showing the current update-flow state and the next action.
 *  Only renders when there's something to say (not idle/checking - those are
 *  reflected by the button itself). */
function UpdateBanner({
  state,
  onDownload,
  onInstall,
}: {
  state: UpdateState;
  onDownload: () => void;
  onInstall: () => void;
}) {
  if (state.kind === "idle" || state.kind === "checking") return null;

  let icon: React.ReactNode;
  let message: string;
  let action: { label: string; onClick: () => void; icon?: React.ReactNode } | null = null;
  let tone: "accent" | "muted" | "warning" = "muted";

  switch (state.kind) {
    case "up-to-date":
      icon = <IconCheck size={16} className="text-accent" />;
      message = `已是最新版本(v${state.version})`;
      break;
    case "available":
      icon = <IconDownload size={16} className="text-accent" />;
      message = `发现新版本 v${state.version}`;
      action = { label: "立即下载", onClick: onDownload, icon: <IconDownload size={14} /> };
      tone = "accent";
      break;
    case "downloading":
      icon = <IconRefresh size={16} className="animate-spin text-accent" />;
      message = "正在下载更新…";
      break;
    case "downloaded":
      icon = <IconRocket size={16} className="text-accent" />;
      message = `v${state.version} 已就绪,重启后安装`;
      action = { label: "重启安装", onClick: onInstall, icon: <IconRocket size={14} /> };
      tone = "accent";
      break;
    case "error":
      icon = <IconAlertTriangle size={16} className="text-warning" />;
      message = `更新检查失败:${state.message}`;
      tone = "warning";
      break;
  }

  return (
    <div
      className={cn(
        "mt-6 flex w-full max-w-md items-center justify-between gap-3 rounded-lg border px-4 py-3",
        tone === "accent" && "border-accent/30 bg-accent/5",
        tone === "muted" && "border-edge bg-surface",
        tone === "warning" && "border-warning/30 bg-warning/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0">{icon}</span>
        <span className="truncate text-[0.8571em] text-content">{message}</span>
      </div>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          onClick={action.onClick}
          className="shrink-0 gap-1.5"
        >
          {action.icon}
          {action.label}
        </Button>
      )}
    </div>
  );
}
