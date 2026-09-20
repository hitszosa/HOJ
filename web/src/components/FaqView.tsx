"use client";

import { useEffect, useState } from "react";
import { Badge, Card, CardTitle, Empty } from "@/components/ui";
import { api } from "@/lib/api";

type Row = Record<string, any>;

function getVerdictTone(code: string): "ok" | "warn" | "danger" | "brand" | "neutral" {
  if (code === "AC") return "ok";
  if (["WA", "TLE", "MLE", "OLE"].includes(code)) return "warn";
  if (["RE", "CE"].includes(code)) return "danger";
  if (["PE"].includes(code)) return "neutral";
  return "brand";
}

export function FaqView() {
  const [data, setData] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api("/faq")
      .then((res) => {
        if (active) setData(res);
      })
      .catch((e) => {
        if (active) setError(String(e).split("|").pop() || "加载 FAQ 失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return <p className="py-20 text-center text-fg-muted">正在加载帮助与技术规范…</p>;
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Empty title={error || "加载失败"} hint="请稍后刷新重试。" />
      </div>
    );
  }

  const compilers: Row[] = data.compilers || [];
  const verdicts: Row[] = data.verdicts || [];
  const tips: Row[] = data.ioTips || data.tips || [];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">HELP & SPECIFICATIONS</p>
          <h1 className="text-3xl font-semibold tracking-tight">常见问答与技术规范 (FAQ)</h1>
          <p className="mt-2 text-fg-muted">
            全面掌握评测沙箱环境规范、编译器版本与编译选项、判题状态码说明以及常见输入输出避坑要点。
          </p>
        </div>
      </header>

      {/* 1. Verdicts Explanation */}
      <Card>
        <CardTitle
          title="判题状态码与结果说明"
          meta="系统对每个测试用例进行沙箱测试并比对标准输出，汇总产生最终评测状态："
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mt-4">
          {verdicts.map((v: Row) => (
            <div
              key={v.code}
              className="rounded-control border border-line bg-surface-muted p-4 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono font-bold text-fg text-title">{v.code}</span>
                  <Badge tone={getVerdictTone(v.code)}>{v.name || v.label}</Badge>
                </div>
                <p className="text-meta text-fg-muted leading-relaxed">{v.desc || v.description}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* 2. Compiler Specs */}
      <Card>
        <CardTitle
          title="支持语言与编译器环境"
          meta="后台评测机在 Linux 沙箱容器中运行，各语言编译器版本与编译参数如下："
        />
        <div className="grid gap-4 md:grid-cols-2 mt-4">
          {compilers.map((c: Row) => (
            <div
              key={c.lang || c.language}
              className="rounded-control border border-line bg-surface-raised p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-fg text-title">{c.lang || c.language}</span>
                <Badge tone="brand">{c.compiler || c.version}</Badge>
              </div>
              <div className="flex flex-wrap gap-2 text-meta text-fg-muted">
                {c.timeLimit && <span>基准时限: {c.timeLimit}</span>}
                {c.timeLimit && c.memoryLimit && <span>·</span>}
                {c.memoryLimit && <span>内存上限: {c.memoryLimit}</span>}
              </div>
              <div>
                <span className="text-meta text-fg-subtle block mb-1">编译/执行命令：</span>
                <pre className="overflow-x-auto rounded-control border border-line bg-surface-muted p-2 font-mono text-meta text-fg">
                  {c.command}
                </pre>
              </div>
              {c.notes && <p className="text-meta text-fg-muted leading-relaxed">{c.notes}</p>}
            </div>
          ))}
        </div>
      </Card>

      {/* 3. Common I/O Tips */}
      <Card>
        <CardTitle
          title="做题避坑指南与标准输入输出规范"
          meta="避免非逻辑错误导致的 WA / PE / RE，请遵循以下程序设计规范："
        />
        <div className="divide-y divide-line mt-4">
          {tips.map((t: Row, idx: number) => (
            <div key={idx} className="py-4 first:pt-0 last:pb-0">
              <h3 className="font-semibold text-fg mb-1">
                {idx + 1}. {t.title}
              </h3>
              <p className="text-meta text-fg-muted leading-relaxed">{t.desc || t.content}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
