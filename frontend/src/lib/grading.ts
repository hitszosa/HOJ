export type WeightedProblem = { score?: number; required?: boolean; passed?: boolean };

export function gradingWeight(problem: WeightedProblem): number {
  return problem.required === false ? 0 : problem.score ?? 100;
}

export function weightedGrade(problems: WeightedProblem[]): number {
  const total = problems.reduce((n, p) => n + gradingWeight(p), 0);
  const passed = problems.reduce((n, p) => n + (p.passed ? gradingWeight(p) : 0), 0);
  return total > 0 ? Math.round(passed / total * 10000) / 100 : 0;
}

export function weightShare(problem: WeightedProblem, problems: WeightedProblem[]): number {
  const total = problems.reduce((n, p) => n + gradingWeight(p), 0);
  return total > 0 ? Math.round(gradingWeight(problem) / total * 10000) / 100 : 0;
}
