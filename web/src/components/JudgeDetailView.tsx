import React, { useMemo } from "react";
import { Badge } from "@/components/ui";
import { MarkdownView } from "@/components/MarkdownView";

interface TestpointRow {
  filename: string;
  size: string;
  result: string;
  memory: string;
  time: string;
}

interface ParsedTable {
  points: TestpointRow[];
  extraTextBefore: string;
  extraTextAfter: string;
  total: number;
  passed: number;
}

function parseTestpointTable(text: string): ParsedTable | null {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => {
    const lower = l.toLowerCase();
    return lower.includes("filename") && lower.includes("result");
  });

  if (headerIdx === -1 || headerIdx + 1 >= lines.length) return null;

  const headerLine = lines[headerIdx];
  const headerCols = headerLine.split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const colMap: Record<string, number> = {};
  headerCols.forEach((name, idx) => {
    colMap[name] = idx;
  });

  const fnIdx = colMap["filename"] ?? 0;
  const sizeIdx = colMap["size"] ?? 1;
  const resIdx = colMap["result"] ?? 2;
  const memIdx = colMap["memory"] ?? 3;
  const timeIdx = colMap["time"] ?? 4;

  const points: TestpointRow[] = [];
  let tableEndIdx = headerIdx + 1;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.includes("--|--") || line.startsWith("|--") || line.replace(/[-|\s]/g, "") === "") {
      tableEndIdx = i + 1;
      continue;
    }
    const parts = line.split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      points.push({
        filename: parts[fnIdx] || parts[0] || "",
        size: parts[sizeIdx] || parts[1] || "-",
        result: (parts[resIdx] || parts[2] || "").toUpperCase(),
        memory: parts[memIdx] || parts[3] || "-",
        time: parts[timeIdx] || parts[4] || "-",
      });
      tableEndIdx = i + 1;
    } else {
      break;
    }
  }

  if (points.length === 0) return null;

  const extraTextBefore = lines.slice(0, headerIdx).join("\n").trim();
  const extraTextAfter = lines.slice(tableEndIdx).join("\n").trim();
  const passed = points.filter((p) => p.result === "AC" || p.result === "ACCEPTED").length;

  return {
    points,
    extraTextBefore,
    extraTextAfter,
    total: points.length,
    passed,
  };
}

function getResultBadge(result: string) {
  const r = result.toUpperCase();
  if (r === "AC" || r === "ACCEPTED") {
    return <Badge tone="ok">AC 通过</Badge>;
  }
  if (r === "WA" || r === "WRONG_ANSWER") {
    return <Badge tone="danger">WA 答案错误</Badge>;
  }
  if (r === "TLE" || r === "TIME_LIMIT_EXCEEDED") {
    return <Badge tone="warn">TLE 运行超时</Badge>;
  }
  if (r === "MLE" || r === "MEMORY_LIMIT_EXCEEDED") {
    return <Badge tone="warn">MLE 内存超限</Badge>;
  }
  if (r === "RE" || r === "RUNTIME_ERROR") {
    return <Badge tone="danger">RE 运行崩溃</Badge>;
  }
  if (r === "OLE" || r === "OUTPUT_LIMIT_EXCEEDED") {
    return <Badge tone="danger">OLE 输出超限</Badge>;
  }
  if (r === "PE" || r === "PRESENTATION_ERROR") {
    return <Badge tone="warn">PE 格式错误</Badge>;
  }
  return <Badge tone="neutral">{result}</Badge>;
}

export function JudgeDetailView({
  error,
  className,
}: {
  error: any;
  className?: string;
}) {
  const rawText = useMemo(() => {
    if (!error) return "";
    if (typeof error === "string") return error.trim();
    if (typeof error === "object") {
      if (typeof error.error === "string") return error.error.trim();
      return JSON.stringify(error, null, 2);
    }
    return String(error).trim();
  }, [error]);

  const parsed = useMemo(() => {
    if (!rawText) return null;
    return parseTestpointTable(rawText);
  }, [rawText]);

  if (!rawText) return null;

  // 1. If it's a testpoint table
  if (parsed) {
    const isAllPassed = parsed.passed === parsed.total;
    return (
      <div className={`space-y-3 ${className || ""}`}>
        {parsed.extraTextBefore && (
          <MarkdownView content={parsed.extraTextBefore} />
        )}

        <div className="rounded-control border border-line bg-surface overflow-hidden shadow-xs">
          <div className="flex items-center justify-between border-b border-line bg-surface-muted px-3.5 py-2 text-xs">
            <div className="flex items-center gap-2 font-semibold text-fg">
              <span>节点测试点评测详情</span>
              <span className="font-mono text-fg-muted font-normal">
                ({parsed.points.length} 个测试点)
              </span>
            </div>
            <div>
              <Badge tone={isAllPassed ? "ok" : "warn"}>
                通过 {parsed.passed} / {parsed.total}
              </Badge>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-line bg-surface-muted/50 text-meta text-fg-muted">
                  <th className="py-2 px-3 font-semibold">序号 / 节点</th>
                  <th className="py-2 px-3 font-semibold">评测判定</th>
                  <th className="py-2 px-3 font-semibold">耗时</th>
                  <th className="py-2 px-3 font-semibold">内存</th>
                  <th className="py-2 px-3 font-semibold">输入大小</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {parsed.points.map((p, idx) => (
                  <tr key={idx} className="hover:bg-surface-muted/40 transition">
                    <td className="py-2 px-3 font-mono text-fg font-medium">
                      #{idx + 1} <span className="text-fg-muted ml-1 font-normal">({p.filename})</span>
                    </td>
                    <td className="py-2 px-3">{getResultBadge(p.result)}</td>
                    <td className="py-2 px-3 font-mono text-fg-muted">{p.time}</td>
                    <td className="py-2 px-3 font-mono text-fg-muted">{p.memory}</td>
                    <td className="py-2 px-3 font-mono text-fg-muted">
                      {p.size} {p.size !== "-" && !p.size.toLowerCase().endsWith("b") ? "B" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {parsed.extraTextAfter && (
          <MarkdownView content={parsed.extraTextAfter} />
        )}
      </div>
    );
  }

  // 2. If it contains generic markdown tables or headers
  if (rawText.includes("|--|") || rawText.includes("###") || rawText.includes("```")) {
    return (
      <div className={`rounded-control border border-line bg-surface p-3.5 ${className || ""}`}>
        <MarkdownView content={rawText} />
      </div>
    );
  }

  // 3. If it's a compiler error or raw terminal diagnostics
  return (
    <div className={`rounded-control border border-line bg-surface-muted p-3 space-y-2 ${className || ""}`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-danger">
        <span>编译 / 运行错误信息</span>
      </div>
      <pre className="overflow-x-auto text-xs font-mono text-fg whitespace-pre-wrap leading-relaxed bg-surface p-2.5 rounded border border-line">
        {rawText}
      </pre>
    </div>
  );
}
