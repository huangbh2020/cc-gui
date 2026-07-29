import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
// KaTeX typography (fonts + layout) for math rendered by rehype-katex in
// Markdown.tsx. Without this, KaTeX emits correct HTML but no styling, so
// fractions/roots/superscripts collapse to unstyled text. Vite resolves the
// `url(fonts/*.woff2)` references inside this CSS automatically.
import "katex/dist/katex.min.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
