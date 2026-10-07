import { utils, write, type CellObject } from "xlsx";
import type { GradingExportRow } from "@/api/grading";

export async function createGradingReport(rows: GradingExportRow[]): Promise<Blob> {
  const values = [
    ["学号", "学生姓名", "是否提交", "是否已评分", "成绩"],
    ...rows.map(row => [row.username, row.real_name,
      row.submission_id === null ? "否" : "是", row.score === null ? "否" : "是", row.score]),
  ];
  const sheet = utils.aoa_to_sheet(values.map(row => row.map(value =>
    typeof value === "string" ? ({ t: "s", v: value, z: "@" } as CellObject) : value)));
  sheet["!cols"] = [20, 20, 16, 16, 12].map(wch => ({wch}));
  if (sheet["!ref"]) sheet["!autofilter"] = { ref: sheet["!ref"] };
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "成绩汇总");
  return new Blob([write(workbook, {bookType: "xlsx", type: "array"})],
    {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
