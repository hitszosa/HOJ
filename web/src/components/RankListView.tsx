"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardTitle, Empty, Progress, Stat } from "@/components/ui";
import { api } from "@/lib/api";

type Row = Record<string, any>;

const fieldClass =
  "w-full rounded-control border border-line bg-surface px-3 py-2 text-body text-fg focus:outline-none focus:ring-2 focus:ring-brand";

export function RankListView({
  portal,
  user,
  offeringId: propOfferingId,
  embedded = false,
}: {
  portal: string;
  user: string;
  offeringId?: string | number;
  embedded?: boolean;
}) {
  const [rankings, setRankings] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [myRank, setMyRank] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const limit = 50;

  const [offeringId, setOfferingId] = useState(propOfferingId ? String(propOfferingId) : "");
  const [offerings, setOfferings] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (propOfferingId) {
      setOfferingId(String(propOfferingId));
    }
  }, [propOfferingId]);

  // Load teacher offerings
  useEffect(() => {
    if (portal === "teacher") {
      setLoading(true);
      api("/courses")
        .then((data: Row[]) => {
          const list = data.filter((r) => ["teacher", "ta"].includes(r.role));
          setOfferings(list);
          if (!propOfferingId && typeof window !== "undefined") {
            const oid = new URLSearchParams(window.location.search).get("oid");
            if (oid) setOfferingId(oid);
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [portal, propOfferingId]);

  const loadRanklist = useCallback(async () => {
    // 教学班天梯榜归属于具体班级，禁止作为公共天梯查询
    if (portal === "teacher" && !offeringId) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(limit));
      params.set("limit", String(limit));
      if (offeringId) params.set("offeringId", offeringId);

      const res = await api(`/ranklist?${params.toString()}`);
      setRankings(res.items || res.rankings || []);
      setTotal(res.total || 0);
      setMyRank(res.myRank || null);
    } catch (e) {
      setError(String(e).split("|").pop() || "加载排名榜失败");
    } finally {
      setLoading(false);
    }
  }, [page, limit, offeringId, portal]);

  useEffect(() => {
    if (portal !== "teacher" || offeringId) {
      loadRanklist();
    }
  }, [loadRanklist, portal, offeringId]);

  const totalPages = Math.ceil(total / limit) || 1;

  // 教师未选定班级时，展示选班引导卡片，进入班级内部查看天梯榜
  if (portal === "teacher" && !offeringId && !embedded) {
    return (
      <div className="space-y-6">
        <header className="border-b border-line pb-4">
          <p className="eyebrow">ACADEMIC LADDER</p>
          <h1 className="text-3xl font-semibold tracking-tight">教学班学业进展天梯榜</h1>
          <p className="mt-2 text-fg-muted">
            天梯榜属于班级内部学情数据，需选定具体班级查看。请选择您执教的班级进入：
          </p>
        </header>

        {loading ? (
          <p role="status" className="py-12 text-center text-fg-muted">正在加载执教班级列表…</p>
        ) : offerings.length === 0 ? (
          <Empty title="暂无执教班级" hint="您当前没有正在进行的教学班，无法查看班级天梯榜。" />
        ) : (
          <div className="grid gap-stack md:grid-cols-2">
            {offerings.map((o, idx) => (
              <Card key={o.offering_id}>
                <div className="flex items-center justify-between">
                  <span className="course-number">{String(idx + 1).padStart(2, "0")}</span>
                  <Badge tone={o.status === "archived" ? "neutral" : "brand"}>
                    {o.status === "archived" ? "已归档" : "进行中"}
                  </Badge>
                </div>
                <p className="mt-3 text-meta text-fg-muted">
                  {o.code ? `${o.code} · ` : ""}{o.term} · {o.section} 班
                </p>
                <h2 className="mt-1 text-xl font-semibold text-fg">{o.title || o.name}</h2>
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <Link
                    className="inline-flex items-center gap-1 rounded-control bg-brand px-4 py-2 text-meta font-medium text-brand-fg hover:opacity-90"
                    href={`/teacher/courses/${o.offering_id}?tab=ranklist`}
                  >
                    🏆 进入班级天梯榜 →
                  </Link>
                  <Link
                    className="inline-flex items-center gap-1 rounded-control border border-line px-4 py-2 text-meta text-fg hover:bg-surface-muted"
                    href={`/teacher/courses/${o.offering_id}`}
                  >
                    班级作业
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div>
            <h3 className="text-base font-semibold text-fg flex items-center gap-2">
              <span>🏆 班级学业天梯榜</span>
              <span className="rounded-full bg-brand/10 text-brand px-2 py-0.5 text-xs font-mono">
                {total} 位在册同学
              </span>
            </h3>
            <p className="text-xs text-fg-muted mt-0.5">
              仅统计本班在册学生的实际代码提交、AC题目数与通过率表现。
            </p>
          </div>
          <Button variant="secondary" onClick={loadRanklist} disabled={loading}>
            {loading ? "刷新中…" : "刷新排名"}
          </Button>
        </div>
      ) : (
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">ACADEMIC LADDER</p>
            <h1 className="text-3xl font-semibold tracking-tight">
              {portal === "teacher" ? "教学班学业进展天梯榜" : "全校编程天梯榜"}
            </h1>
            <p className="mt-2 text-fg-muted">
              {portal === "teacher"
                ? "天梯榜仅聚合当前班级在册学生的解题积累与练习进展。"
                : "切磋练习、稳步提升。展示全站同学通过题目数与提交通过率排行。"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={loadRanklist} disabled={loading}>
              {loading ? "刷新中…" : "刷新排名"}
            </Button>
          </div>
        </header>
      )}

      {/* Stats row */}
      <div className="grid gap-stack sm:grid-cols-3">
        <Stat label="本班上榜人数" value={total} unit="人" />
        {portal === "student" && (
          <Stat
            label="我的班级排名"
            value={myRank ? `第 ${myRank} 名` : "未入榜"}
            tone={myRank ? "brand" : "neutral"}
          />
        )}
        <Stat
          label="班级最高解题数"
          value={rankings[0]?.solved ?? 0}
          unit="题"
          tone="ok"
        />
        {portal === "teacher" && (
          <Stat
            label="统计范围"
            value="当前教学班"
            tone="brand"
          />
        )}
      </div>

      {/* Teacher class switcher (hidden if embedded) */}
      {!embedded && portal === "teacher" && offerings.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="w-full sm:w-80">
              <label className="block text-meta text-fg-muted mb-1">切换当前教学班</label>
              <select
                className={fieldClass}
                value={offeringId}
                onChange={(e) => {
                  if (e.target.value) {
                    setOfferingId(e.target.value);
                    setPage(1);
                  }
                }}
              >
                {offerings.map((o) => (
                  <option key={o.offering_id} value={o.offering_id}>
                    {o.title} ({o.term} · {o.section}班)
                  </option>
                ))}
              </select>
            </div>
            <p className="text-meta text-fg-muted max-w-md">
              天梯榜仅统计所选班级在册学生的作业与解题表现，非全校公开榜单。
            </p>
          </div>
        </Card>
      )}

      {/* Leaderboard Table */}
      <Card>
        <CardTitle
          title={`天梯排行 (共 ${total} 位同学)`}
          meta={`按通过题目数（降序）及提交通过率综合排序 · 第 ${page} / ${totalPages} 页`}
        />

        {error ? (
          <div className="py-4 text-center text-danger">{error}</div>
        ) : rankings.length === 0 ? (
          <Empty title="暂无排名记录" hint="提交并正确通过题目后，将自动计入排名榜。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left zebra">
              <thead>
                <tr>
                  <th className="py-3">名次</th>
                  <th>学生</th>
                  <th>AC 解题数</th>
                  <th>总提交数</th>
                  <th className="w-44">通过率</th>
                  <th>最近提交时间</th>
                  {portal === "teacher" && <th>教学跟进</th>}
                </tr>
              </thead>
              <tbody>
                {rankings.map((r) => {
                  const isMe = r.userId === user;
                  return (
                    <tr
                      key={r.userId}
                      className={`border-t border-line ${isMe ? "bg-brand-soft/30 font-medium" : ""}`}
                    >
                      <td className="py-3">
                        {r.rank === 1 ? (
                          <Badge tone="brand">🥇 冠军</Badge>
                        ) : r.rank === 2 ? (
                          <Badge tone="neutral">🥈 亚军</Badge>
                        ) : r.rank === 3 ? (
                          <Badge tone="warn">🥉 季军</Badge>
                        ) : (
                          <span className="font-mono text-fg-muted pl-2">{r.rank}</span>
                        )}
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-fg">{r.nick || r.userId}</span>
                          {isMe && <Badge tone="brand">我</Badge>}
                        </div>
                        {r.nick && r.nick !== r.userId && (
                          <div className="text-meta text-fg-subtle font-mono">{r.userId}</div>
                        )}
                      </td>
                      <td>
                        <span className="text-display font-semibold text-ok">{r.solved}</span>
                        <span className="text-meta text-fg-muted ml-1">题</span>
                      </td>
                      <td>
                        <span className="font-mono text-meta text-fg">{r.submit}</span>
                        <span className="text-meta text-fg-muted ml-1">次</span>
                      </td>
                      <td>
                        {(() => {
                          const passPct = r.passRate <= 1 ? Math.round(r.passRate * 100) : Math.round(r.passRate);
                          return (
                            <div className="space-y-1">
                              <div className="flex justify-between text-meta">
                                <span>{passPct}%</span>
                                <span className="text-fg-subtle">{r.solved}/{r.submit}</span>
                              </div>
                              <Progress
                                value={passPct}
                                tone={passPct > 50 ? "ok" : "brand"}
                              />
                            </div>
                          );
                        })()}
                      </td>
                      <td className="text-meta text-fg-muted whitespace-nowrap">
                        {r.lastSubmit ? r.lastSubmit.replace("T", " ").slice(0, 16) : "-"}
                      </td>
                      {portal === "teacher" && (
                        <td>
                          {r.solved === 0 ? (
                            <Badge tone="warn">未破零 · 需关注</Badge>
                          ) : r.solved >= 10 ? (
                            <Badge tone="ok">进展优秀</Badge>
                          ) : (
                            <Badge tone="neutral">正常推进</Badge>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
            <span className="text-meta text-fg-muted">
              显示 {(page - 1) * limit + 1} - {Math.min(page * limit, total)} 共 {total} 位
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
    </div>
  );
}
