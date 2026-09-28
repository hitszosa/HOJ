import React, { useMemo } from "react";
import { Marked } from "marked";
import katex from "katex";
import clsx from "clsx";

/**
 * KaTeX extension for marked parser.
 * Supports:
 * - Block math: $$ ... $$ and \[ ... \]
 * - Inline math: $ ... $ and \( ... \)
 */
const mathExtension = {
  name: "math",
  level: "inline" as const,
  start(src: string) {
    const match = src.match(/(?<!\\)(?:\$\$|\$|\\\[|\\\()/);
    return match ? match.index : -1;
  },
  tokenizer(src: string) {
    // 1. Block math: $$...$$ or \[...\]
    const blockRule1 = /^\$\$([\s\S]+?)\$\$/;
    const blockRule2 = /^\\\[([\s\S]+?)\\\]/;
    const blockMatch = blockRule1.exec(src) || blockRule2.exec(src);
    if (blockMatch) {
      return {
        type: "math",
        raw: blockMatch[0],
        text: blockMatch[1].trim(),
        display: true,
      };
    }

    // 2. Inline math: $...$ or \(...\)
    const inlineRule1 = /^\$([^\$\n]+?)\$/;
    const inlineRule2 = /^\\\(([\s\S]+?)\\\)/;
    const inlineMatch = inlineRule1.exec(src) || inlineRule2.exec(src);
    if (inlineMatch) {
      return {
        type: "math",
        raw: inlineMatch[0],
        text: inlineMatch[1].trim(),
        display: false,
      };
    }
  },
  renderer(token: { text: string; raw: string; display?: boolean }) {
    try {
      return katex.renderToString(token.text, {
        displayMode: Boolean(token.display),
        throwOnError: false,
      });
    } catch {
      return token.raw;
    }
  },
};

const markedInstance = new Marked({
  gfm: true,
  breaks: true,
});
markedInstance.use({ extensions: [mathExtension] });

interface MarkdownViewProps {
  content?: string | null;
  className?: string;
  placeholder?: string;
}

function normalizeMarkdown(text: string): string {
  let res = text;
  // 1. If string contains literal escaped '\n' without real newlines, unescape it
  if (res.includes("\\n") && !res.includes("\n")) {
    res = res.replace(/\\n/g, "\n");
  }
  // 2. Unify CRLF to LF
  res = res.replace(/\r\n/g, "\n");
  // 3. Ensure ATX headers like ### have preceding newlines if glued to text
  res = res.replace(/([^#\n])\s*(#{1,6}\s+)/g, "$1\n\n$2");
  return res;
}

export function MarkdownView({
  content,
  className,
  placeholder = "暂无详细描述",
}: MarkdownViewProps) {
  const html = useMemo(() => {
    const raw = normalizeMarkdown((content || "").trim());
    if (!raw) return "";
    try {
      return markedInstance.parse(raw) as string;
    } catch {
      return raw;
    }
  }, [content]);

  if (!html) {
    return (
      <div className={clsx("text-fg-muted italic text-sm", className)}>
        {placeholder}
      </div>
    );
  }

  return (
    <div
      className={clsx("markdown-body", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
