# my-claude-gui

A desktop GUI for [Claude Code](https://code.claude.com/) — a three-pane IDE built on top of the `claude` CLI's stream-json protocol. Claude Code is a black-box process; this app provides the interaction surface: session management, real-time rendering, tool approvals, and IDE affordances (files, git, terminal, browser preview).

> **Architecture inspired by [Synara](https://github.com/Emanuele-web04/synara)** — a multi-provider agent harness. This project reuses its layered design (provider adapter, normalized runtime events, IPC boundary) but is written in plain TypeScript (no effect-ts, no bun) and targets a single provider (claude).

## Status

🚧 **P0 — scaffold** (in progress). See the roadmap below.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ TopBar: [project ▼] [model] [⚡Plan] [⚙]                       │
├──────────┬───────────────────────────┬───────────────────────┤
│ LeftBar  │  ChatPane                 │  RightPanel           │
│ sessions │  message stream           │  [files][git][term][web]│
│ tasks    │  tool cards / approvals   │  tab body             │
│          │  input box                │                       │
├──────────┴───────────────────────────┴───────────────────────┤
│ StatusBar: claude version · tokens · status                   │
└──────────────────────────────────────────────────────────────┘
```

## Architecture

Three Electron processes:

- **Renderer** (React 19 + Vite) — UI only, `contextIsolation: true`, `nodeIntegration: false`.
- **Preload** — `contextBridge` exposes a typed, whitelisted `window.api`. The only bridge into Node.
- **Main** (Node.js) — owns the `ClaudeRuntime` (spawns `claude.exe`, parses stream-json), `SessionManager` (SQLite), and IDE services (terminal, git, checkpoints).

Provider integration lives behind a `ProviderAdapter` interface; today only `ClaudeAdapter` exists.

## Requirements

- Node.js ≥ 20
- pnpm ≥ 9 (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Claude Code CLI installed on your system** — this app does **not** bundle `claude.exe`. Install it separately (`npm i -g @anthropic-ai/claude-code` or the native installer).

## Getting started

```bash
pnpm install
pnpm dev
```

## Roadmap

| Phase | Goal |
|-------|------|
| P0 | Scaffold: three processes, three-pane layout, IPC contract |
| P1 | Minimal usable: spawn claude + stream-json + live chat |
| P2 | Sessions: projects, session list, SQLite, --resume |
| P3 | Tool approvals: cards, inline approval bar, permission modes |
| P4 | IDE right panel: file tree, git, terminal |
| P5 | Polish: Monaco diff, browser preview, checkpoints, Cmd+K |
| P6 | Release: packaging, auto-update, docs, CI |

## License

MIT. This project does not redistribute `claude.exe` — it only invokes the user's own Claude Code installation.
