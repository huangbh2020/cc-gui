/**
 * Provider → icon+color mapping for session rows, tabs, and the title bar.
 *
 * The renderer never hardcodes a provider's brand icon in more than one
 * place: adding a new provider means adding one entry here, and every
 * surface (LeftBar rows, SessionTabs, Titlebar chip) picks it up.
 *
 * Icons: claude uses the Simple Icons brand mark (SiClaude); pi has no
 * brand mark in react-icons, so we use a Tabler terminal glyph (pi is a
 * terminal coding agent) in a purple tone.
 */
import type { ComponentType } from "react";
import { SiClaude, IconTerminal } from "@renderer/lib/icons.js";

export interface ProviderIconMeta {
  Icon: ComponentType<{ size?: number; className?: string }>;
  /** Tailwind text-color class (brand accent). */
  color: string;
}

/** Fallback for unknown provider ids (e.g. a persisted id whose provider
 *  wasn't registered) — a neutral message glyph. */
const FALLBACK: ProviderIconMeta = {
  Icon: IconTerminal,
  color: "text-content-subtle",
};

const PROVIDER_ICONS: Record<string, ProviderIconMeta> = {
  "claude-sdk": { Icon: SiClaude, color: "text-[#D97757]" },
  "pi-sdk": { Icon: IconTerminal, color: "text-[#7C3AED]" },
};

export function getProviderIcon(providerId: string | null | undefined): ProviderIconMeta {
  if (!providerId) return FALLBACK;
  return PROVIDER_ICONS[providerId] ?? FALLBACK;
}
