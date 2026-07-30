import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { Button } from "@renderer/components/ui/index.js";
import {
  IconCopy,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  SiGithub,
} from "@renderer/lib/icons.js";
import type { AppInfoResult } from "@contracts/ipc";

/**
 * About panel - app identity, runtime info, license, and repo links.
 *
 * Pulls version + runtime info from the main process via the parameterless
 * `app.info` RPC (electron's `app.getVersion()` + `process.versions`). Shows a
 * copy-version button and external links to the GitHub repo / releases. Auto
 * update isn't implemented yet (P6), so "检查更新" just opens the releases page.
 */

/** App display name (matches the root package.json "name"). */
const APP_NAME = "my-claude-gui";
/** One-line description shown under the app name. */
const APP_DESC = "基于 Claude Agent SDK 构建的桌面端 GUI(Electron 三栏 IDE)";
/** GitHub repo URL. TODO: update to the real published repo URL. */
const REPO_URL = "https://github.com/huangbh/my-claude-gui";
/** Releases page (used by the "检查更新" button). */
const RELEASES_URL = `${REPO_URL}/releases`;
/** SPDX license identifier. */
const LICENSE = "MIT";

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

  // Fetch runtime info once on mount. Failures (e.g. main not ready) leave the
  // version rows showing "—" rather than crashing the panel.
  useEffect(() => {
    let cancelled = false;
    void api.app.info().then((result) => {
      if (!cancelled) setInfo(result);
    }).catch(() => {
      // leave info null -> rows render "—"
    });
    return () => {
      cancelled = true;
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

  const rows: { label: string; value: string }[] = [
    { label: "版本", value: info ? `v${info.appVersion}` : "—" },
    { label: "许可证", value: LICENSE },
    { label: "Electron", value: info?.electron ?? "—" },
    { label: "Node.js", value: info?.node ?? "—" },
    { label: "Chromium", value: info?.chromium ?? "—" },
    { label: "系统", value: info ? `${platformLabel(info.platform)} · ${info.arch}` : "—" },
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
          onClick={() => openExternal(RELEASES_URL)}
          title="在浏览器中打开 Releases 页面"
          className="gap-1.5"
        >
          <IconExternalLink size={14} />
          检查更新
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
