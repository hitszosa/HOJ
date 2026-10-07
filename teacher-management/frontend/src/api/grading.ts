import { instance as api } from "./axiosInstance";

export interface GradingExportRow {
  user_id: number;
  username: string;
  real_name: string;
  submission_id: number | null;
  score: number | null;
}
export const ApiGradingReport = (assignment: number) =>
  api.get<GradingExportRow[]>(`/api/assignments/${assignment}/grading/report`);
