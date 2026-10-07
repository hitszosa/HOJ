import { read, utils, type WorkBook } from "xlsx";

export interface RosterUser {
  username: string;
  real_name: string;
  role: number;
  password_expired: boolean;
}

const text = (value: unknown) => String(value ?? "").replace(/^\uFEFF/, "").trim();

export function parseRosterWorkbook(workbook: WorkBook) {
  const candidates = workbook.SheetNames.map((sheetName) => {
    const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1, raw: false, defval: "", blankrows: true,
    });
    const headerRow = rows.findIndex((row) => row.some((cell) => text(cell)));
    const headers = (rows[headerRow] ?? []).map(text);
    return { sheetName, rows, headerRow, headers };
  }).filter(({ headers }) => (headers.includes("学号") || headers.includes("用户名")) && headers.includes("姓名"));
  const preferred = candidates.find(({ sheetName }) => ["学生名单", "用户导入表"].includes(sheetName));
  if (!candidates.length) throw new Error("表头不正确：第一行请填写“学号、姓名”，也兼容“用户名、姓名、角色”。");
  if (!preferred && candidates.length > 1) throw new Error("多个工作表都包含名单，请只保留一个名单表，或将要导入的表命名为“学生名单”。");
  const { sheetName, rows, headerRow, headers } = preferred ?? candidates[0];
  if (headers.filter((h) => ["学号", "用户名"].includes(h)).length !== 1 || headers.filter((h) => h === "姓名").length !== 1 || headers.filter((h) => h === "角色").length > 1) {
    throw new Error("表头重复或含义不明确：只保留一个“学号”（或“用户名”）列、一个“姓名”列。");
  }
  const idColumn = headers.findIndex((h) => h === "学号" || h === "用户名");
  const nameColumn = headers.indexOf("姓名");
  const roleColumn = headers.indexOf("角色");
  const users: RosterUser[] = [];
  const seen = new Map<string, { user: RosterUser; row: number }>();
  let skippedDuplicates = 0;
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some((cell) => text(cell))) continue;
    const username = text(row[idColumn]);
    const real_name = text(row[nameColumn]);
    const roleText = roleColumn < 0 ? "学生" : text(row[roleColumn]) || "学生";
    const at = `第 ${i + 1} 行：`;
    if (!/^[\p{L}\p{N}_@.-]{1,150}$/u.test(username)) throw new Error(`${at}学号/用户名不能为空，最多 150 个字符，只能包含字母、数字、_、@、.、-。学号请设为文本格式。`);
    if (!real_name || real_name.length > 1000) throw new Error(`${at}姓名不能为空，且不能超过 1000 个字符。`);
    if (!["学生", "教师"].includes(roleText)) throw new Error(`${at}角色只能填写“学生”或“教师”；不填则默认为学生。`);
    const user = { username, real_name, role: roleText === "教师" ? 1 : 0, password_expired: true };
    const previous = seen.get(username);
    if (previous) {
      if (previous.user.real_name !== real_name || previous.user.role !== user.role) throw new Error(`${at}学号/用户名 ${username} 与第 ${previous.row} 行的信息冲突，请核对。`);
      skippedDuplicates++;
      continue;
    }
    seen.set(username, { user, row: i + 1 });
    users.push(user);
  }
  if (!users.length) throw new Error("表格内容为空，请在表头下填写学号和姓名。");
  return { users, sheetName, skippedDuplicates };
}

export function parseRosterFile(data: ArrayBuffer, filename: string) {
  let workbook: WorkBook;
  try {
    workbook = read(data, { type: "array", ...(filename.toLowerCase().endsWith(".csv") ? { codepage: 65001 } : {}) });
  } catch {
    throw new Error("文件无法读取，请上传未加密的 Excel 表格，或 UTF-8 编码的 CSV 文件。");
  }
  return parseRosterWorkbook(workbook);
}
