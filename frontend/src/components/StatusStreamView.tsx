"use client";

import { useEffect, useState, useCallback } from "react";
import { Badge, Button, Card, CardTitle, Empty } from "@/components/ui";
import { api } from "@/lib/api";

type Row = Record<string, any>;

const fieldClass =
  "w-full rounded-control border border-line bg-surface px-3 py-2 text-body text-fg focus:outline-none focus:ring-2 focus:ring-brand";

function getVerdictTone(result: number): "ok" | "warn" | "danger" | "brand" | "neutral" {
  if (result === 4) return "ok";
  if ([0, 1, 2, 3, 14].includes(result)) return "brand";
  if ([10, 11].includes(result)) return "danger";
  if ([5, 6, 7, 8, 9].includes(result)) return "warn";
  return "neutral";
}

export function StatusStreamView({ portal, user }: { portal: string; user: string }) {
  const [submissions, setSubmissions] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 20;

  // Filters
  const [problemId, setProblemId] = useState("");
  const [filterUser, setFilterUser] = useState("");
  const [language, setLanguage] = useState("");
  const [verdict, setVerdict] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [offeringId, setOfferingId] = useState("");
  const [offerings, setOfferings] = useState<Row[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Code inspection drawer/modal
  const [activeSid, setActiveSid] = useState<number | null>(null);
  const [codeDetail, setCodeDetail] = useState<Row | null>(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [copied, setCopied] = useState(false);

  // Load teacher offerings for class filter
  useEffect(() => {
    if (portal === "teacher") {
      api("/courses")
        .then((data: Row[]) => {
          setOfferings(data.filter((r) => ["teacher", "ta"].includes(r.role)));
        })
        .catch(() => {});
    }
  }, [portal]);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(limit));
      params.set("limit", String(limit));
      if (problemId.trim()) params.set("problemId", problemId.trim());
      if (filterUser.trim()) params.set("userId", filterUser.trim());
      if (language) params.set("language", language);
      if (verdict) params.set("result", verdict);
      if (portal === "teacher" && offeringId) params.set("offeringId", offeringId);
      if (portal === "student" && onlyMine) params.set("onlyMine", "true");

      const res = await api(`/status?${params.toString()}`);
      setSubmissions(res.items || res.submissions || []);
      setTotal(res.total || 0);
    } catch (e) {
      setError(String(e).split("|").pop() || "加载提交队列失败");
    } finally {
      setLoading(false);
    }
  }, [page, limit, problemId, filterUser, language, verdict, offeringId, onlyMine, portal]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Auto refresh stream every 6 seconds if enabled
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      loadStatus();
    }, 6000);
    return () => clearInterval(timer);
  }, [autoRefresh, loadStatus]);

  const openCodeModal = async (sid: number) => {
    setActiveSid(sid);
    setCodeDetail(null);
    setCodeError("");
    setCodeLoading(true);
    setCopied(false);
    try {
      const res = await api(`/submissions/${sid}/code`);
      setCodeDetail(res);
    } catch (e) {
      setCodeError(String(e).split("|").pop() || "读取源码失败或无查看权限");
    } finally {
      setCodeLoading(false);
    }
  };

  const closeCodeModal = () => {
    setActiveSid(null);
    setCodeDetail(null);
    setCodeError("");
  };

  const handleCopyCode = () => {
    if (!codeDetail?.code) return;
    navigator.clipboard.writeText(codeDetail.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">REAL-TIME JUDGE STREAM</p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {portal === "teacher" ? "教学班评测流水与代码质检" : "实时评测状态"}
          </h1>
          <p className="mt-2 text-fg-muted">
            {portal === "teacher"
              ? "实时监控学生代码提交、判题结果与查重相似度，支持直接调阅源码与报错诊断。"
              : "全站实时提交流与个人判题队列，点击可查看自己的完整代码与编译诊断日志。"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-meta text-fg-muted cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded-control"
            />
            实时轮询刷新
          </label>
          <Button variant="secondary" onClick={loadStatus} disabled={loading}>
            {loading ? "刷新中…" : "手动刷新"}
          </Button>
        </div>
      </header>

      {/* Filter toolbar */}
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 items-end">
          <div>
            <label className="block text-meta text-fg-muted mb-1">题目编号</label>
            <input
              type="text"
              placeholder="例: 1000"
              className={fieldClass}
              value={problemId}
              onChange={(e) => {
                setProblemId(e.target.value);
                setPage(1);
              }}
            />
          </div>

          {portal === "teacher" ? (
            <>
              <div>
                <label className="block text-meta text-fg-muted mb-1">授课班级</label>
                <select
                  className={fieldClass}
                  value={offeringId}
                  onChange={(e) => {
                    setOfferingId(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">全部授课班级</option>
                  {offerings.map((o) => (
                    <option key={o.offering_id} value={o.offering_id}>
                      {o.title} ({o.term})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-meta text-fg-muted mb-1">学生学号/用户名</label>
                <input
                  type="text"
                  placeholder="检索学生账号"
                  className={fieldClass}
                  value={filterUser}
                  onChange={(e) => {
                    setFilterUser(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-meta text-fg-muted mb-1">筛选范围</label>
              <label className="flex items-center gap-2 h-10 px-3 rounded-control border border-line bg-surface cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyMine}
                  onChange={(e) => {
                    setOnlyMine(e.target.checked);
                    setPage(1);
                  }}
                />
                <span className="text-body text-fg">仅看我的提交</span>
              </label>
            </div>
          )}

          <div>
            <label className="block text-meta text-fg-muted mb-1">编程语言</label>
            <select
              className={fieldClass}
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部语言</option>
              <option value="0">C</option>
              <option value="1">C++</option>
              <option value="3">Java</option>
              <option value="6">Python</option>
            </select>
          </div>

          <div>
            <label className="block text-meta text-fg-muted mb-1">评测结果</label>
            <select
              className={fieldClass}
              value={verdict}
              onChange={(e) => {
                setVerdict(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              <option value="4">正确 (AC)</option>
              <option value="6">答案错误 (WA)</option>
              <option value="7">时间超限 (TLE)</option>
              <option value="8">内存超限 (MLE)</option>
              <option value="10">运行错误 (RE)</option>
              <option value="11">编译错误 (CE)</option>
              <option value="5">格式错误 (PE)</option>
              <option value="9">输出超限 (OLE)</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Submissions Table */}
      <Card>
        <CardTitle
          title={`提交列表 (${total} 条记录)`}
          meta={`第 ${page} / ${totalPages} 页`}
        />

        {error ? (
          <div className="py-4 text-center text-danger">{error}</div>
        ) : submissions.length === 0 ? (
          <Empty title="暂无符合条件的提交记录" hint="提交代码后将实时显示在此列表中。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left zebra">
              <thead>
                <tr>
                  <th className="py-3">运行 ID</th>
                  <th>提交者</th>
                  <th>题目</th>
                  <th>评测状态</th>
                  <th>耗时</th>
                  <th>内存</th>
                  <th>语言</th>
                  <th>代码长</th>
                  <th>提交时间</th>
                  {portal === "teacher" && <th>查重</th>}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.solutionId} className="border-t border-line">
                    <td className="py-3 font-mono text-meta text-fg-muted">#{s.solutionId}</td>
                    <td>
                      <div className="font-medium text-fg">{s.nick || s.userId}</div>
                      {s.nick && s.nick !== s.userId && (
                        <div className="text-meta text-fg-subtle font-mono">{s.userId}</div>
                      )}
                    </td>
                    <td>
                      <div className="font-medium text-fg">#{s.problemId}</div>
                      <div className="text-meta text-fg-muted line-clamp-1">{s.problemTitle}</div>
                    </td>
                    <td>
                      <Badge tone={getVerdictTone(Number(s.result))}>{s.resultLabel}</Badge>
                    </td>
                    <td className="font-mono text-meta">{s.time} ms</td>
                    <td className="font-mono text-meta">{s.memory} KB</td>
                    <td className="text-meta">{s.languageName}</td>
                    <td className="font-mono text-meta">{s.codeLength} B</td>
                    <td className="text-meta text-fg-muted whitespace-nowrap">
                      {s.inDate ? s.inDate.replace("T", " ").slice(0, 16) : "-"}
                    </td>
                    {portal === "teacher" && (
                      <td>
                        {s.sim > 0 ? (
                          <Badge tone="warn">
                            相似 {s.sim}% (#{s.simSolutionId})
                          </Badge>
                        ) : (
                          <span className="text-fg-subtle text-meta">-</span>
                        )}
                      </td>
                    )}
                    <td>
                      {s.canViewCode ? (
                        <Button variant="ghost" onClick={() => openCodeModal(s.solutionId)}>
                          查看代码
                        </Button>
                      ) : (
                        <span className="text-meta text-fg-subtle">仅本人/教师可见</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
            <span className="text-meta text-fg-muted">
              显示 {(page - 1) * limit + 1} - {Math.min(page * limit, total)} 共 {total} 条
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </Button>
              <Button
                variant="secondary"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Code Inspector Modal */}
      {activeSid !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface/80 backdrop-blur-sm p-4">
          <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col rounded-card border border-line bg-surface shadow-card">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-line px-card py-inline">
              <div>
                <h3 className="text-title font-semibold text-fg">
                  提交 #{activeSid} 代码与诊断详情
                </h3>
                {codeDetail && (
                  <p className="mt-1 text-meta text-fg-muted">
                    题目: #{codeDetail.problemId} · {codeDetail.problemTitle} | 提交者:{" "}
                    {codeDetail.nick} ({codeDetail.userId})
                  </p>
                )}
              </div>
              <Button variant="ghost" onClick={closeCodeModal}>
                关闭 ✕
              </Button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-card space-y-4">
              {codeLoading ? (
                <p className="py-12 text-center text-fg-muted">正在加载源码与诊断数据…</p>
              ) : codeError ? (
                <div className="rounded-control bg-danger-soft p-4 text-danger">{codeError}</div>
              ) : codeDetail ? (
                <>
                  {/* Status Bar */}
                  <div className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-surface-muted px-4 py-2 text-meta">
                    <Badge tone={getVerdictTone(Number(codeDetail.result))}>
                      {codeDetail.resultLabel}
                    </Badge>
                    <span>语言: {codeDetail.languageName}</span>
                    <span>耗时: {codeDetail.time} ms</span>
                    <span>内存: {codeDetail.memory} KB</span>
                    <span>长度: {codeDetail.codeLength} B</span>
                    <span>
                      提交时间: {codeDetail.inDate ? codeDetail.inDate.replace("T", " ").slice(0, 19) : "-"}
                    </span>
                  </div>

                  {/* Plagiarism Alert */}
                  {codeDetail.sim > 0 && (
                    <div className="rounded-control border border-line bg-warn-soft p-3 text-warn">
                      <strong>查重警示：</strong>该提交与提交 #{codeDetail.simSolutionId} 文本相似度高达{" "}
                      <strong>{codeDetail.sim}%</strong>。
                    </div>
                  )}

                  {/* Compile Error */}
                  {codeDetail.compileError && (
                    <div className="rounded-control border border-line bg-danger-soft p-3 text-danger">
                      <p className="font-semibold mb-1">编译报错详情 (Compiler Diagnostics):</p>
                      <pre className="max-h-48 overflow-auto font-mono text-meta whitespace-pre-wrap">
                        {codeDetail.compileError}
                      </pre>
                    </div>
                  )}

                  {/* Runtime Error */}
                  {codeDetail.runtimeError && (
                    <div className="rounded-control border border-line bg-danger-soft p-3 text-danger">
                      <p className="font-semibold mb-1">运行时异常详情 (Runtime Diagnostics):</p>
                      <pre className="max-h-48 overflow-auto font-mono text-meta whitespace-pre-wrap">
                        {codeDetail.runtimeError}
                      </pre>
                    </div>
                  )}

                  {/* Code Viewer */}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-meta font-medium text-fg">完整源代码：</span>
                      <Button variant="secondary" onClick={handleCopyCode}>
                        {copied ? "已复制到剪贴板" : "复制代码"}
                      </Button>
                    </div>
                    <pre className="max-h-96 overflow-auto rounded-control border border-line bg-surface-muted p-4 font-mono text-meta text-fg leading-relaxed select-text">
                      {codeDetail.code}
                    </pre>
                  </div>
                </>
              ) : null}
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end border-t border-line px-card py-inline">
              <Button variant="secondary" onClick={closeCodeModal}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
