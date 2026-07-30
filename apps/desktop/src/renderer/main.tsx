import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
// KaTeX typography (fonts + layout) for math rendered by rehype-katex in
// Markdown.tsx. Without this, KaTeX emits correct HTML but no styling, so
// fractions/roots/superscripts collapse to unstyled text. Vite resolves the
// `url(fonts/*.woff2)` references inside this CSS automatically.
import "katex/dist/katex.min.css";
// JetBrains Mono Variable - bundled monospace face (woff2 with unicode-range
// subsetting + font-display:swap). Used as the default for all `font-mono`
// surfaces (code blocks, terminals, file trees, diffs) so they render with a
// modern, consistent face across platforms instead of falling back to the OS
// default (SF Mono / Consolas / Menlo). Bundling one variable woff2 per subset
// keeps the cost small (~200KB total). See tailwind.config.js + TerminalView.
import "@fontsource-variable/jetbrains-mono";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
