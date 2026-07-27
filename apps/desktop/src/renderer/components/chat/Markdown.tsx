import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconCopy } from "@renderer/lib/icons.js";
import type { Components } from "react-markdown";

/**
 * Render claude's markdown output (code blocks, lists, tables, emphasis). The
 * raw text was previously shown via whitespace-pre-wrap, which dropped all
 * structure — claude's answers are markdown-heavy, so this is the single
 * biggest readability win.
 *
 * Code blocks get a header (language + copy button) instead of full syntax
 * highlighting — keeps the bundle small; highlighting can be layered on later.
 */

/** Pull a plain-text string out of a React node tree (for the copy button). */
function extractText(node: unknown): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

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
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
        "text-content-subtle hover:bg-surface-hover/60 hover:text-content-muted",
      )}
      title="Copy code"
    >
      {copied ? (
        <><IconCheck size={10} /> copied</>
      ) : (
        <><IconCopy size={10} /> copy</>
      )}
    </button>
  );
}

const components: Components = {
  // Inline code only — fenced blocks are handled by `pre` below (cleaner than
  // sniffing inline/block inside `code`, and avoids double-wrapping).
  code({ className, children }) {
    const isInline = !/language-/.test(className || "");
    if (isInline) {
      return (
        <code className="rounded bg-surface-muted/80 px-1 py-0.5 font-mono text-[0.85em] text-accent">
          {children}
        </code>
      );
    }
    return <code className="font-mono">{children}</code>;
  },
  // Fenced code block: extract the raw text + language from the child <code>
  // element and render a container with a language label + copy button.
  pre({ children }) {
    // children is the <code> React element rendered above.
    const child = Array.isArray(children) ? children[0] : children;
    const childProps = (child as { props?: { className?: string; children?: ReactNode } })?.props;
    const className = childProps?.className ?? "";
    const match = /language-(\w+)/.exec(className);
    const lang = match?.[1] ?? "text";
    const raw = extractText(childProps?.children);
    return (
      <pre className="my-2 overflow-hidden rounded-lg border border-edge/60 bg-surface/80">
        <div className="flex items-center justify-between border-b border-edge/60 bg-surface-muted/40 px-2 py-0.5 text-[10px] text-content-subtle">
          <span className="font-mono">{lang}</span>
          <CopyButton text={raw.replace(/\n$/, "")} />
        </div>
        <code className="block overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-content">
          {childProps?.children}
        </code>
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
    return <blockquote className="my-2 border-l-2 border-edge pl-3 text-content-muted">{children}</blockquote>;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border border-edge bg-surface-muted/50 px-2 py-1 text-left font-semibold text-content-muted">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-edge px-2 py-1 text-content-muted">{children}</td>;
  },
  h1({ children }) {
    return <h1 className="mb-2 mt-3 text-base font-bold text-content">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-1.5 mt-3 text-sm font-bold text-content">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-1 mt-2 text-sm font-semibold text-content">{children}</h3>;
  },
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed text-content [&>p]:my-1.5 [&:first-child]:mt-0 [&:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
