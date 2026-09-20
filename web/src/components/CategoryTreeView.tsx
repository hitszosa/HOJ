"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useMemo } from "react";
import { Badge, Button, Card, CardTitle, Empty } from "@/components/ui";
import { api } from "@/lib/api";
import * as echarts from "echarts";
import { MarkdownView } from "./MarkdownView";

type TreeNode = {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  kind: "root" | "pillar" | "group" | "leaf";
  count: number;
  tags?: string[];
  difficultyCount?: Record<string, number>;
  problems?: ProblemItem[];
  children?: TreeNode[];
};

type ProblemItem = {
  slug: string;
  title: string;
  difficulty: string;
  tags?: string[];
  knowledge?: string[];
  provenance?: string;
  statement?: string;
  samples?: { input: string; output: string }[];
};

type BasketItem = {
  setId: string;
  setName: string;
  slug: string;
  title: string;
  difficulty: string;
  knowledge?: string[];
  statement?: string;
};

function getDifficultyTone(diff: string): "ok" | "brand" | "warn" | "danger" | "neutral" {
  if (diff.startsWith("L1")) return "ok";
  if (diff.startsWith("L2")) return "brand";
  if (diff.startsWith("L3")) return "warn";
  if (diff.startsWith("L4") || diff.startsWith("L5")) return "danger";
  return "neutral";
}

const AVAILABLE_LANGUAGES = [
  { id: "c", label: "C", desc: "GCC C11" },
  { id: "cpp", label: "C++", desc: "G++ C++17" },
  { id: "java", label: "Java", desc: "OpenJDK 17" },
  { id: "python", label: "Python 3", desc: "CPython 3.10" },
];

export function CategoryTreeView({ portal, user }: { portal: "teacher" | "student" | null; user?: string }) {
  const [treeData, setTreeData] = useState<TreeNode | null>(null);
  const [totalProblems, setTotalProblems] = useState(0);
  const [totalSets, setTotalSets] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [viewMode, setViewModeState] = useState<"tree" | "echarts">("tree");
  const [graphSelectedLeaf, setGraphSelectedLeaf] = useState<{
    id: string;
    name: string;
    count: number;
  } | null>(null);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("oj_category_view_mode");
      if (saved === "echarts" || saved === "tree") {
        setViewModeState(saved);
      }
    } catch {}
  }, []);

  const setViewMode = (mode: "tree" | "echarts") => {
    setViewModeState(mode);
    try {
      sessionStorage.setItem("oj_category_view_mode", mode);
    } catch {}
  };
  const [selectedNodeId, setSelectedNodeId] = useState<string>("root");
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    new Set(["p1-basics", "p2-structures", "p3-algorithms", "p4-math", "p5-contests"])
  );
  const [treeSearch, setTreeSearch] = useState("");

  // Right-side problem filter
  const [problemSearch, setProblemSearch] = useState("");
  const [selectedDiff, setSelectedDiff] = useState<string>("ALL");
  const [expandedProblemSlug, setExpandedProblemSlug] = useState<string | null>(null);

  // Teacher Problem Basket & Multi-Class Publishing
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [teacherOfferings, setTeacherOfferings] = useState<any[]>([]);
  const [selectedOfferingIds, setSelectedOfferingIds] = useState<number[]>([]);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishTitle, setPublishTitle] = useState("");
  const [publishDueDate, setPublishDueDate] = useState("");
  const [aiEnabled, setAiEnabled] = useState(true);
  const [allowedLanguages, setAllowedLanguages] = useState<string[]>(["c", "cpp", "java", "python"]);
  const [publishResult, setPublishResult] = useState<any | null>(null);
  const [showSelectedList, setShowSelectedList] = useState(false);
  const [previewBasketSlug, setPreviewBasketSlug] = useState<string | null>(null);

  // ECharts container ref
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    let active = true;
    api("/problem-sets/tree")
      .then((res) => {
        if (!active) return;
        setTreeData(res.root);
        setTotalProblems(res.totalProblems);
        setTotalSets(res.totalSets);
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(String(e).split("|").pop() || "加载题库树失败");
        setLoading(false);
      });

    if (portal === "teacher") {
      api("/courses")
        .then((rows) => {
          if (!active) return;
          const activeTeaching = rows.filter((r: any) => r.role === "teacher" && r.status === "active");
          setTeacherOfferings(activeTeaching);
          if (activeTeaching.length > 0) {
            let presetOid: number | null = null;
            if (typeof window !== "undefined") {
              const urlParams = new URLSearchParams(window.location.search);
              const paramOid = urlParams.get("oid");
              if (paramOid) presetOid = Number(paramOid);
            }
            if (presetOid && activeTeaching.some((o: any) => o.offering_id === presetOid)) {
              setSelectedOfferingIds([presetOid]);
            } else {
              setSelectedOfferingIds(activeTeaching.map((o: any) => o.offering_id));
            }
          }
        })
        .catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [portal]);

  // Clean unmount on page navigation
  useEffect(() => {
    return () => {
      if (chartInstance.current) {
        chartInstance.current.dispose();
        chartInstance.current = null;
      }
    };
  }, []);

  // ECharts Rendering & Resizing Lifecycle
  useEffect(() => {
    if (!chartRef.current || !treeData) return;

    const container = chartRef.current;

    const renderChart = () => {
      if (!chartRef.current || !treeData) return;
      if (chartRef.current.clientWidth === 0 || chartRef.current.clientHeight === 0) return;

      let myChart = chartInstance.current;
      if (!myChart) {
        myChart = echarts.getInstanceByDom(chartRef.current) || echarts.init(chartRef.current);
        chartInstance.current = myChart;
      }

      // Transform treeData into ECharts tree format
      const formatNode = (node: TreeNode): any => {
        return {
          name: node.name,
          value: node.count,
          nodeId: node.id,
          kind: node.kind,
          children: node.children ? node.children.map(formatNode) : undefined,
        };
      };

      const echartsData = formatNode(treeData);

      const option: echarts.EChartsOption = {
        tooltip: {
          trigger: "item",
          triggerOn: "mousemove",
          formatter: (params: any) => {
            const d = params.data;
            const isLeaf = d.kind === "leaf";
            return `<div style="padding:4px"><strong style="font-size:13px">${params.name}</strong><br/><span style="font-size:12px;opacity:0.75">题目数: ${d.value || 0} 题</span>${
              isLeaf ? '<br/><span style="font-size:11px;opacity:0.9">💡 点击展开题单预览</span>' : ""
            }</div>`;
          },
        },
        series: [
          {
            type: "tree",
            data: [echartsData],
            top: "4%",
            left: "9%",
            bottom: "4%",
            right: "22%",
            symbol: "emptyCircle",
            symbolSize: 8,
            initialTreeDepth: 2,
            roam: true,
            label: {
              position: "left",
              verticalAlign: "middle",
              align: "right",
              fontSize: 12,
            },
            leaves: {
              label: {
                position: "right",
                verticalAlign: "middle",
                align: "left",
              },
            },
            emphasis: {
              focus: "descendant",
            },
            expandAndCollapse: true,
            animationDuration: 400,
            animationDurationUpdate: 500,
          },
        ],
      };

      myChart.setOption(option);

      myChart.off("click");
      myChart.on("click", (params: any) => {
        if (params.data && params.data.nodeId) {
          if (params.data.kind === "leaf") {
            setSelectedNodeId(params.data.nodeId);
            setGraphSelectedLeaf({
              id: params.data.nodeId,
              name: params.data.name,
              count: params.data.value || 0,
            });
          }
        }
      });
    };

    renderChart();

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          if (!chartInstance.current) {
            renderChart();
          } else {
            chartInstance.current.resize();
          }
        }
      }
    });

    ro.observe(container);

    const handleResize = () => {
      if (chartInstance.current) {
        chartInstance.current.resize();
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [treeData]);

  // When viewMode toggles to "echarts", resize chart smoothly
  useEffect(() => {
    if (viewMode === "echarts") {
      const raf = requestAnimationFrame(() => {
        if (chartInstance.current) {
          chartInstance.current.resize();
        }
      });
      const timer = setTimeout(() => {
        if (chartInstance.current) {
          chartInstance.current.resize();
        }
      }, 60);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
  }, [viewMode]);

  // Find currently selected node
  const selectedNode = useMemo(() => {
    if (!treeData) return null;
    if (selectedNodeId === "root") return treeData;

    const find = (node: TreeNode): TreeNode | null => {
      if (node.id === selectedNodeId) return node;
      if (node.children) {
        for (const child of node.children) {
          const res = find(child);
          if (res) return res;
        }
      }
      return null;
    };
    return find(treeData) || treeData;
  }, [treeData, selectedNodeId]);

  // Aggregate all problems under the currently selected node
  const allNodeProblems = useMemo(() => {
    if (!selectedNode) return [];
    const problems: (ProblemItem & { parentSetTitle: string; parentSetId: string })[] = [];

    const collect = (node: TreeNode) => {
      if (node.kind === "leaf" && node.problems) {
        for (const p of node.problems) {
          problems.push({
            ...p,
            parentSetTitle: node.name,
            parentSetId: node.id,
          });
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collect(child);
        }
      }
    };

    collect(selectedNode);
    return problems;
  }, [selectedNode]);

  // Filter problems by keyword and difficulty
  const filteredProblems = useMemo(() => {
    return allNodeProblems.filter((p) => {
      if (selectedDiff !== "ALL" && !p.difficulty.startsWith(selectedDiff)) {
        return false;
      }
      if (problemSearch.trim()) {
        const q = problemSearch.toLowerCase().trim();
        const inTitle = p.title.toLowerCase().includes(q);
        const inSlug = p.slug.toLowerCase().includes(q);
        const inStmt = (p.statement || "").toLowerCase().includes(q);
        const inTags = (p.tags || []).some((t) => t.toLowerCase().includes(q));
        if (!inTitle && !inSlug && !inStmt && !inTags) return false;
      }
      return true;
    });
  }, [allNodeProblems, selectedDiff, problemSearch]);

  const toggleExpand = (id: string) => {
    const next = new Set(expandedNodes);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedNodes(next);
  };

  const expandAll = () => {
    if (!treeData) return;
    const allIds = new Set<string>();
    const collect = (node: TreeNode) => {
      allIds.add(node.id);
      if (node.children) node.children.forEach(collect);
    };
    collect(treeData);
    setExpandedNodes(allIds);
  };

  const collapseAll = () => {
    setExpandedNodes(new Set());
  };

  // Toggle problem basket
  const handleToggleBasket = (p: ProblemItem & { parentSetTitle: string; parentSetId: string }) => {
    const exists = basket.some((b) => b.slug === p.slug);
    if (exists) {
      setBasket(basket.filter((b) => b.slug !== p.slug));
    } else {
      if (basket.length >= 100) {
        alert("选题篮最多可容纳 100 道题目");
        return;
      }
      setBasket([
        ...basket,
        {
          setId: p.parentSetId,
          setName: p.parentSetTitle,
          slug: p.slug,
          title: p.title,
          difficulty: p.difficulty,
          knowledge: p.tags || p.knowledge,
          statement: p.statement,
        },
      ]);
    }
  };

  // Open Publish Modal
  const openPublishModal = () => {
    if (basket.length === 0) return;
    const uniqueSets = Array.from(new Set(basket.map((b) => b.setName)));
    const defaultTitle =
      uniqueSets.length === 1
        ? `题单 · ${uniqueSets[0]} (${basket.length} 题)`
        : `跨知识分类程序设计训练 (${basket.length} 题)`;
    setPublishTitle(defaultTitle);
    setPublishResult(null);
    setAllowedLanguages(["c", "cpp", "java", "python"]);
    setShowPublishModal(true);
  };

  // Publish or save draft for selected offerings
  const handlePublishToOfferings = async (action: "publish" | "draft") => {
    if (selectedOfferingIds.length === 0) {
      alert("请至少勾选一个发布的教学班级");
      return;
    }
    if (allowedLanguages.length === 0) {
      alert("请至少勾选一种允许提交的编程语言");
      return;
    }
    setPublishing(true);
    try {
      const res = await api("/problem-sets/publish-to-offerings", "POST", {
        items: basket.map((b) => ({ setId: b.setId, slug: b.slug })),
        offeringIds: selectedOfferingIds,
        title: publishTitle.trim() || undefined,
        dueAt: publishDueDate.trim() || undefined,
        aiEnabled,
        allowedLanguages,
        action,
      });
      setPublishResult(res);
      setBasket([]);
    } catch (e: any) {
      alert(
        (action === "publish" ? "发布作业失败: " : "创建草稿失败: ") +
          (String(e).split("|").pop() || "未知错误")
      );
    } finally {
      setPublishing(false);
    }
  };

  if (loading) {
    return (
      <div className="py-20 text-center text-fg-muted">
        <p className="text-lg">正在加载算法题库分类体系与知识图谱…</p>
      </div>
    );
  }

  if (error || !treeData) {
    return (
      <div className="py-20 text-center">
        <Empty title="知识图谱加载失败" hint={error || "未找到题库分类树数据"} />
      </div>
    );
  }

  return (
    <div className={`space-y-6 ${basket.length > 0 ? "pb-28" : ""}`}>
      {/* Header Banner */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">
              KNOWLEDGE TAXONOMY
            </span>
            <span className="text-meta text-fg-muted">
              {totalProblems} 道核心试题 · {totalSets} 份题单 · 5 大算法支柱
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">
            OJ 算法题库分类体系与知识图谱
          </h1>
          <p className="mt-1 text-meta text-fg-muted">
            全面覆盖程序设计入门、核心数据结构、进阶算法模型、数论专项与高校竞赛真题，支持多级折叠检索与选题组合。
          </p>
        </div>

        {/* View Mode Switcher */}
        <div className="flex items-center gap-1 rounded-control border border-line bg-surface p-1 shadow-sm">
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-control px-3 py-1.5 text-xs font-medium transition ${
              viewMode === "tree"
                ? "bg-brand text-brand-fg shadow"
                : "text-fg-muted hover:text-fg hover:bg-surface-muted"
            }`}
            onClick={() => setViewMode("tree")}
          >
            <span>🌲 折叠树状目录与题目流</span>
          </button>
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-control px-3 py-1.5 text-xs font-medium transition ${
              viewMode === "echarts"
                ? "bg-brand text-brand-fg shadow"
                : "text-fg-muted hover:text-fg hover:bg-surface-muted"
            }`}
            onClick={() => setViewMode("echarts")}
          >
            <span>🗺️ 全景知识图谱 (ECharts)</span>
          </button>
        </div>
      </header>

      {/* Mode 2: ECharts Full Graph View */}
      <div className={viewMode === "echarts" ? "block" : "hidden"}>
        <Card className="relative p-0 overflow-hidden">
          <div className="border-b border-line bg-surface-muted px-4 py-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-fg flex items-center gap-2">
              <span>🗺️ 全景算法分类思维导图</span>
              <span className="text-xs text-fg-muted font-normal">
                (鼠标拖拽平移，滚轮缩放画布；点击圆圈节点展开/折叠分支；点击末级分类可在底部快速查看)
              </span>
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                if (chartInstance.current) {
                  chartInstance.current.dispatchAction({
                    type: "restore",
                  });
                }
              }}
            >
              重置视角
            </Button>
          </div>
          <div ref={chartRef} className="h-[680px] w-full bg-surface-muted" />

          {/* Floating Leaf Node Inspector inside Mindmap */}
          {graphSelectedLeaf && (
            <div className="absolute bottom-4 left-4 right-4 md:right-auto md:w-96 z-10 flex items-center justify-between gap-3 rounded-control border border-line bg-surface p-3 shadow-lg">
              <div className="min-w-0 space-y-0.5">
                <div className="text-xs font-semibold text-brand">已选分类题单</div>
                <div className="truncate text-sm font-bold text-fg">{graphSelectedLeaf.name}</div>
                <div className="text-xs text-fg-muted">包含 {graphSelectedLeaf.count} 道题目</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    setSelectedNodeId(graphSelectedLeaf.id);
                    setViewMode("tree");
                  }}
                >
                  查看试题 →
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setGraphSelectedLeaf(null)}
                >
                  ✕
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Mode 1: Interactive Collapsible Tree & Problem Flow (Split Pane) */}
      <div className={viewMode === "tree" ? "block" : "hidden"}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left Column: Collapsible Multi-tier Tree */}
          <aside className="lg:col-span-4 space-y-4">
            <Card className="sticky top-6">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-fg">知识分类目录</span>
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-mono text-fg-muted">
                    {totalSets}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-xs text-brand hover:underline"
                    onClick={expandAll}
                  >
                    全部展开
                  </button>
                  <span className="text-xs text-fg-muted">|</span>
                  <button
                    type="button"
                    className="text-xs text-fg-muted hover:underline"
                    onClick={collapseAll}
                  >
                    全部折叠
                  </button>
                </div>
              </div>

              {/* Tree Quick Search */}
              <div className="mt-3">
                <input
                  type="text"
                  placeholder="过滤知识点/题单名称…"
                  className="w-full rounded-control border border-line bg-surface px-3 py-1.5 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-brand"
                  value={treeSearch}
                  onChange={(e) => setTreeSearch(e.target.value)}
                />
              </div>

              {/* Tree Hierarchy Render */}
              <div className="mt-3 max-h-[600px] overflow-y-auto space-y-1 pr-1 text-sm">
                {/* Root item */}
                <button
                  type="button"
                  className={`w-full flex items-center justify-between rounded-control px-2.5 py-1.5 text-left transition ${
                    selectedNodeId === "root"
                      ? "bg-brand/10 font-semibold text-brand"
                      : "text-fg hover:bg-surface-muted"
                  }`}
                  onClick={() => setSelectedNodeId("root")}
                >
                  <span className="flex items-center gap-2">
                    <span>🎓</span>
                    <span>全部题库全景</span>
                  </span>
                  <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-xs font-mono text-fg-muted">
                    {totalProblems}
                  </span>
                </button>

                {/* Pillars */}
                {treeData.children?.map((pillar) => {
                  const isPillarExpanded = expandedNodes.has(pillar.id) || !!treeSearch;
                  const isPillarSelected = selectedNodeId === pillar.id;

                  const matchesSearch =
                    !treeSearch ||
                    pillar.name.toLowerCase().includes(treeSearch.toLowerCase()) ||
                    pillar.children?.some(
                      (g) =>
                        g.name.toLowerCase().includes(treeSearch.toLowerCase()) ||
                        g.children?.some((l) => l.name.toLowerCase().includes(treeSearch.toLowerCase()))
                    );

                  if (!matchesSearch) return null;

                  return (
                    <div key={pillar.id} className="space-y-0.5">
                      <div
                        className={`flex items-center justify-between rounded-control px-2 py-1.5 cursor-pointer transition ${
                          isPillarSelected
                            ? "bg-brand/10 font-semibold text-brand"
                            : "text-fg hover:bg-surface-muted"
                        }`}
                        onClick={() => setSelectedNodeId(pillar.id)}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <button
                            type="button"
                            className="p-0.5 text-fg-muted hover:text-fg"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpand(pillar.id);
                            }}
                          >
                            <span className="inline-block w-4 text-center font-mono text-xs">
                              {isPillarExpanded ? "▼" : "▶"}
                            </span>
                          </button>
                          <span>{pillar.icon}</span>
                          <span className="truncate font-medium">{pillar.name}</span>
                        </div>
                        <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-xs font-mono text-fg-muted shrink-0">
                          {pillar.count}
                        </span>
                      </div>

                      {/* Pillar Groups */}
                      {isPillarExpanded && (
                        <div className="ml-5 border-l border-line pl-2 space-y-0.5">
                          {pillar.children?.map((grp) => {
                            const isGrpExpanded = expandedNodes.has(grp.id) || !!treeSearch;
                            const isGrpSelected = selectedNodeId === grp.id;

                            const grpMatches =
                              !treeSearch ||
                              grp.name.toLowerCase().includes(treeSearch.toLowerCase()) ||
                              grp.children?.some((l) =>
                                l.name.toLowerCase().includes(treeSearch.toLowerCase())
                              );

                            if (!grpMatches) return null;

                            return (
                              <div key={grp.id} className="space-y-0.5">
                                <div
                                  className={`flex items-center justify-between rounded-control px-2 py-1 cursor-pointer text-xs transition ${
                                    isGrpSelected
                                      ? "bg-brand/10 font-semibold text-brand"
                                      : "text-fg-muted hover:text-fg hover:bg-surface-muted"
                                  }`}
                                  onClick={() => setSelectedNodeId(grp.id)}
                                >
                                  <div className="flex items-center gap-1 min-w-0">
                                    <button
                                      type="button"
                                      className="p-0.5 text-fg-muted hover:text-fg"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleExpand(grp.id);
                                      }}
                                    >
                                      <span className="inline-block w-3 text-center font-mono text-[10px]">
                                        {isGrpExpanded ? "▼" : "▶"}
                                      </span>
                                    </button>
                                    <span className="truncate">{grp.name}</span>
                                  </div>
                                  <span className="text-[11px] font-mono text-fg-muted shrink-0">
                                    {grp.count}
                                  </span>
                                </div>

                                {/* Leaf Problem Sets */}
                                {isGrpExpanded && (
                                  <div className="ml-4 border-l border-line pl-2 space-y-0.5">
                                    {grp.children?.map((leaf) => {
                                      const isLeafSelected = selectedNodeId === leaf.id;
                                      const leafMatches =
                                        !treeSearch ||
                                        leaf.name.toLowerCase().includes(treeSearch.toLowerCase());
                                      if (!leafMatches) return null;

                                      return (
                                        <button
                                          key={leaf.id}
                                          type="button"
                                          className={`w-full flex items-center justify-between rounded-control px-2 py-1 text-left text-xs transition ${
                                            isLeafSelected
                                              ? "bg-brand text-brand-fg font-medium shadow-sm"
                                              : "text-fg-muted hover:text-fg hover:bg-surface-muted"
                                          }`}
                                          onClick={() => setSelectedNodeId(leaf.id)}
                                        >
                                          <span className="truncate">{leaf.name}</span>
                                          <span
                                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-mono shrink-0 ${
                                              isLeafSelected
                                                ? "bg-brand-fg/20 text-brand-fg"
                                                : "bg-surface-muted text-fg-muted"
                                            }`}
                                          >
                                            {leaf.count}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          </aside>

          {/* Right Column: Problem Stream & Preview */}
          <main className="lg:col-span-8 space-y-4">
            {/* Breadcrumb & Filter Header */}
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
                <div className="space-y-0.5">
                  <span className="text-xs font-semibold uppercase tracking-wider text-brand">
                    当前分类节点
                  </span>
                  <h2 className="text-lg font-semibold text-fg flex items-center gap-2">
                    <span>{selectedNode?.icon || "📁"}</span>
                    <span>{selectedNode?.name || "全部题目"}</span>
                    <span className="rounded-full bg-brand/10 text-brand px-2 py-0.5 text-xs font-mono">
                      {allNodeProblems.length} 道题目
                    </span>
                  </h2>
                </div>

                {/* Difficulty Filter */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {["ALL", "L1", "L2", "L3", "L4", "L5"].map((diff) => (
                    <button
                      key={diff}
                      type="button"
                      className={`rounded-control px-2.5 py-1 text-xs font-medium transition ${
                        selectedDiff === diff
                          ? "bg-brand text-brand-fg shadow-sm"
                          : "bg-surface-muted text-fg-muted hover:text-fg"
                      }`}
                      onClick={() => setSelectedDiff(diff)}
                    >
                      {diff === "ALL" ? "全部难度" : diff}
                    </button>
                  ))}
                </div>
              </div>

              {/* Problem Keyword Search */}
              <div className="mt-3">
                <input
                  type="text"
                  placeholder="在此节点中搜索题目编号、标题、题面关键字或标签…"
                  className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand"
                  value={problemSearch}
                  onChange={(e) => setProblemSearch(e.target.value)}
                />
              </div>
            </Card>

            {/* Problem Cards List */}
            <div className="space-y-3">
              {filteredProblems.length === 0 ? (
                <Card>
                  <Empty
                    title="未找到匹配试题"
                    hint="尝试调整难度过滤标签或清空搜索关键词。"
                  />
                </Card>
              ) : (
                filteredProblems.map((prob, idx) => {
                  const isExpanded = expandedProblemSlug === prob.slug;
                  const inBasket = basket.some((b) => b.slug === prob.slug);
                  const tone = getDifficultyTone(prob.difficulty || "L1");

                  return (
                    <Card
                      key={prob.slug}
                      className={`transition-all ${
                        isExpanded ? "ring-2 ring-brand" : "hover:border-line"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div
                          className="flex-1 cursor-pointer"
                          onClick={() =>
                            setExpandedProblemSlug(isExpanded ? null : prob.slug)
                          }
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-fg-muted">
                              #{idx + 1}
                            </span>
                            <Badge tone={tone}>
                              {prob.difficulty || "L1-入门"}
                            </Badge>
                            <h3 className="text-base font-semibold text-fg hover:text-brand transition">
                              {prob.title}
                            </h3>
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                            <span className="rounded-control bg-surface-muted px-1.5 py-0.5 text-fg-muted">
                              {prob.parentSetTitle}
                            </span>
                            {prob.provenance && (
                              <span className="rounded-control bg-surface-muted px-1.5 py-0.5 text-fg-muted">
                                来源: {prob.provenance}
                              </span>
                            )}
                            {(prob.tags || []).slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                className="rounded-control bg-surface-muted px-1.5 py-0.5 text-fg-muted"
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                          {portal === "teacher" && (
                            <button
                              type="button"
                              className={`rounded-control px-3 py-1.5 text-xs font-medium transition ${
                                inBasket
                                  ? "bg-brand text-brand-fg"
                                  : "border border-line bg-surface text-fg hover:border-brand hover:text-brand"
                              }`}
                              onClick={() => handleToggleBasket(prob)}
                            >
                              {inBasket ? "✓ 已在选题篮" : "+ 加入选题篮"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg"
                            onClick={() =>
                              setExpandedProblemSlug(isExpanded ? null : prob.slug)
                            }
                          >
                            {isExpanded ? "收起题面 ▲" : "查看题面 ▼"}
                          </button>
                        </div>
                      </div>

                      {/* Expanded Problem Statement & Samples Preview */}
                      {isExpanded && (
                        <div className="mt-4 border-t border-line pt-4 space-y-4">
                          <div>
                            <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1.5">
                              题目描述
                            </h4>
                            <div className="rounded-control bg-surface-muted p-3.5 border border-line">
                              <MarkdownView
                                content={prob.statement}
                                placeholder="暂无题面详细描述"
                              />
                            </div>
                          </div>

                          {prob.samples && prob.samples.length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wider">
                                示例数据 (公开样例)
                              </h4>
                              <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-3">
                                {prob.samples.map((s, sIdx) => (
                                  <div
                                    key={sIdx}
                                    className="rounded-control border border-line bg-surface p-2 text-xs"
                                  >
                                    <div className="mb-1 font-semibold text-fg-muted">
                                      样例 #{sIdx + 1}
                                    </div>
                                    <div className="space-y-1">
                                      <div>
                                        <span className="text-fg-muted font-mono">输入:</span>
                                        <pre className="mt-0.5 overflow-x-auto rounded-control bg-surface-muted p-1.5 font-mono text-fg border border-line">
                                          {s.input || "<空输入>"}
                                        </pre>
                                      </div>
                                      <div>
                                        <span className="text-fg-muted font-mono">输出:</span>
                                        <pre className="mt-0.5 overflow-x-auto rounded-control bg-surface-muted p-1.5 font-mono text-fg border border-line">
                                          {s.output || "<空输出>"}
                                        </pre>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })
              )}
            </div>
          </main>
        </div>
      </div>

      {/* Floating Teacher Problem Basket Bar */}
      {portal === "teacher" && basket.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t-2 border-brand bg-surface shadow-2xl transition-all">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-3.5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-base font-bold text-brand-fg">
                {basket.length}
              </span>
              <div>
                <h4 className="text-sm font-semibold text-fg">
                  已选入组题篮 ({basket.length} 道题目)
                </h4>
                <p className="text-xs text-fg-muted">
                  已汇集跨分类试题，点击右侧直接布置并选择要发布到的教学班级。
                </p>
              </div>
            </div>

            {/* Quick Pills for Basket */}
            <div className="hidden md:flex flex-wrap items-center gap-1.5 max-w-md overflow-hidden max-h-12">
              {basket.slice(0, 4).map((b) => (
                <span
                  key={b.slug}
                  className="inline-flex items-center gap-1 rounded-control bg-surface-muted px-2 py-0.5 text-xs text-fg"
                >
                  <span className="truncate max-w-[120px]">{b.title}</span>
                  <button
                    type="button"
                    className="text-fg-muted hover:text-fg"
                    onClick={() => setBasket((prev) => prev.filter((x) => x.slug !== b.slug))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {basket.length > 4 && (
                <span className="text-xs text-fg-muted font-mono">
                  +{basket.length - 4} 题
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button variant="secondary" onClick={() => setBasket([])}>
                清空选题
              </Button>

              <Button
                variant="primary"
                onClick={openPublishModal}
              >
                🚀 布置到班级 / 生成题单 →
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Multi-Class Publishing Modal */}
      {showPublishModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-4 backdrop-blur-sm">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            {publishResult ? (
              <div className="space-y-5 py-4">
                <div className="text-center space-y-2">
                  <div className="text-4xl">🎉</div>
                  <h3 className="text-xl font-bold text-fg">
                    {publishResult.action === "publish" ? "作业已成功发布！" : "作业草稿已创建！"}
                  </h3>
                  <p className="text-sm text-fg-muted">
                    已成功向 {publishResult.offeringCount} 个教学班分发了《{publishResult.title}》，共包含 {publishResult.problemCount} 道题目。
                  </p>
                </div>

                <div className="space-y-2 rounded-control border border-line bg-surface-muted p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                    发布班级明细
                  </h4>
                  <div className="divide-y divide-line">
                    {publishResult.results.map((r: any) => {
                      const off = teacherOfferings.find((o) => o.offering_id === r.offeringId);
                      return (
                        <div key={r.offeringId} className="flex items-center justify-between py-2 text-sm">
                          <div className="font-medium text-fg">
                            {off ? `${off.code} · ${off.name} (${off.section}班)` : `教学班 #${r.offeringId}`}
                          </div>
                          <Link
                            href={r.batchId ? `/teacher/batches/${r.batchId}` : `/teacher/courses/${r.offeringId}`}
                            className="text-xs text-brand hover:underline font-medium"
                          >
                            前往班级查看 →
                          </Link>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setShowPublishModal(false);
                      setPublishResult(null);
                    }}
                  >
                    完成
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex items-start justify-between border-b border-line pb-3">
                  <div>
                    <h3 className="text-lg font-bold text-fg">🚀 布置作业到教学班级</h3>
                    <p className="text-xs text-fg-muted mt-0.5">
                      从知识图谱精选了 {basket.length} 道试题，请设定题单信息并勾选要发布的授课班级。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-fg-muted hover:text-fg text-lg p-1"
                    onClick={() => setShowPublishModal(false)}
                  >
                    ✕
                  </button>
                </div>

                {/* Form Fields */}
                <div className="space-y-4">
                  {/* Selected Problems Collapsible Preview with Markdown */}
                  <div className="rounded-control border border-line bg-surface-muted p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-fg">
                          已选题目清单 ({basket.length} 题)
                        </span>
                        <span className="text-[11px] text-fg-muted hidden sm:inline">
                          可核对题目描述与难度
                        </span>
                      </div>
                      <button
                        type="button"
                        className="text-xs text-brand hover:underline font-medium"
                        onClick={() => setShowSelectedList(!showSelectedList)}
                      >
                        {showSelectedList ? "收起清单 ▲" : "查看清单与题干 ▼"}
                      </button>
                    </div>

                    {showSelectedList && (
                      <div className="mt-3 max-h-64 overflow-y-auto space-y-2 border-t border-line pt-2.5">
                        {basket.map((b, idx) => {
                          const isExpanded = previewBasketSlug === b.slug;
                          return (
                            <div
                              key={b.slug}
                              className="rounded-control border border-line bg-surface p-2.5 text-xs"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-mono text-fg-muted">#{idx + 1}</span>
                                  <span className="font-medium text-fg truncate">{b.title}</span>
                                  <span className="text-fg-muted font-mono text-[10px] hidden sm:inline">{b.slug}</span>
                                  <Badge tone={getDifficultyTone(b.difficulty)}>{b.difficulty}</Badge>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    type="button"
                                    className="text-brand hover:underline"
                                    onClick={() => setPreviewBasketSlug(isExpanded ? null : b.slug)}
                                  >
                                    {isExpanded ? "收起题干 ▲" : "预览题干 ▼"}
                                  </button>
                                  <button
                                    type="button"
                                    className="text-fg-muted hover:text-danger px-1"
                                    title="移除本题"
                                    onClick={() => {
                                      const next = basket.filter((x) => x.slug !== b.slug);
                                      setBasket(next);
                                      if (next.length === 0) setShowPublishModal(false);
                                    }}
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                              {isExpanded && (
                                <div className="mt-2.5 rounded-control bg-surface-muted p-3 border border-line">
                                  <MarkdownView content={b.statement} placeholder="暂无题面详细描述" />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-fg mb-1">
                      题单标题 <span className="text-brand">*</span>
                    </label>
                    <input
                      type="text"
                      className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand"
                      value={publishTitle}
                      onChange={(e) => setPublishTitle(e.target.value)}
                      placeholder="输入作业题单名称…"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-fg mb-1">
                      截止提交时间 (可选)
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="datetime-local"
                        className="rounded-control border border-line bg-surface px-3 py-1.5 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-brand"
                        value={publishDueDate}
                        onChange={(e) => setPublishDueDate(e.target.value)}
                      />
                      <button
                        type="button"
                        className="rounded-control border border-line bg-surface px-2 py-1 text-xs text-fg-muted hover:text-fg"
                        onClick={() => {
                          const d = new Date(Date.now() + 7 * 86400000);
                          setPublishDueDate(d.toISOString().slice(0, 16));
                        }}
                      >
                        1周后
                      </button>
                      <button
                        type="button"
                        className="rounded-control border border-line bg-surface px-2 py-1 text-xs text-fg-muted hover:text-fg"
                        onClick={() => {
                          const d = new Date(Date.now() + 14 * 86400000);
                          setPublishDueDate(d.toISOString().slice(0, 16));
                        }}
                      >
                        2周后
                      </button>
                      {publishDueDate && (
                        <button
                          type="button"
                          className="text-xs text-fg-muted hover:underline"
                          onClick={() => setPublishDueDate("")}
                        >
                          清除时间
                        </button>
                      )}
                    </div>
                  </div>

                  {/* AI Support Toggle */}
                  <div className="flex items-center gap-2 rounded-control border border-line bg-surface-muted p-3">
                    <input
                      type="checkbox"
                      id="ai-toggle"
                      className="h-4 w-4 rounded border-line text-brand focus:ring-brand"
                      checked={aiEnabled}
                      onChange={(e) => setAiEnabled(e.target.checked)}
                    />
                    <label htmlFor="ai-toggle" className="text-xs text-fg cursor-pointer select-none">
                      <span className="font-semibold">开启 AI 智能编程辅学</span>
                      <span className="text-fg-muted ml-1.5">
                        (自动为提交错误或遇到阻碍的学生提供渐进式代码分析与修复指引)
                      </span>
                    </label>
                  </div>

                  {/* Allowed Languages Section */}
                  <div className="space-y-2 rounded-control border border-line bg-surface-muted p-3">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-semibold text-fg">
                        允许提交的编程语言 <span className="text-brand">*</span>
                      </label>
                      <div className="flex items-center gap-1.5 text-xs">
                        <button
                          type="button"
                          className="text-brand hover:underline"
                          onClick={() => setAllowedLanguages(["c", "cpp", "java", "python"])}
                        >
                          全部允许
                        </button>
                        <span className="text-fg-muted">|</span>
                        <button
                          type="button"
                          className="text-brand hover:underline"
                          onClick={() => setAllowedLanguages(["c", "cpp"])}
                        >
                          仅 C/C++
                        </button>
                        <span className="text-fg-muted">|</span>
                        <button
                          type="button"
                          className="text-brand hover:underline"
                          onClick={() => setAllowedLanguages(["python"])}
                        >
                          仅 Python
                        </button>
                        <span className="text-fg-muted">|</span>
                        <button
                          type="button"
                          className="text-brand hover:underline"
                          onClick={() => setAllowedLanguages(["java"])}
                        >
                          仅 Java
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-fg-muted">
                      限制学生在本次作业中可选择的编程语言，未勾选的语言将禁止提交或自测。
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 pt-1">
                      {AVAILABLE_LANGUAGES.map((lang) => {
                        const checked = allowedLanguages.includes(lang.id);
                        return (
                          <label
                            key={lang.id}
                            className={`flex items-center gap-2 rounded-control border p-2 text-xs cursor-pointer transition ${
                              checked
                                ? "border-brand bg-brand/10 text-brand font-semibold shadow-xs"
                                : "border-line bg-surface text-fg-muted hover:border-fg-muted"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-line text-brand focus:ring-brand"
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setAllowedLanguages([...allowedLanguages, lang.id]);
                                } else {
                                  if (allowedLanguages.length <= 1) {
                                    alert("至少需要保留一种允许提交的编程语言");
                                    return;
                                  }
                                  setAllowedLanguages(allowedLanguages.filter((l) => l !== lang.id));
                                }
                              }}
                            />
                            <div>
                              <span className="text-fg font-medium">{lang.label}</span>
                              <span className="block text-[10px] text-fg-muted font-normal">{lang.desc}</span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Select Classes / Offerings */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-semibold text-fg">
                        选择发布的教学班级 <span className="text-brand">*</span>
                      </label>
                      <div className="flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          className="text-brand hover:underline"
                          onClick={() =>
                            setSelectedOfferingIds(teacherOfferings.map((o) => o.offering_id))
                          }
                        >
                          全选
                        </button>
                        <span className="text-fg-muted">|</span>
                        <button
                          type="button"
                          className="text-fg-muted hover:underline"
                          onClick={() => setSelectedOfferingIds([])}
                        >
                          清空
                        </button>
                      </div>
                    </div>

                    {teacherOfferings.length === 0 ? (
                      <p className="text-xs text-fg-muted">未找到您当前执教的活跃教学班。</p>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {teacherOfferings.map((off) => {
                          const isChecked = selectedOfferingIds.includes(off.offering_id);
                          return (
                            <label
                              key={off.offering_id}
                              className={`flex items-start gap-2.5 rounded-control border p-2.5 text-xs cursor-pointer transition ${
                                isChecked
                                  ? "border-brand bg-brand/5 text-fg font-medium"
                                  : "border-line bg-surface text-fg-muted hover:border-line"
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="mt-0.5 h-3.5 w-3.5 rounded border-line text-brand focus:ring-brand"
                                checked={isChecked}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedOfferingIds((prev) => [...prev, off.offering_id]);
                                  } else {
                                    setSelectedOfferingIds((prev) =>
                                      prev.filter((id) => id !== off.offering_id)
                                    );
                                  }
                                }}
                              />
                              <div className="min-w-0">
                                <div className="truncate font-semibold text-fg">
                                  {off.code} · {off.name}
                                </div>
                                <div className="text-meta text-fg-muted">
                                  {off.section}班 · {off.term}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="text-right text-xs text-fg-muted">
                      已选中 <strong className="text-brand">{selectedOfferingIds.length}</strong> 个班级
                    </div>
                  </div>
                </div>

                {/* Modal Actions */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <Button variant="secondary" onClick={() => setShowPublishModal(false)}>
                    取消
                  </Button>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      disabled={publishing || selectedOfferingIds.length === 0}
                      onClick={() => handlePublishToOfferings("draft")}
                    >
                      {publishing ? "正在保存…" : "📝 生成班级草稿"}
                    </Button>

                    <Button
                      variant="primary"
                      disabled={publishing || selectedOfferingIds.length === 0}
                      onClick={() => handlePublishToOfferings("publish")}
                    >
                      {publishing ? "正在发布…" : "🚀 立即发布到所选班级"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
