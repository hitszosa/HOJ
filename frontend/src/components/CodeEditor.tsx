"use client";

import { useEffect, useRef, useState } from "react";

declare global { interface Window { ace?: any } }
let loader: Promise<any> | undefined;
function loadAce() {
  if (window.ace) return Promise.resolve(window.ace);
  if (!loader) loader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/oj/ace/ace.js";
    script.async = true;
    script.onload = () => window.ace ? resolve(window.ace) : reject(new Error("编辑器未能加载"));
    script.onerror = () => { script.remove(); loader = undefined; reject(new Error("编辑器未能加载")); };
    document.head.appendChild(script);
  });
  return loader;
}

const modes: Record<string, string> = { python: "python", c: "c_cpp", cpp: "c_cpp", java: "java" };
const filenames: Record<string, string> = { python: "main.py", c: "main.c", cpp: "main.cpp", java: "Main.java" };

export function CodeEditor({ value, language, onChange, readOnly = false, className }: {
  value: string; language: string; onChange: (code: string) => void; readOnly?: boolean; className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<any>(null);
  const current = useRef({ value, language, onChange, readOnly });
  current.current = { value, language, onChange, readOnly };
  const [state, setState] = useState<"loading" | "ready" | "fallback">("loading");

  useEffect(() => {
    let active = true;
    let ro: ResizeObserver | null = null;
    loadAce().then(ace => {
      if (!active || !host.current) return;
      ace.config.set("basePath", "/oj/ace");
      const instance = ace.edit(host.current);
      editor.current = instance;
      instance.setTheme("ace/theme/xcode");
      instance.session.setUseWorker(false);
      instance.session.setUseWrapMode(false);
      instance.session.setTabSize(4);
      instance.session.setUseSoftTabs(true);
      instance.setOptions({ fontSize: 14, showPrintMargin: false, highlightActiveLine: true, showLineNumbers: true });
      instance.session.setMode(`ace/mode/${modes[current.current.language] || "text"}`);
      instance.setReadOnly(current.current.readOnly);
      instance.setValue(current.current.value, -1);
      instance.session.on("change", () => current.current.onChange(instance.getValue()));
      instance.textInput.getElement().setAttribute("aria-label", "代码编辑器");
      if (typeof ResizeObserver !== "undefined" && host.current) {
        ro = new ResizeObserver(() => {
          instance.resize();
        });
        ro.observe(host.current);
      }
      setState("ready");
    }).catch(() => { if (active) setState("fallback"); });
    return () => {
      active = false;
      ro?.disconnect();
      editor.current?.destroy();
      editor.current = null;
    };
  }, []);
  useEffect(() => { if (editor.current && editor.current.getValue() !== value) editor.current.setValue(value, -1); }, [value]);
  useEffect(() => { editor.current?.session.setMode(`ace/mode/${modes[language] || "text"}`); }, [language]);
  useEffect(() => { editor.current?.setReadOnly(readOnly); }, [readOnly]);

  return <div className={`code-frame ${className || ""}`}>
    <div className="code-toolbar shrink-0"><span className="font-mono">{filenames[language] || "source"}</span><span>{readOnly ? "只读" : "UTF-8 · 4 空格缩进"}</span></div>
    {state === "loading" && <p role="status" className="px-3 py-2 text-meta text-fg-muted">正在加载代码编辑器…</p>}
    <div ref={host} className={`code-editor ${state === "fallback" ? "hidden" : ""}`} />
    {state === "fallback" && <div className="flex-1 flex flex-col"><p className="border-b border-line px-3 py-2 text-meta text-fg-muted shrink-0">编辑器资源暂不可用，已切换到文本输入。</p><textarea
      aria-label="代码编辑器" spellCheck={false} readOnly={readOnly} value={value}
      className="code-fallback flex-1 min-h-[320px]" onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        if (event.key !== "Tab" || readOnly) return;
        event.preventDefault();
        const target = event.currentTarget, start = target.selectionStart, end = target.selectionEnd;
        onChange(value.slice(0, start) + "    " + value.slice(end));
        requestAnimationFrame(() => target.setSelectionRange(start + 4, start + 4));
      }} /></div>}
    <div className="code-status shrink-0"><span>{value.split("\n").length} 行</span><span>{readOnly ? "历史代码" : "草稿自动保存在本机"}</span></div>
  </div>;
}
