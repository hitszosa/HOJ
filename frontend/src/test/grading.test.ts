import { describe, expect, it } from "vitest";
import { weightedGrade, weightShare } from "@/lib/grading";

describe("实验按 AC 题目的权重自动给分", () => {
  it("30/70 部分通过、全部通过和未提交", () => {
    expect(weightedGrade([{ score: 30, passed: true }, { score: 70 }])).toBe(30);
    expect(weightedGrade([{ score: 30 }, { score: 70, passed: true }])).toBe(70);
    expect(weightedGrade([{ score: 30, passed: true }, { score: 70, passed: true }])).toBe(100);
    expect(weightedGrade([{ score: 30 }, { score: 70 }])).toBe(0);
  });
  it("任意权重比例折算 100，结果保留两位小数", () => {
    expect(weightedGrade([{ score: 1, passed: true }, { score: 2 }])).toBe(33.33);
    const problems = [{ score: 3 }, { score: 7 }];
    expect(weightShare(problems[0], problems)).toBe(30);
  });
  it("选做和零权重题不影响计分，旧题单默认等权", () => {
    expect(weightedGrade([{ score: 30, passed: true }, { score: 70 }, { score: 1000, required: false, passed: true }, { score: 0 }])).toBe(30);
    expect(weightedGrade([{ passed: true }, {}])).toBe(50);
    expect(weightedGrade([])).toBe(0);
  });
});
