import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JudgeDetailView } from "@/components/JudgeDetailView";

describe("JudgeDetailView 组件", () => {
  it("能将 HOJ 节点测试结果表格渲染为结构化节点表格", () => {
    const tableText = `filename|size|result|memory|time
--|--|--|--|--
1.in|610|AC|2328k|7ms
2.in|99112|AC|2328k|24ms
3.in|99130|AC|2328k|11ms
4.in|10|AC|2328k|5ms
5.in|99141|AC|2328k|10ms`;

    const { container } = render(<JudgeDetailView error={{ error: tableText }} />);
    expect(screen.getByText("节点测试点评测详情")).toBeDefined();
    expect(screen.getByText("通过 5 / 5")).toBeDefined();

    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(5);

    const acBadges = container.querySelectorAll("tbody span");
    expect(acBadges.length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText("7ms")).toBeDefined();
    expect(screen.getByText("24ms")).toBeDefined();
  });

  it("能渲染带 WA / TLE 判定标签的测试点评测表格", () => {
    const tableText = `filename|size|result|memory|time
--|--|--|--|--
1.in|100|AC|2000k|5ms
2.in|200|WA|2000k|6ms
3.in|300|TLE|2000k|1005ms`;

    const { container } = render(<JudgeDetailView error={tableText} />);
    expect(screen.getByText("通过 1 / 3")).toBeDefined();
    expect(screen.getByText("WA 答案错误")).toBeDefined();
    expect(screen.getByText("TLE 运行超时")).toBeDefined();
  });

  it("能渲染纯编译错误信息", () => {
    const ce = `Main.cpp:5:10: error: 'x' was not declared in this scope`;
    render(<JudgeDetailView error={{ error: ce }} />);
    expect(screen.getByText("编译 / 运行错误信息")).toBeDefined();
    expect(screen.getByText(/was not declared/)).toBeDefined();
  });

  it("空内容时不渲染", () => {
    const { container } = render(<JudgeDetailView error={null} />);
    expect(container.firstChild).toBeNull();
  });
});
