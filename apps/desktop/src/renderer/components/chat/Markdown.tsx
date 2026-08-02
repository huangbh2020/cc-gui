/**
 * Markdown rendering with syntax highlighting (Shiki + codeDiffs),
 * KaTeX math, and code-block output caching (FNV-1a + LRU).
 *
 * Performance layering:
 *  - react-markdown for the base markdown→React pipeline.
 *  - remark-math + rehype-katex for LaTeX math ($...$ / $$...$$).
 *  - Shiki for fenced-code-block highlighting (+ diff annotations via
 *    transformerNotationDiff).
 *  - code-html cache (fnv1a hash → shiki HTML) to avoid re-highlighting.
 *  - useDeferredValue is applied at the MessageBlocks layer, not here.
 *
 * Security: react-markdown escapes raw HTML by default, so we never need
 * DOMPurify. The only `dangerouslySetInnerHTML` usage is for shiki-generated
 * code-block HTML, which is produced from known content (the code text) and
 * is thus safe by construction.
 */
import { memo, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconCopy } from "@renderer/lib/icons.js";
import type { Components } from "react-markdown";
import { codeCacheKey, getCodeHtml, setCodeHtml } from "@renderer/lib/markdownCache.js";

// ── Lazy highlighter singleton ────────────────────────────────────────
// Initialised on first encounter of a fenced code block; kept alive for the
// lifetime of the page. Dual-theme (light / dark) resolved via CSS class.
import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from "shiki";
import { transformerNotationDiff } from "@shikijs/transformers";

type ShikiHighlighter = Highlighter;

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
let highlighterInstance: ShikiHighlighter | null = null;

/** Languages we bundle eagerly (the ones Claude uses most). */
const EAGER_LANGS: BundledLanguage[] = [
  "typescript", "javascript", "jsx", "tsx",
  "python", "bash", "shell",
  "json", "markdown", "md", "yaml", "yml",
  "html", "css", "scss", "less", "sql", "xml", "diff",
  "vue", "svelte",
  "rust", "go", "java", "c", "cpp", "csharp",
  "ruby", "php", "swift", "kotlin",
  "docker", "dockerfile",
  "graphql", "gql",
  "ini", "toml", "makefile",
];

/**
 * Map common language aliases used in markdown fences to canonical Shiki
 * language ids. When a `resolveLang` falls back to "text" the code block
 * is rendered as plain monospace (no highlighting) instead of crashing.
 */
const LANG_ALIAS: Record<string, string> = {
  sh: "shell", zsh: "shell", fish: "shell",
  powershell: "shell", ps: "shell", cmd: "shell", dos: "shell", batch: "shell",
  mjs: "javascript", cjs: "javascript", es: "javascript", es6: "javascript",
  ts: "typescript",
  py: "python",
  mdx: "markdown",
  jsonc: "json", json5: "json",
  yml: "yaml",
  scss: "css", less: "css", sass: "css", stylus: "css",
  cc: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp",
  h: "c",
  containerfile: "dockerfile",
};

/** Resolve a markdown code-fence language tag to a Shiki language id.
 *  Falls back to "text" when the language is unknown, effectively disabling
 *  highlighting for that block. */
function resolveLang(tag: string): string {
  if (!tag || tag === "text" || tag === "none" || tag === "plain") return "text";
  if (EAGER_LANGS.includes(tag as BundledLanguage)) return tag;
  return LANG_ALIAS[tag] ?? "text";
}

function ensureHighlighter(): Promise<ShikiHighlighter> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = createHighlighter({
    // github-dark-default (#0d1117 bg) matches the app's deep dark surface
    // better than github-dark (#24292e), so code blocks blend into the
    // stream instead of punching out as a brighter island. Its token
    // palette is also brighter/more saturated, improving legibility.
    themes: ["github-light", "github-dark-default"],
    langs: EAGER_LANGS,
  }).then((hl) => {
    highlighterInstance = hl;
    return hl;
  });
  return highlighterPromise;
}

function currentTheme(): BundledTheme {
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("dark") ? "github-dark-default" : "github-light";
  }
  return "github-dark-default";
}

// ── Helpers ───────────────────────────────────────────────────────────

function extractText(node: unknown): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

function extractLanguage(className?: string): string {
  const match = /language-(\w+)/.exec(className ?? "");
  return match?.[1] ?? "text";
}

function isFencedCode(className?: string): boolean {
  return /language-\w+/.test(className ?? "");
}

/** Minimal HTML entity escaping for the safe fallback path. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Copy button ───────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
        "text-content-subtle hover:bg-surface-hover/60 hover:text-content-muted",
      )}
      title="Copy code"
    >
      {copied ? (<><IconCheck size={10} /> copied</>) : (<><IconCopy size={10} /> copy</>)}
    </button>
  );
}

// ── react-markdown component overrides ────────────────────────────────

const components: Components = {
  // Inline code — styled inline, no highlighting needed.
  code({ className, children }) {
    const isInline = !isFencedCode(className);
    if (isInline) {
      return (
        <code className="rounded bg-surface-muted/80 px-1 py-0.5 font-mono [font-size:var(--chat-fs-xs)] text-content">
          {children}
        </code>
      );
    }
    return <code className="font-mono">{children}</code>;
  },

  // Fenced code block: highlighted via shiki with copy button + lang label.
  // Falls back to plain code when highlighting fails (unknown language etc.).
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const childProps = (child as { props?: { className?: string; children?: unknown } })?.props;
    const className = childProps?.className ?? "";
    const rawCode = extractText(childProps?.children);
    const lang = resolveLang(extractLanguage(className));

    // Lazy-init highlighter on first encounter of a fenced block.
    const [ready, setReady] = useState(!!highlighterInstance);
    useMemo(() => {
      if (!highlighterInstance) {
        ensureHighlighter().then(() => setReady(true));
      }
    }, []);

    const html = useMemo(() => {
      if (!rawCode) return null;

      // Theme is part of the cache key so a theme switch (light↔dark, or a
      // theme-name change) invalidates stale HTML and re-highlights instead
      // of serving the wrong palette.
      const theme = currentTheme();
      const key = codeCacheKey(rawCode, lang, theme);
      // Cache hit?
      const cached = getCodeHtml(key);
      if (cached) return { __html: cached, key };

      // Highlighter ready?
      if (highlighterInstance) {
        // Helper: attempt highlighting with a given language, returning null
        // on any error instead of throwing.
        const tryHighlight = (tryLang: string): string | null => {
          try {
            return highlighterInstance!.codeToHtml(rawCode, {
              lang: tryLang,
              theme,
              transformers: [transformerNotationDiff()],
            });
          } catch {
            return null; // Language not found or other error — caller handles.
          }
        };

        // First attempt: requested language.
        let highlighted = tryHighlight(lang);
        // Fallback: "text" (always available, plain monospace).
        if (!highlighted && lang !== "text") {
          highlighted = tryHighlight("text");
        }
        if (highlighted) {
          setCodeHtml(key, highlighted);
          return { __html: highlighted, key };
        }
        // Both attempts failed — cache a safe placeholder.
        setCodeHtml(key, `<pre class="shiki fallback"><code>${escapeHtml(rawCode)}</code></pre>`);
      }

      return null; // Not ready yet or highlight failed — show raw text.
    }, [rawCode, lang, ready]);

    return (
      <pre className="my-2 overflow-hidden rounded-lg border border-edge/60 bg-surface/80">
        <div className="flex items-center justify-between border-b border-edge/60 bg-surface-muted/40 px-2 py-0.5 text-content-subtle [font-size:var(--chat-fs-xxs)]">
          <span className="font-mono">{lang}</span>
          <CopyButton text={rawCode.replace(/\n$/, "")} />
        </div>
        {html ? (
          <div className="overflow-x-auto px-3 py-2 [font-size:var(--chat-fs-xs)]" dangerouslySetInnerHTML={html} />
        ) : (
          <code className="block overflow-x-auto px-3 py-2 font-mono leading-relaxed text-content [font-size:var(--chat-fs-xs)]">
            {childProps?.children as React.ReactNode}
          </code>
        )}
      </pre>
    );
  },

  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-info underline hover:text-info">
        {children}
      </a>
    );
  },
  ul({ children }) {
    return <ul className="my-1.5 list-disc space-y-1 pl-5 marker:text-content-subtle">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-1.5 list-decimal space-y-1 pl-5 marker:text-content-subtle">{children}</ol>;
  },
  blockquote({ children }) {
    return <blockquote className="my-2 border-l-2 border-edge pl-3 text-content">{children}</blockquote>;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse [font-size:var(--chat-fs-sm)]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border border-edge bg-surface-muted/50 px-2 py-1 text-left font-semibold text-content">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-edge px-2 py-1 text-content">{children}</td>;
  },
  h1({ children }) {
    return <h1 className="mb-2 mt-3 font-bold text-content [font-size:var(--chat-fs-lg)]">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-1.5 mt-3 font-bold text-content [font-size:var(--chat-font-size)]">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-1 mt-2 font-semibold text-content [font-size:var(--chat-font-size)]">{children}</h3>;
  },
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div
      className="text-content [font-size:var(--chat-font-size)] [line-height:var(--chat-line-height)] [font-weight:var(--chat-font-weight)] [&>p]:my-1.5 [&:first-child]:mt-0 [&:last-child]:mb-0"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
